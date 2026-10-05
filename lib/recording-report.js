/**
 * 录音 → 报告：转写、统计、调用大模型生成报告，写成与录音同名的 markdown
 * - 录音目录下的录音：单次复盘
 * - 一级子文件夹（话题）里的录音：训练流程，另外核对意图、与上一次比较、更新训练记录（见 training-session.js）
 * 配置文件：~/.config/expression-trainer/pipeline.json；环境变量优先，便于临时测试（例如密钥不落盘）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLexicon, analyzeText } = require('./lexicon');
const { transcribeFile } = require('./transcribe');
const { createStats, addToStats } = require('./session-stats');
const { sendReport } = require('./ai-feedback');
const { formatTime } = require('./report-data');
const training = require('./training-session');

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

/**
 * 先写临时文件再改名，避免在 NAS 上看到写了一半的文件
 */
function writeFileAtomic(target, content) {
  fs.writeFileSync(`${target}.tmp`, content, 'utf-8');
  fs.renameSync(`${target}.tmp`, target);
}

/**
 * 列出待处理（还没有报告或失败文件）的录音：录音目录下的，以及一级子文件夹（话题）里的
 * 话题文件夹还没有意图文件时先不处理，放进 waiting
 * @returns {{ files: string[], waiting: string[] }} files 按修改时间从早到晚
 */
function listPending(dir) {
  const unprocessed = file => !fs.existsSync(reportPathOf(file)) && !fs.existsSync(failPathOf(file));
  // 跳过隐藏文件和 Mac 生成的「._」附属文件
  const audioIn = d => fs.readdirSync(d)
    .filter(name => !name.startsWith('.') && isAudioFile(name))
    .map(name => path.join(d, name))
    .filter(unprocessed);

  const files = audioIn(dir);
  const waiting = [];
  for (const name of fs.readdirSync(dir)) {
    const sub = path.join(dir, name);
    if (name.startsWith('.') || !fs.statSync(sub).isDirectory()) continue;
    const pending = audioIn(sub);
    if (!pending.length) continue;
    if (training.findIntentFile(sub)) files.push(...pending);
    else waiting.push(sub);
  }

  const mtime = file => fs.statSync(file).mtimeMs;
  return { files: files.sort((a, b) => mtime(a) - mtime(b)), waiting };
}

/**
 * 处理一个录音，返回生成的报告路径
 * 录音所在文件夹里有意图文件时走训练流程
 */
async function processRecording(file, config) {
  if (!lexiconLoaded) {
    loadLexicon();
    lexiconLoaded = true;
  }

  // 意图文件有问题时尽早报错，不浪费识别和模型调用
  const dir = path.dirname(file);
  const intentFile = training.findIntentFile(dir);
  const intent = intentFile ? training.parseIntent(fs.readFileSync(intentFile, 'utf-8')) : null;
  const history = intent ? training.loadHistory(dir) : null;

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
  const settings = { provider, model, apiKey, ollamaUrl, baseUrl };
  let report = await sendReport(fullText, stats, settings, null);

  let topicLine = '';
  let intentSection = '';
  if (intent) {
    const topic = path.basename(dir);
    const { sections, attemptNo } = await training.runTraining({
      file, recordedAt: fs.statSync(file).mtime.toISOString(), intent, fullText, stats, report, history, settings,
    });
    // 先保存训练记录再写报告：中途失败重试时，同一个录音会替换记录里原来那次
    writeFileAtomic(path.join(dir, training.HISTORY_FILE), `${JSON.stringify(history, null, 2)}\n`);
    writeFileAtomic(path.join(dir, training.RECORD_FILE), training.formatRecord(topic, intent, history.attempts));
    report = training.insertAfterParaphrase(report, sections);
    topicLine = `- 话题：${topic}（第 ${attemptNo} 次）\n`;
    intentSection = `## 表达意图（${path.basename(intentFile)}）\n\n${training.formatIntent(intent)}\n\n`;
  }

  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const markdown = `# 表达训练报告

${topicLine}- 录音：${path.basename(file)}
- 时长：${formatTime(stats.duration)}
- 生成时间：${now}
- 模型：${provider} / ${model}

${intentSection}## 原文（语音识别，按停顿断句）

${segments.map(s => `- [${formatTime(s.start)}] ${s.text}`).join('\n')}

---

${report}
`;

  const target = reportPathOf(file);
  writeFileAtomic(target, markdown);
  return target;
}

module.exports = { loadConfig, processRecording, listPending, isAudioFile, reportPathOf, failPathOf, CONFIG_PATH };
