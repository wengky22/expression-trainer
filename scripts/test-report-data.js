/**
 * 报告数据表回归测试：node scripts/test-report-data.js
 */

const assert = require('assert');
const { formatStats, extractRewrite } = require('../lib/report-data');

const REPORT = `## 一句话复述
想做一个能评估表达的工具。

## 简洁改写
我想要一个工具：听我说一段话，判断听众理解的和我想说的是否一致。

## 下次练习重点
先说结论。`;

const CASES = [
  ['取出简洁改写一节', () => {
    assert.strictEqual(extractRewrite(REPORT), '我想要一个工具：听我说一段话，判断听众理解的和我想说的是否一致。');
  }],
  ['简洁改写是最后一节时取到结尾', () => {
    assert.strictEqual(extractRewrite('## 简洁改写\n只有这一句。\n'), '只有这一句。');
  }],
  ['没有简洁改写时返回空', () => {
    assert.strictEqual(extractRewrite('## 一句话复述\n无'), '');
  }],
  ['口语：语速、每分钟次数、按次数排序的明细、改写占比', () => {
    const table = formatStats({
      duration: 120, totalWords: 300, fillers: 6, hedges: 2, noiseChars: 9,
      fillerCounts: { 嗯: 1, 呃: 5 }, hedgeCounts: { 我觉得: 2 },
    }, REPORT);
    assert.ok(table.includes('| 语速 | 150 字/分钟 |'), table);
    assert.ok(table.includes('| 填充词 | 6 次，3.0 次/分钟（呃×5、嗯×1） |'), table);
    assert.ok(table.includes('| 犹豫词 | 2 次，1.0 次/分钟（我觉得×2） |'), table);
    assert.ok(table.includes('| 表达密度 | 97%'), table);
    assert.ok(/\| 简洁改写 \| 29 字，约为原文的 10% \|/.test(table), table);
  }],
  ['文字稿（时长 0）不出现时长、语速和每分钟次数', () => {
    const table = formatStats({ duration: 0, totalWords: 100, fillers: 1, hedges: 0, noiseChars: 1, fillerCounts: { 嗯: 1 }, hedgeCounts: {} }, '');
    assert.ok(!table.includes('时长') && !table.includes('语速') && !table.includes('次/分钟'), table);
    assert.ok(table.includes('| 犹豫词 | 0 次 |'), table);
  }],
];

let failed = 0;
for (const [name, fn] of CASES) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${name}\n    ${err.message.split('\n').join('\n    ')}`);
  }
}
console.log(`\n${CASES.length - failed}/${CASES.length} 通过`);
process.exit(failed ? 1 : 0);
