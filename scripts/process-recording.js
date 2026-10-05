/**
 * 处理单个录音，在旁边生成「录音名.报告.md」：node scripts/process-recording.js <录音文件>
 * 录音所在文件夹里有 意图.txt / 意图.md 时按训练流程处理（意图核对、与上一次比较、更新训练记录）
 * 配置见 ~/.config/expression-trainer/pipeline.json，环境变量 API_KEY / PROVIDER / MODEL / OLLAMA_URL 可覆盖
 */

const path = require('path');
const { loadConfig, processRecording } = require('../lib/recording-report');

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：node scripts/process-recording.js <录音文件>');
    process.exit(1);
  }
  const start = Date.now();
  const report = await processRecording(path.resolve(file), loadConfig());
  console.log(`报告已生成（${Math.round((Date.now() - start) / 1000)} 秒）：${report}`);
}

main().catch(err => { console.error(`处理失败：${err.message}`); process.exit(1); });
