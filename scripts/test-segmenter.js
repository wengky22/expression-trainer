/**
 * 按停顿切分回归测试：node scripts/test-segmenter.js
 * 用合成信号（底噪 + 不同长度的「语音」段）检查切点、留白和长段再切
 */

const assert = require('assert');
const { findSpeechSegments } = require('../lib/segmenter');

const SR = 16000;

// parts: [[秒数, 振幅], ...]，振幅 0 表示只有底噪；「语音」用 220Hz 正弦代替
function signal(parts, noise = 0.001) {
  const total = parts.reduce((n, [sec]) => n + Math.round(sec * SR), 0);
  const x = new Float32Array(total);
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let i = 0;
  for (const [sec, amp] of parts) {
    for (let n = 0; n < Math.round(sec * SR); n++, i++) {
      x[i] = noise * rand() + amp * Math.sin(2 * Math.PI * 220 * i / SR);
    }
  }
  return x;
}

const NO_MERGE = { minLen: 0 };  // 只看切点时关掉短段合并

const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${what}：${actual.toFixed(2)}，应接近 ${expected}`);

const CASES = [
  ['长停顿切开，短停顿不切', () => {
    // 1s 静 | 2s 声 | 0.5s 静 | 1s 声 | 2s 静 | 1.5s 声 | 1s 静
    const segs = findSpeechSegments(signal([[1, 0], [2, 0.3], [0.5, 0], [1, 0.3], [2, 0], [1.5, 0.3], [1, 0]]), SR, NO_MERGE);
    assert.strictEqual(segs.length, 2, JSON.stringify(segs));
    near(segs[0].speechStart, 1, 0.05, '第一段开始');
    near(segs[1].speechStart, 6.5, 0.05, '第二段开始');
  }],
  ['前后留白最多 1 秒，且不越过两段中点', () => {
    const segs = findSpeechSegments(signal([[3, 0], [1, 0.3], [1.2, 0], [1, 0.3], [3, 0]]), SR, NO_MERGE);
    assert.strictEqual(segs.length, 2, JSON.stringify(segs));
    near(segs[0].from, 2, 0.05, '第一段起点（语音前留 1 秒）');
    near(segs[0].to, 4.6, 0.05, '第一段终点（停顿中点）');
    near(segs[1].from, 4.6, 0.05, '第二段起点（停顿中点）');
    near(segs[1].to, 7.2, 0.05, '第二段终点（语音后留 1 秒）');
  }],
  ['句尾轻下去的部分算在句子里', () => {
    // 正常音量后接一段很轻但明显高于底噪的尾音，再停顿
    const segs = findSpeechSegments(signal([[1, 0], [2, 0.3], [0.4, 0.004], [2, 0], [1, 0.3], [1, 0]]), SR, NO_MERGE);
    assert.strictEqual(segs.length, 2, JSON.stringify(segs));
    assert.ok(segs[0].to >= 3.4, `第一段终点 ${segs[0].to.toFixed(2)} 应包含 3.4 秒前的尾音`);
  }],
  ['超过上限的段在最安静处切开', () => {
    // 两段 12 秒的声音，中间只有 0.5 秒停顿（不够断句），合起来超过 20 秒
    const segs = findSpeechSegments(signal([[1, 0], [12, 0.3], [0.5, 0], [12, 0.3], [1, 0]]), SR);
    assert.strictEqual(segs.length, 2, JSON.stringify(segs));
    near(segs[1].speechStart, 13.25, 0.2, '切点在停顿中间');
    assert.ok(segs.every(s => s.to - s.from <= 22), JSON.stringify(segs));
  }],
  ['短段并到下一段，间隔太长或合并后太长时不并', () => {
    // 2s 声 | 1.5s 静 | 1s 声 | 1.5s 静 | 4s 声 | 4s 静 | 2s 声
    const segs = findSpeechSegments(signal([[1, 0], [2, 0.3], [1.5, 0], [1, 0.3], [1.5, 0], [4, 0.3], [4, 0], [2, 0.3], [1, 0]]), SR);
    assert.strictEqual(segs.length, 2, JSON.stringify(segs));
    near(segs[0].speechStart, 1, 0.05, '前三段并成一段');
    near(segs[1].speechStart, 15, 0.05, '隔了 4 秒的不并');
    const long = findSpeechSegments(signal([[1, 0], [4, 0.3], [1.5, 0], [17, 0.3], [1, 0]]), SR);
    assert.strictEqual(long.length, 2, `合并后超过 20 秒不并：${JSON.stringify(long)}`);
  }],
  ['很短的杂音不算一句话', () => {
    // 0.06 秒的咔哒声，前后都是静音
    const segs = findSpeechSegments(signal([[1, 0], [0.06, 0.3], [3, 0], [6, 0.3], [1, 0]]), SR);
    assert.strictEqual(segs.length, 1, JSON.stringify(segs));
    near(segs[0].speechStart, 4.06, 0.05, '只剩真正的语音');
  }],
  ['全是底噪、全零或空音频时不出段', () => {
    assert.deepStrictEqual(findSpeechSegments(new Float32Array(0), SR), []);
    assert.deepStrictEqual(findSpeechSegments(new Float32Array(SR * 3), SR), []);
    assert.deepStrictEqual(findSpeechSegments(signal([[3, 0]]), SR), []);
  }],
  ['停顿很少、话说得很密时也不丢内容', () => {
    // 静音只占约 3%：按分位数估底噪会落在说话声里，仍要把说话部分都送去识别
    const segs = findSpeechSegments(signal([[0.3, 0], [9, 0.3], [0.2, 0], [9, 0.3]]), SR);
    const covered = segs.reduce((n, s) => n + (s.to - s.from), 0);
    assert.ok(covered >= 18, `只送了 ${covered.toFixed(1)} 秒去识别：${JSON.stringify(segs)}`);
  }],
  ['从头到尾都在说话时整段送去识别', () => {
    const segs = findSpeechSegments(signal([[5, 0.3]]), SR);
    assert.strictEqual(segs.length, 1, JSON.stringify(segs));
    near(segs[0].from, 0, 0.05, '起点');
    near(segs[0].to, 5, 0.05, '终点');
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
