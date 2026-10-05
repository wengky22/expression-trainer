/**
 * 监视录音文件夹，自动为新录音生成报告：node scripts/watch-recordings.js
 * - 定时扫描：gio 挂载的 SMB 目录收不到其他电脑写入的变化通知
 * - 文件大小连续两次扫描不变才处理，避免录音还没传完
 * - 已有「.报告.md」或「.失败.txt」的跳过；连续失败 3 次才写失败文件，删掉它即可重试
 * - 目录不存在（NAS 未挂载）时等待，挂载后自动继续
 */

const fs = require('fs');
const path = require('path');
const { loadConfig, processRecording, isAudioFile, reportPathOf, failPathOf } = require('../lib/recording-report');

const MAX_ATTEMPTS = 3;

const config = loadConfig();
const lastSizes = new Map();
const failures = new Map();
let dirMissing = false;

function log(msg) {
  console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${msg}`);
}

function pendingFiles(dir) {
  return fs.readdirSync(dir)
    // 跳过隐藏文件和 Mac 生成的「._」附属文件
    .filter(name => !name.startsWith('.') && isAudioFile(name))
    .map(name => path.join(dir, name))
    .filter(file => !fs.existsSync(reportPathOf(file)) && !fs.existsSync(failPathOf(file)));
}

async function handle(file) {
  const name = path.basename(file);
  log(`开始处理：${name}`);
  const start = Date.now();
  try {
    const report = await processRecording(file, config);
    failures.delete(file);
    log(`完成（${Math.round((Date.now() - start) / 1000)} 秒）：${path.basename(report)}`);
  } catch (err) {
    const attempts = (failures.get(file) || 0) + 1;
    failures.set(file, attempts);
    log(`失败（第 ${attempts} 次）：${name}：${err.message}`);
    if (attempts >= MAX_ATTEMPTS) {
      fs.writeFileSync(failPathOf(file), `处理失败（已尝试 ${attempts} 次）：${err.message}\n删除本文件后会自动重试。\n`, 'utf-8');
      failures.delete(file);
    }
  }
}

async function scan() {
  if (!fs.existsSync(config.recordingsDir)) {
    if (!dirMissing) log(`录音目录不可用（NAS 未挂载？），等待中：${config.recordingsDir}`);
    dirMissing = true;
    return;
  }
  if (dirMissing) log('录音目录已恢复');
  dirMissing = false;

  for (const file of pendingFiles(config.recordingsDir)) {
    const size = fs.statSync(file).size;
    const stable = size > 0 && lastSizes.get(file) === size;
    lastSizes.set(file, size);
    if (!stable) continue; // 下一轮大小不变再处理
    await handle(file);
    lastSizes.delete(file);
  }
}

async function main() {
  log(`开始监视：${config.recordingsDir}（每 ${config.intervalSec} 秒扫描，模型 ${config.provider} / ${config.model}）`);
  if (!config.apiKey && config.provider !== 'ollama') log('警告：未配置 API 密钥，报告会生成失败');
  for (;;) {
    try {
      await scan();
    } catch (err) {
      log(`扫描出错：${err.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, config.intervalSec * 1000));
  }
}

main();
