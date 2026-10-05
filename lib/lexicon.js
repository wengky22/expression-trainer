/**
 * 词库匹配模块
 * 加载情感词库JSON，分析文本中的情绪词、填充词、犹豫词
 */

const fs = require('fs');
const path = require('path');

let lexiconData = null;

// 填充词列表（语气词/口头禅）
const FILLER_WORDS = [
  '嗯', '啊', '呃', '额', '那个', '就是', '然后',
  '这个', '对吧', '是吧', '你知道', '怎么说呢',
  '反正', '基本上', '总之', '所以说'
];

// 犹豫词列表（弱化表达）
const HEDGE_WORDS = [
  '可能', '也许', '大概', '应该', '我觉得', '好像',
  '似乎', '或许', '不一定', '差不多', '算是',
  '某种程度上', '一般来说', '感觉'
];

// 笼统词 → 精准替代映射
// 不收单字动词（想/做/看/说）：几乎每句话都有，逐个提示只会是噪音
const VAGUE_TO_PRECISE = {
  '开心': ['欣喜', '雀跃', '兴奋', '欣慰', '畅快', '满足'],
  '难过': ['心酸', '失落', '委屈', '心疼', '沮丧', '低落'],
  '害怕': ['恐惧', '焦虑', '不安', '慌张', '胆怯', '忐忑'],
  '生气': ['愤怒', '恼火', '窝火', '气愤', '不满', '暴躁'],
  '不舒服': ['压抑', '烦躁', '憋屈', '窒息', '煎熬', '疲惫'],
  '很好': ['出色', '精彩', '优秀', '惊艳', '完美', '理想'],
  '很多': ['大量', '海量', '充裕', '丰富', '密集', '可观'],
  '很快': ['迅速', '飞速', '立刻', '瞬间', '即刻', '火速'],
  '很大': ['巨大', '庞大', '显著', '惊人', '可观', '壮观'],
  '很小': ['微小', '细微', '轻微', '渺小', '微不足道', '些许'],
  '好看': ['精致', '优雅', '绚丽', '惊艳', '别致', '夺目'],
  '不好': ['糟糕', '恶劣', '拙劣', '不堪', '惨淡', '低劣'],
  '喜欢': ['热爱', '痴迷', '着迷', '钟爱', '倾心', '沉醉'],
  '讨厌': ['厌恶', '反感', '排斥', '憎恨', '鄙视', '嫌弃'],
  '觉得': ['认为', '判断', '确信', '推断', '意识到', '发现'],
  '想想': ['反思', '回顾', '审视', '复盘', '琢磨', '斟酌']
};

// ===== 上下文规则：同一个词在不同语境下不一定是口头禅/犹豫 =====

// 「这个/那个/就是」大多是正常的指代和判断（"这个方案""问题就是锁太大"），
// 只有重复、结巴、紧挨其他填充词，或「就是」开头时才算口头禅
const CONTEXT_FILLERS = new Set(['这个', '那个', '就是']);
const HESITATIONS = new Set(['嗯', '啊', '呃', '额']);
// 「就是」前面是这些字时是判断用法：这就是、也就是、不就是……
const JIUSHI_PREFIX = '这那也不正都还可便只倒算';
// 单字「额」组成的词：额外、额度、金额、名额……
const E_NEXT = '外度定头';
const E_PREV = '金名余总份差数限超定配前面税全巨高票满';
// 「应该」后接这些字或在句末时是推测；"应该先/应该要/应该把"表示该做什么，不算犹豫
const YINGGAI_HEDGE_NEXT = '是会能可没不算还有就也在已挺比很都吧';

const charIn = (chars, ch) => !!ch && chars.includes(ch);
const isBoundary = ch => !ch || /[\s，。！？、；：,.!?;:…]/.test(ch);

/**
 * 加载词库
 */
function loadLexicon() {
  const lexiconPath = path.join(__dirname, '..', 'data', 'emotion-lexicon.json');

  if (fs.existsSync(lexiconPath)) {
    const raw = fs.readFileSync(lexiconPath, 'utf-8');
    lexiconData = JSON.parse(raw);
    console.log(`[词库] 加载完成，共 ${Object.keys(lexiconData.emotions || {}).length} 个情绪词`);
  } else {
    console.warn('[词库] emotion-lexicon.json 未找到，使用内置词表');
    lexiconData = { emotions: {} };
  }
}

function getEmotions() {
  return (lexiconData && lexiconData.emotions) || {};
}

/**
 * 按最长正向匹配找出所有词库词
 * @returns {Array<{word: string, start: number, end: number}>} start/end 为字符下标
 */
function findTokens(text) {
  const dict = new Set([
    ...FILLER_WORDS,
    ...HEDGE_WORDS,
    ...Object.keys(VAGUE_TO_PRECISE),
    ...Object.keys(getEmotions())
  ]);
  const maxLen = Math.max(...[...dict].map(w => w.length));

  const tokens = [];
  let i = 0;
  while (i < text.length) {
    let len = Math.min(maxLen, text.length - i);
    while (len > 0 && !dict.has(text.substring(i, i + len))) len--;
    if (len > 0) {
      tokens.push({ word: text.substring(i, i + len), start: i, end: i + len });
      i += len;
    } else {
      i++;
    }
  }
  return tokens;
}

/**
 * 不依赖上下文的填充词（嗯/呃/然后…），单字「额」排除"额外/金额"等
 */
function isPlainFiller({ word, start, end }, text) {
  if (!FILLER_WORDS.includes(word) || CONTEXT_FILLERS.has(word)) return false;
  if (word === '额') return !charIn(E_NEXT, text[end]) && !charIn(E_PREV, text[start - 1]);
  return true;
}

/**
 * 「这个/那个/就是」是否作口头禅用
 */
function isContextFiller(tokens, idx, plain, text) {
  const { word, start, end } = tokens[idx];
  const prev = tokens[idx - 1];
  const next = tokens[idx + 1];

  // 重复：这个这个、就是就是（一串重复只算前面的）
  if (next && next.start === end && next.word === word) return true;
  if (word === '就是' && charIn(JIUSHI_PREFIX, text[start - 1])) return false;
  // 结巴：这个这工具、那个那……
  if (word !== '就是' && charIn('这那', text[end])) return true;
  // 「就是」开头：就是我觉得……
  if (word === '就是' && (start === 0 || isBoundary(text[start - 1]))) return true;
  // 紧挨其他填充词：嗯那个、然后就是（「这个/那个」只认语气词，"然后这个项目"是正常指代）
  const neighborOk = i => plain[i] && (word === '就是' || HESITATIONS.has(tokens[i].word));
  return (!!prev && prev.end === start && neighborOk(idx - 1)) ||
         (!!next && next.start === end && neighborOk(idx + 1));
}

/**
 * 犹豫词是否真的表示不确定
 */
function isHedge({ word, end }, text) {
  const next = text[end];
  if (word === '应该') return isBoundary(next) || charIn(YINGGAI_HEDGE_NEXT, next);
  if (word === '可能' && next === '性') return false;
  return true;
}

/**
 * 字数：汉字逐个计，英文单词/数字串各计 1
 */
function countWords(text) {
  return (text.match(/[一-鿿]|[A-Za-z0-9]+/g) || []).length;
}

/**
 * 分析文本
 * @param {string} text - 输入文本（实时模式为一句 ASR 断句，粘贴模式为一句话）
 * @returns {Object} 分析结果；position、spans 均为字符下标，spans 供字幕高亮使用
 */
function analyzeText(text) {
  if (!text || !text.trim()) {
    return null;
  }

  const tokens = findTokens(text);
  const plain = tokens.map(t => isPlainFiller(t, text));
  const emotions = getEmotions();

  const fillers = [];
  const hedges = [];
  const vagueWords = [];
  const emotionWords = [];
  const spans = [];

  tokens.forEach((tok, idx) => {
    const { word, start, end } = tok;

    if (FILLER_WORDS.includes(word)) {
      const isFiller = CONTEXT_FILLERS.has(word) ? isContextFiller(tokens, idx, plain, text) : plain[idx];
      if (isFiller) {
        fillers.push({ word, position: start });
        spans.push({ start, end, type: 'filler' });
      }
    } else if (HEDGE_WORDS.includes(word)) {
      if (isHedge(tok, text)) {
        hedges.push({ word, position: start });
        spans.push({ start, end, type: 'hedge' });
      }
    } else if (VAGUE_TO_PRECISE[word]) {
      vagueWords.push({ word, position: start, alternatives: VAGUE_TO_PRECISE[word] });
      spans.push({ start, end, type: 'vague' });
    }

    if (emotions[word]) {
      emotionWords.push({ word, position: start, ...emotions[word] });
    }
  });

  // 表达密度：去掉填充词、犹豫词后剩余字数的占比
  const totalWords = countWords(text);
  const noiseChars = [...fillers, ...hedges].reduce((n, item) => n + item.word.length, 0);
  const density = totalWords > 0 ? Math.max(0, (totalWords - noiseChars) / totalWords) : 1;

  return {
    totalWords,
    noiseChars,
    fillers,
    hedges,
    vagueWords,
    emotionWords,
    spans,
    density: Math.round(density * 100),
    suggestions: generateSuggestions(vagueWords, fillers, hedges)
  };
}

/**
 * 生成替代建议
 */
function generateSuggestions(vagueWords, fillers, hedges) {
  const suggestions = [];

  // 笼统词替代
  vagueWords.forEach(item => {
    suggestions.push({
      type: 'vague',
      original: item.word,
      alternatives: item.alternatives.slice(0, 3),
      message: `「${item.word}」→ 试试更精准的：${item.alternatives.slice(0, 3).join('、')}`
    });
  });

  // 填充词提醒
  if (fillers.length >= 3) {
    const topFillers = [...new Set(fillers.map(f => f.word))].slice(0, 3);
    suggestions.push({
      type: 'filler',
      message: `填充词偏多（${fillers.length}次）：${topFillers.join('、')}。试试用停顿替代`
    });
  }

  // 犹豫词提醒
  if (hedges.length >= 2) {
    suggestions.push({
      type: 'hedge',
      message: `犹豫表达较多（${hedges.length}次）。试试把「我觉得」改成直接陈述`
    });
  }

  return suggestions;
}

module.exports = { loadLexicon, analyzeText, countWords, VAGUE_TO_PRECISE, FILLER_WORDS, HEDGE_WORDS };
