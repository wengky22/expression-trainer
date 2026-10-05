/**
 * 报告末尾的数据表：全部由程序统计，不经过大模型
 */

const { countWords } = require('./lexicon');

/**
 * {呃: 5, 嗯: 2} → "呃×5、嗯×2"（按次数从多到少）
 */
function formatCounts(counts) {
  return Object.entries(counts || {})
    .sort((a, b) => b[1] - a[1])
    .map(([word, n]) => `${word}×${n}`)
    .join('、');
}

/**
 * 秒 → "mm:ss"
 */
function formatTime(sec) {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 取出报告中「## 标题」一节的正文
 */
function extractSection(report, title) {
  const match = report.match(new RegExp(`^##\\s*${title}\\s*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'm'));
  return match ? match[1].trim() : '';
}

const extractRewrite = report => extractSection(report, '简洁改写');

// 各项指标的口径，数据表和训练记录共用；没有时长（文字稿）或没有字时返回 null
const speedOf = stats => (stats.duration > 0 && stats.totalWords ? Math.round(stats.totalWords / (stats.duration / 60)) : null);
const perMinuteOf = (n, duration) => (duration > 0 ? (n / (duration / 60)).toFixed(1) : null);
const densityOf = stats => (stats.totalWords ? Math.round((stats.totalWords - (stats.noiseChars || 0)) / stats.totalWords * 100) : null);

/**
 * 生成数据表 markdown
 * @param {Object} stats - 前端累计的统计（totalWords 为字数，duration 为秒，粘贴模式为 0）
 * @param {string} report - 模型返回的报告，用于统计简洁改写的字数
 */
function formatStats(stats, report) {
  const rows = [];
  const perMinute = n => {
    const rate = perMinuteOf(n, stats.duration);
    return rate === null ? '' : `，${rate} 次/分钟`;
  };
  const detail = counts => {
    const text = formatCounts(counts);
    return text ? `（${text}）` : '';
  };

  if (stats.duration > 0) rows.push(['时长', `${stats.duration} 秒`]);
  rows.push(['字数', `${stats.totalWords}`]);
  const speed = speedOf(stats);
  if (speed !== null) rows.push(['语速', `${speed} 字/分钟`]);
  rows.push(['填充词', `${stats.fillers} 次${perMinute(stats.fillers)}${detail(stats.fillerCounts)}`]);
  rows.push(['犹豫词', `${stats.hedges} 次${perMinute(stats.hedges)}${detail(stats.hedgeCounts)}`]);
  const density = densityOf(stats);
  if (density !== null) rows.push(['表达密度', `${density}%（去掉填充词、犹豫词后剩余字数占比）`]);

  const rewrite = extractRewrite(report);
  if (rewrite && stats.totalWords) {
    const rewriteWords = countWords(rewrite);
    rows.push(['简洁改写', `${rewriteWords} 字，约为原文的 ${Math.round(rewriteWords / stats.totalWords * 100)}%`]);
  }

  return '## 📊 数据（程序统计）\n\n| 指标 | 数值 |\n|------|------|\n' +
    rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
}

module.exports = { formatStats, formatTime, extractSection, extractRewrite, speedOf, perMinuteOf, densityOf };
