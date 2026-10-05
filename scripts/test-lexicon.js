/**
 * 词库规则回归测试：node scripts/test-lexicon.js
 * 每条用例写明期望命中的填充词/犹豫词/笼统词（按出现顺序）
 */

const { loadLexicon, analyzeText } = require('../lib/lexicon');

const CASES = [
  // 正常指代/判断，不算口头禅
  { text: '这就是我们要解决的问题', fillers: [] },
  { text: '这个方案的想法是先做压测再看结果', fillers: [], vague: [] },
  { text: '我希望这个项目能够识别我的表达能力', fillers: [], vague: [] },
  { text: '说明一下额外的开销', fillers: [], vague: [] },
  { text: '第二个就是说有没有办法优化', fillers: [] },
  { text: '也就是说锁的粒度太大', fillers: [] },
  { text: '然后这个项目要上线了', fillers: ['然后'] },
  { text: '所以说这个方案不行', fillers: ['所以说'] },
  // 口头禅：重复、结巴、紧挨其他填充词、「就是」开头
  { text: '嗯那个然后就是我觉得可能还行吧', fillers: ['嗯', '那个', '然后', '就是'], hedges: ['我觉得', '可能'] },
  { text: '能够这个模型或者这个这工具', fillers: ['这个'] },
  { text: '这个这个方案不行', fillers: ['这个'] },
  { text: '最后一个就是就是我希望', fillers: ['就是'] },
  { text: '就是我觉得这样不行', fillers: ['就是'], hedges: ['我觉得'] },
  { text: '金额不对，额，再算一下', fillers: ['额'] },
  // 「应该」：推测算犹豫，"该做什么"不算
  { text: '我们应该先把锁的粒度降下来', hedges: [] },
  { text: '应该是有时候会卡住', hedges: ['应该'] },
  { text: '这个项目应该要最终的效果应该是是一', fillers: [], hedges: ['应该'] },
  { text: '这种可能性很小', hedges: [], vague: ['很小'] },
  // 字数：汉字逐个计，英文单词计 1
  { text: 'hello 这是一个测试', totalWords: 7 },
];

loadLexicon();

let failed = 0;
for (const c of CASES) {
  const r = analyzeText(c.text);
  const got = {
    fillers: r.fillers.map(x => x.word),
    hedges: r.hedges.map(x => x.word),
    vague: r.vagueWords.map(x => x.word),
    totalWords: r.totalWords,
  };
  const errors = Object.keys(got)
    .filter(k => k in c && JSON.stringify(got[k]) !== JSON.stringify(c[k]))
    .map(k => `${k} 期望 ${JSON.stringify(c[k])} 实际 ${JSON.stringify(got[k])}`);

  // 高亮区间必须与命中的词一一对应
  const spanWords = r.spans.map(s => c.text.slice(s.start, s.end));
  const hitWords = [...r.fillers, ...r.hedges, ...r.vagueWords].sort((a, b) => a.position - b.position).map(x => x.word);
  if (JSON.stringify(spanWords) !== JSON.stringify(hitWords)) errors.push(`spans ${JSON.stringify(spanWords)} 与命中词不一致`);

  if (errors.length) {
    failed++;
    console.log(`✗ ${c.text}\n    ${errors.join('\n    ')}`);
  } else {
    console.log(`✓ ${c.text}`);
  }
}

console.log(`\n${CASES.length - failed}/${CASES.length} 通过`);
process.exit(failed ? 1 : 0);
