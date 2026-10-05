/**
 * 录音 → 报告：转写、统计、调用大模型生成报告，写成与录音同名的 markdown
 * 配置文件：~/.config/expression-trainer/pipeline.json；环境变量优先，便于临时测试（例如密钥不落盘）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLexicon, analyzeText } = require('./lexicon');
const { transcribeFile } = require('./transcribe');
const { createStats, addToStats } = require('./session-stats');
const { sendReport } = require('./ai-feedback');

const CONFIG_PATH = path.join(os.homedir(), '.config', 'expression-trainer', 'pipeline.json');
const AUDIO_EXTS = new Set(['.m4a', '.mp3', '.wav', '.aac', '.flac', '.ogg', '.opus', '.webm', '.amr', '.mp4']);

let lexiconLoaded = false;

function loadConfig() {
  const file = fs.existsSync(CONFIG_PATH) ? JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) : {};
  const env = process.env;
  return {
    recordingsDir: env.RECORDINGS_DIR || file.recordingsDir || path.join(__dirname, '..', 'recordings'),
    provider: env.PROVIDER || file.provider || 'deepseek',
    model: env.MODEL || file.model || 'deepseek-flash',
    apiKey: env.API_KEY || file.apiKey || '',
    ollamaUrl: env.OLLAMA_URL || file.ollamaUrl,
    baseUrl: file.baseUrl,
    intervalSec: Number(env.INTERVAL_SEC || file.intervalSec || 30),
  };
}

const isAudioFile = name => AUDIO_EXTS.has(path.extname(name).toLowerCase());
const withoutExt = file => file.slice(0, file.length - path.extname(file).length);
const reportPathOf = file => `${withoutExt(file)}.报告.md`;
const failPathOf = file => `${withoutExt(file)}.失败.txt`;

function formatTime(sec) {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * 处理一个录音，返回生成的报告路径
 */
async function processRecording(file, config) {
  if (!lexiconLoaded) {
    loadLexicon();
    lexiconLoaded = true;
  }

  const { duration, segments } = await transcribeFile(file);
  if (!segments.length) throw new Error('没有识别出文字（录音为空或没有人声）');

  // 逐句分析后累加，与应用口径一致（「就是」开头等规则依赖断句）
  const stats = createStats(Math.round(duration));
  for (const { text } of segments) {
    const analysis = analyzeText(text);
    if (analysis) addToStats(stats, analysis);
  }

  const fullText = segments.map(s => s.text).join('');
  const { provider, model, apiKey, ollamaUrl, baseUrl } = config;
  const report = await sendReport(fullText, stats, { provider, model, apiKey, ollamaUrl, baseUrl }, null);

  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const markdown = `# 表达训练报告

- 录音：${path.basename(file)}
- 时长：${formatTime(stats.duration)}
- 生成时间：${now}
- 模型：${provider} / ${model}

## 原文（语音识别，按停顿断句）

${segments.map(s => `- [${formatTime(s.start)}] ${s.text}`).join('\n')}

---

${report}
`;

  // 先写临时文件再改名，避免在 NAS 上看到写了一半的报告
  const target = reportPathOf(file);
  fs.writeFileSync(`${target}.tmp`, markdown, 'utf-8');
  fs.renameSync(`${target}.tmp`, target);
  return target;
}

module.exports = { loadConfig, processRecording, isAudioFile, reportPathOf, failPathOf, CONFIG_PATH };
