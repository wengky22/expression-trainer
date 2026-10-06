/**
 * 按停顿切分录音：离线识别前把整段录音切成一句一句，切点都落在静音里
 *
 * 每 30ms 一帧算能量；以全段能量分布定阈值（底噪取 5% 分位，语音取 95% 分位），
 * 进入语音用高阈值、回到静音用低阈值，句尾轻下去的字不会被当成静音切掉。
 * 整段几乎没有高低起伏（一直在说话，找不出静音）时整段送去识别，宁可不切也不丢内容；
 * 整段都低于 SILENT_DB 时认为没有声音。
 * 低于低阈值连续 pause 秒算一次停顿；每段前后各留最多 margin 秒（不越过与相邻段的中点），
 * 超过 maxLen 秒的段在中间三分之一里最安静的 0.3 秒处再切开。
 */

const FRAME_SEC = 0.03;
const SILENT_DB = -60;    // 95% 的帧都低于它：没有声音
const MIN_RANGE_DB = 10;  // 语音和底噪至少差这么多，才按停顿切

function frameLevels(samples, frame) {
  const db = [];
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let energy = 0;
    for (let j = i; j < i + frame; j++) energy += samples[j] * samples[j];
    db.push(10 * Math.log10(energy / frame + 1e-10));
  }
  return db;
}

function percentile(sorted, p) {
  return sorted[Math.floor(p * (sorted.length - 1))];
}

// 过长的段在中间三分之一里找最安静的窗口切开，递归直到都不超过 maxFrames
function splitLong([a, b], db, maxFrames, out) {
  if (b - a <= maxFrames) {
    out.push([a, b]);
    return;
  }
  const win = Math.round(0.3 / FRAME_SEC);
  const third = Math.floor((b - a) / 3);
  let best = a + Math.floor((b - a) / 2);
  let bestSum = Infinity;
  for (let k = a + third; k + win <= b - third; k++) {
    let sum = 0;
    for (let j = k; j < k + win; j++) sum += db[j];
    if (sum < bestSum) {
      bestSum = sum;
      best = k + Math.floor(win / 2);
    }
  }
  splitLong([a, best], db, maxFrames, out);
  splitLong([best, b], db, maxFrames, out);
}

/**
 * @param {Float32Array} samples - 单声道采样
 * @param {number} sampleRate
 * @returns {Array<{speechStart: number, from: number, to: number}>} 单位秒：
 *          speechStart 是这段语音开始的时刻，[from, to) 是送去识别的范围（含前后留白）
 */
function findSpeechSegments(samples, sampleRate, { pause = 1.0, maxLen = 20, margin = 1.0 } = {}) {
  const frame = Math.round(FRAME_SEC * sampleRate);
  const db = frameLevels(samples, frame);
  if (!db.length) return [];

  const sorted = [...db].sort((x, y) => x - y);
  const floor = percentile(sorted, 0.05);
  const top = percentile(sorted, 0.95);
  if (top < SILENT_DB) return [];
  const range = top - floor;
  const high = floor + Math.max(6, 0.3 * range);
  const low = floor + Math.max(4, 0.15 * range);
  const pauseFrames = Math.round(pause / FRAME_SEC);

  const regions = [];
  if (range < MIN_RANGE_DB) {
    regions.push([0, db.length]);
  } else {
    let start = -1;
    let last = -1;
    db.forEach((d, k) => {
      if (start < 0) {
        if (d > high) start = last = k;
        return;
      }
      if (d > low) last = k;
      if (k - last >= pauseFrames) {
        regions.push([start, last + 1]);
        start = -1;
      }
    });
    if (start >= 0) regions.push([start, last + 1]);
  }

  const split = [];
  const maxFrames = Math.round(maxLen / FRAME_SEC);
  for (const r of regions) splitLong(r, db, maxFrames, split);

  const duration = samples.length / sampleRate;
  const sec = k => k * frame / sampleRate;
  return split.map(([a, b], i) => {
    const prevEnd = i ? sec(split[i - 1][1]) : 0;
    const nextStart = i + 1 < split.length ? sec(split[i + 1][0]) : duration;
    return {
      speechStart: sec(a),
      from: Math.max(sec(a) - margin, (prevEnd + sec(a)) / 2),
      to: Math.min(sec(b) + margin, (sec(b) + nextStart) / 2),
    };
  });
}

module.exports = { findSpeechSegments };
