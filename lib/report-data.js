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
 * 取出报告中「## 简洁改写」一节的正文
 */
function extractRewrite(report) {
  const match = report.match(/^##\s*简洁改写\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
  return match ? match[1].trim() : '';
}

/**
 * 生成数据表 markdown
 * @param {Object} stats - 前端累计的统计（totalWords 为字数，duration 为秒，粘贴模式为 0）
 * @param {string} report - 模型返回的报告，用于统计简洁改写的字数
 */
function formatStats(stats, report) {
  const rows = [];
  const minutes = stats.duration > 0 ? stats.duration / 60 : 0;
  const perMinute = n => (minutes ? `，${(n / minutes).toFixed(1)} 次/分钟` : '');
  const detail = counts => {
    const text = formatCounts(counts);
    return text ? `（${text}）` : '';
  };

  if (minutes) rows.push(['时长', `${stats.duration} 秒`]);
  rows.push(['字数', `${stats.totalWords}`]);
  if (minutes && stats.totalWords) rows.push(['语速', `${Math.round(stats.totalWords / minutes)} 字/分钟`]);
  rows.push(['填充词', `${stats.fillers} 次${perMinute(stats.fillers)}${detail(stats.fillerCounts)}`]);
  rows.push(['犹豫词', `${stats.hedges} 次${perMinute(stats.hedges)}${detail(stats.hedgeCounts)}`]);
  if (stats.totalWords) {
    const density = Math.round((stats.totalWords - (stats.noiseChars || 0)) / stats.totalWords * 100);
    rows.push(['表达密度', `${density}%（去掉填充词、犹豫词后剩余字数占比）`]);
  }

  const rewrite = extractRewrite(report);
  if (rewrite && stats.totalWords) {
    const rewriteWords = countWords(rewrite);
    rows.push(['简洁改写', `${rewriteWords} 字，约为原文的 ${Math.round(rewriteWords / stats.totalWords * 100)}%`]);
  }

  return '## 📊 数据（程序统计）\n\n| 指标 | 数值 |\n|------|------|\n' +
    rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');
}

module.exports = { formatStats, extractRewrite };
