/**
 * 用音频文件测试语音识别（无需界面和麦克风）
 * 复用 lib/asr.js 与 lib/lexicon.js，按应用相同的 4096 采样分块喂入
 *
 * 用法：node scripts/asr-file-test.js <音频文件>  （wav/m4a/mp3 等，需要 ffmpeg-static）
 */

const { execFileSync } = require('child_process');
const { initASR, feedAudio, stopRecognition } = require('../lib/asr');
const { loadLexicon, analyzeText } = require('../lib/lexicon');

const CHUNK = 4096; // 与 src/app.js 中 createScriptProcessor(4096) 一致
const WATCH_WORDS = ['嗯', '呃', '啊', '额', '哦', '唉', '那个', '这个', '就是', '然后', '对吧'];

function decodeToFloat32(file) {
  const ffmpeg = require('ffmpeg-static');
  const buf = execFileSync(ffmpeg, [
    '-v', 'error', '-i', file, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'
  ], { maxBuffer: 1 << 30 });
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

function countWords(text) {
  return WATCH_WORDS
    .map(w => [w, text.split(w).length - 1])
    .filter(([, n]) => n > 0)
    .map(([w, n]) => `${w}×${n}`)
    .join('  ') || '（无）';
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node scripts/asr-file-test.js <音频文件>');
    process.exit(1);
  }

  const samples = decodeToFloat32(file);
  console.log(`音频时长：${(samples.length / 16000).toFixed(1)} 秒`);

  loadLexicon();
  await initASR();

  const finals = [];
  for (let i = 0; i < samples.length; i += CHUNK) {
    const result = feedAudio(samples.subarray(i, i + CHUNK));
    if (result && result.isFinal) finals.push(result.text);
  }
  const tail = stopRecognition();

  const kept = finals.join('');
  console.log('\n—— 分句结果（应用会写入原文）——');
  finals.forEach((s, i) => console.log(`${i + 1}. ${s}`));
  console.log(`\n—— 停止时未断句的尾段（当前应用会丢弃）——\n${tail || '（无）'}`);

  const full = kept + tail;
  console.log(`\n—— 语气词/口头禅字面出现次数（含尾段）——\n${countWords(full)}`);

  // 与应用一致：逐句分析后累加
  const results = [...finals, tail].map(s => analyzeText(s)).filter(Boolean);
  const pick = key => results.flatMap(r => r[key]).map(x => x.word);
  console.log('\n—— 应用词库统计（含尾段）——');
  for (const [label, key] of [['填充词', 'fillers'], ['犹豫词', 'hedges'], ['笼统词', 'vagueWords']]) {
    const words = pick(key);
    console.log(`${label} ${words.length}：${words.join('、')}`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
