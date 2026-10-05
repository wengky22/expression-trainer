/**
 * 不开界面测试结束报告：node scripts/report-test.js <逐字稿.json> <provider> [model]
 * 逐字稿 JSON：{ "duration": 秒（文字稿填 0）, "segments": ["每句 ASR 断句", ...] }
 * 统计方式与 src/app.js 一致（逐句分析后累加）
 * 密钥从环境变量 API_KEY 读取；Ollama 地址可用 OLLAMA_URL 覆盖
 */

const fs = require('fs');
const { loadLexicon, analyzeText } = require('../lib/lexicon');
const { sendReport } = require('../lib/ai-feedback');
const { createStats, addToStats } = require('../lib/session-stats');

async function main() {
  const [file, provider, model] = process.argv.slice(2);
  if (!file || !provider) {
    console.error('用法：node scripts/report-test.js <逐字稿.json> <openai|deepseek|ollama|custom> [model]');
    process.exit(1);
  }
  const { duration = 0, segments } = JSON.parse(fs.readFileSync(file, 'utf-8'));

  loadLexicon();
  const stats = createStats(duration);
  for (const segment of segments) {
    const analysis = analyzeText(segment);
    if (analysis) addToStats(stats, analysis);
  }

  const settings = { provider, apiKey: process.env.API_KEY || '', model, ollamaUrl: process.env.OLLAMA_URL };
  const start = Date.now();
  const report = await sendReport(segments.join(''), stats, settings, null);
  console.log(report);
  console.error(`\n耗时 ${((Date.now() - start) / 1000).toFixed(0)} 秒`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
