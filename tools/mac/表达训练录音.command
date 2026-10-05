#!/bin/zsh
# 表达训练一键录音（macOS）：双击运行
# 选话题（可新建、可写表达意图）→ 录音，按 s 停止 → 存进 NAS 上的话题文件夹，监视程序会自动生成报告
#
# 依赖 phiola（https://github.com/stsaz/phiola）：把 macOS 版解压到 ~/bin，得到 ~/bin/phiola-2/phiola
# 配置（可选）：~/.config/expression-trainer/mac-record.conf，shell 变量格式
#   RECORDINGS_DIR="/Volumes/<NAS>/<共享>/recordings"  录音目录；不配置时在 /Volumes 下找名为 recordings 的目录
#   NAS_URL="smb://<NAS>/<共享>"                       录音目录不在时先挂载（用钥匙串里保存的密码）
#   MIC_NAME="Wireless Mic Rx"                         优先使用的麦克风（名称包含即可）；不配置时用系统默认输入
#   PHIOLA_DIR="$HOME/bin/phiola-2"

setopt nullglob

CONF=~/.config/expression-trainer/mac-record.conf
[[ -f $CONF ]] && source $CONF
PHIOLA_DIR=${PHIOLA_DIR:-~/bin/phiola-2}
CACHE_DIR=~/Library/Caches/expression-trainer
MAX_LEN=${MAX_LEN:-30:0}   # 最长录 30 分钟，忘了停也不会一直录
TITLE="表达训练录音"
NEW_TOPIC="＋ 新建话题…"
SINGLE="单次复盘（不放进话题）"

# ---------- 对话框：osascript 从标准输入读脚本，参数原样传入，中文和引号不用转义 ----------

# choose 提示 默认项 选项…；取消时返回非 0
choose() {
  osascript - "$TITLE" "$@" 2>/dev/null <<'EOF'
on run argv
  set picked to choose from list (items 4 thru -1 of argv) with title (item 1 of argv) with prompt (item 2 of argv) default items {item 3 of argv}
  if picked is false then error number -128
  return item 1 of picked
end run
EOF
}

# ask 提示 默认值；取消时返回非 0
ask() {
  osascript - "$TITLE" "$@" 2>/dev/null <<'EOF'
on run argv
  set r to display dialog (item 2 of argv) with title (item 1 of argv) default answer (item 3 of argv) buttons {"取消", "确定"} default button "确定" cancel button "取消"
  return text returned of r
end run
EOF
}

# buttons 提示 按钮…（最后一个是默认按钮）；输出按下的按钮
buttons() {
  osascript - "$TITLE" "$@" 2>/dev/null <<'EOF'
on run argv
  set btns to items 3 thru -1 of argv
  set r to display dialog (item 2 of argv) with title (item 1 of argv) buttons btns default button (count of btns)
  return button returned of r
end run
EOF
}

die() {
  print -r -- "✗ $1"
  buttons "$1" "好" >/dev/null
  exit 1
}

# 对话框关掉后焦点不一定回到终端，按 s 停止录音需要终端在前台
focus_terminal() { open -a Terminal }

# phiola 从当前目录加载 libphiola.dylib
phiola() { (cd $PHIOLA_DIR && ./phiola "$@") }

trim() { print -r -- "$1" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' }

# ---------- 录音目录 ----------

find_recordings_dir() {
  if [[ -n ${RECORDINGS_DIR:-} ]]; then
    [[ -d $RECORDINGS_DIR ]] && print -r -- $RECORDINGS_DIR
    return
  fi
  local d
  for d in /Volumes/*/recordings(/) /Volumes/*/*/recordings(/); do
    print -r -- $d
    return
  done
}

connect_nas() {
  REC_DIR=$(find_recordings_dir)
  if [[ -z $REC_DIR && -n ${NAS_URL:-} ]]; then
    print "正在连接 NAS：$NAS_URL"
    osascript -e 'on run argv' -e 'mount volume (item 1 of argv)' -e 'end run' "$NAS_URL" >/dev/null 2>&1
    local i
    for i in {1..20}; do
      REC_DIR=$(find_recordings_dir)
      [[ -n $REC_DIR ]] && break
      sleep 1
    done
  fi
  [[ -n $REC_DIR ]] || die "找不到 NAS 上的录音目录（recordings）。请先在 Finder 里连接 NAS，或在 $CONF 里设置 RECORDINGS_DIR。"
}

# ---------- 话题和意图 ----------

# 意图文件：第一行「核心意思：…」，后面每行「- 要点」；监视程序解析时只去掉这一层前缀，
# 内容本身以 - 或编号开头也能原样读回。先写临时文件再改名，监视程序不会读到写了一半的意图
write_intent() {
  local dir=$1 core points p tmp=$1/.意图-$$.tmp
  core=$(ask $'这个话题还没有表达意图。\n\n用一句话写出这次想表达的核心意思：' "") || return 1
  core=$(trim "$core")
  [[ -n $core ]] || return 1
  points=$(ask $'要点（可选）：多个要点之间用；分隔，留空表示不写。' "") || points=""
  {
    print -r -- "核心意思：$core"
    for p in ${(f)${points//[；;]/$'\n'}}; do
      p=$(trim "$p")
      [[ -n $p ]] && print -r -- "- $p"
    done
  } > $tmp && mv $tmp "$dir/意图.txt"
}

choose_topic() {
  local topics pick name
  topics=($REC_DIR/*(/om:t))   # 子文件夹，最近改动的在前
  pick=$(choose "选择这次练习的话题：" "${topics[1]:-$NEW_TOPIC}" $topics "$NEW_TOPIC" "$SINGLE") || exit 0

  if [[ $pick == $SINGLE ]]; then
    DEST=$REC_DIR
    LABEL="单次复盘"
    return
  fi
  if [[ $pick == $NEW_TOPIC ]]; then
    name=$(ask "新话题的名称：" "") || exit 0
    name=$(trim "${name//[\/:]/-}")
    [[ -n $name ]] || die "话题名称不能为空"
    # . 开头的文件夹监视程序会跳过，「..」还会指到录音目录外面
    [[ $name != .* ]] || die "话题名称不能以 . 开头"
    [[ $name != *[[:cntrl:]]* ]] || die "话题名称里有控制字符"
    mkdir -p "$REC_DIR/$name" || die "无法创建文件夹：$REC_DIR/$name"
    pick=$name
  fi
  DEST=$REC_DIR/$pick
  LABEL="话题：$pick"

  if [[ ! -f $DEST/意图.txt && ! -f $DEST/意图.md ]]; then
    write_intent $DEST || print "⚠ 没写意图：录音会先放着，写好 意图.txt 后才会处理"
  fi
  local f
  for f in $DEST/意图.txt $DEST/意图.md; do
    [[ -f $f ]] || continue
    print "\n—— 表达意图（${f:t}）——"
    cat $f
    break
  done
}

# ---------- 录音 ----------

choose_mic() {
  DEV_ARGS=()
  [[ -n ${MIC_NAME:-} ]] || return 0
  local idx
  idx=$(phiola device list -capture 2>/dev/null | awk -F': ' -v name="$MIC_NAME" 'index($2, name) { gsub(/ /, "", $1); print $1; exit }')
  if [[ -n $idx ]]; then
    DEV_ARGS=(-dev $idx)
    return 0
  fi
  [[ $(buttons "没有找到麦克风「$MIC_NAME」，是不是没插好？" "取消" "用默认输入设备继续") == 用默认输入设备继续 ]] || exit 0
}

record_once() {
  local count stamp file size dur
  count=($DEST/*.(m4a|mp3|wav|aac|flac|ogg|opus|webm|amr|mp4)(.))
  stamp=$(date +%Y-%m-%d_%H.%M.%S)   # 文件名里不能有冒号
  file=$CACHE_DIR/$stamp.m4a
  mkdir -p $CACHE_DIR

  focus_terminal
  print "\n● 正在录音（$LABEL，第 $(( ${#count} + 1 )) 次）：说完按 s 停止，最长 ${MAX_LEN%%:*} 分钟\n"
  phiola record $DEV_ARGS -until $MAX_LEN -o $file

  [[ -s $file ]] || die "没有录到内容。请检查：系统设置 → 隐私与安全性 → 麦克风，确认「终端」已打开。"
  size=$(stat -f %z $file)
  dur=$(afinfo $file 2>/dev/null | awk '/estimated duration/ { print $3 }')
  # AAC 编码的静音每秒不到 1KB，正常说话远大于此
  if [[ -n $dur ]] && (( dur > 0 && size / dur < 3000 )); then
    if [[ $(buttons $'这段录音几乎没有声音。\n\n可能是麦克风没打开，或者「终端」没有麦克风权限（系统设置 → 隐私与安全性 → 麦克风）。' "丢弃" "仍然上传") != 仍然上传 ]]; then
      rm -f $file
      exit 1
    fi
  fi

  upload $file $size
}

# upload 本机录音 大小：存进 $DEST，文件名记在 SAVED
upload() {
  local file=$1 size=$2 stamp=${1:t:r} base n=1 taken dest tmp
  # 不覆盖已有文件：报告按去掉扩展名的文件名对应录音，同名的录音、报告、失败文件任何一个在，都换成 -2、-3…
  base=$stamp
  while taken=($DEST/$base.*); (( ${#taken} )); do
    base=$stamp-$(( ++n ))
  done
  # 先用隐藏文件名上传，传完再改名：监视程序跳过 . 开头的文件，不会处理到一半的录音
  dest=$DEST/$base.m4a
  tmp=$DEST/.上传中-$base.m4a
  print "\n上传到 NAS：$dest"
  # mv -n 不覆盖：检查之后有人抢先放了同名文件时不改名，临时文件还在，按失败处理
  if cp -X $file $tmp && mv -n $tmp $dest && [[ ! -e $tmp && $(stat -f %z $dest) == $size ]]; then
    rm -f $file
  else
    rm -f $tmp
    die "上传失败，录音保留在本机：$file"
  fi
  SAVED=$base.m4a
}

main() {
  [[ -x $PHIOLA_DIR/phiola ]] || die "找不到 phiola：请把 macOS 版解压到 ~/bin（应有 $PHIOLA_DIR/phiola）"
  connect_nas
  choose_topic
  choose_mic

  local ans
  while true; do
    record_once
    ans=$(buttons $'已保存到「'"$LABEL"$'」：'"$SAVED"$'\n\n报告大约 1 分钟后出现在同一个文件夹。' "打开文件夹" "再录一次" "完成")
    case $ans in
      再录一次) continue ;;
      打开文件夹) open $DEST ;;
    esac
    break
  done
  print "\n完成。"
}

# 被 source 时只定义函数（便于测试），直接运行时才执行
[[ $ZSH_EVAL_CONTEXT == toplevel ]] && main
