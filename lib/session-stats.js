/**
 * 一次练习的统计：逐句累加词库分析结果
 * 口径与 src/app.js 的 addToStats 一致（渲染进程不能 require，那边保留一份同样的实现）
 */

function createStats(duration = 0) {
  return {
    fillers: 0, hedges: 0, vagueWords: 0, totalWords: 0, noiseChars: 0, duration,
    fillerCounts: {}, hedgeCounts: {}
  };
}

function addToStats(stats, analysis) {
  const count = (counts, items) => items.forEach(({ word }) => { counts[word] = (counts[word] || 0) + 1; });
  stats.fillers += analysis.fillers.length;
  stats.hedges += analysis.hedges.length;
  stats.vagueWords += analysis.vagueWords.length;
  stats.totalWords += analysis.totalWords;
  stats.noiseChars += analysis.noiseChars;
  count(stats.fillerCounts, analysis.fillers);
  count(stats.hedgeCounts, analysis.hedges);
}

module.exports = { createStats, addToStats };
