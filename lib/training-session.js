/**
 * 训练流程：同一话题的多次录音
 * 听众独立复述 → 与表达意图核对 → 重新表达 → 前后比较并保存记录
 *
 * - 话题文件夹 recordings/<话题>/ 里放意图文件和每次的录音，按处理先后算第几次
 * - 意图文件 意图.txt 或 意图.md（纯文本）：第一行写核心意思，后面每行一个要点（可选）
 * - 听众复述来自报告 Prompt 的「听众复述」一节，那一步看不到意图，复述是独立的
 * - 模型判为传达/部分、但原文里找不到依据的要点记为「待核实」，不计入传达
 * - 只和意图相同的前几次比较；改了意图就从这一次重新开始比较
 * - 训练记录：.训练记录.json 给程序读写，训练记录.md 给人看；读写训练记录在话题锁内完成，
 *   监视程序和手动处理同时运行时不会互相覆盖
 */

const fs = require('fs');
const path = require('path');
const { getIntentCheckPrompt, getComparePrompt } = require('./prompts');
const { sendPrompt } = require('./ai-feedback');
const { formatTime, extractSection, speedOf, perMinuteOf, densityOf } = require('./report-data');
const { writeFileAtomic, withFileLock } = require('./fs-utils');

const INTENT_FILES = ['意图.txt', '意图.md'];
const HISTORY_FILE = '.训练记录.json';
const RECORD_FILE = '训练记录.md';
const LOCK_FILE = '.训练记录.lock';
const CORE_STATUS = ['一致', '部分一致', '不一致'];
const POINT_STATUS = ['传达', '部分', '缺失'];
const UNVERIFIED = '待核实';

function findIntentFile(dir) {
  for (const name of INTENT_FILES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * 解析意图文件：第一行核心意思，其余每行一个要点
 * 行首的 # - * • 1. 1、 (1) 等列表符号会去掉；「核心意思：」前缀和单独一行的「要点：」也会去掉
 */
function parseIntent(text) {
  const content = text.replace(/^﻿/, '');
  // Mac「文本编辑」默认存成 RTF
  if (content.trimStart().startsWith('{\\rtf')) {
    throw new Error('意图文件是 RTF 格式：请在「文本编辑」里选「格式 → 制作纯文本」后重新保存');
  }
  const lines = content.split(/\r?\n/)
    .map(line => line.trim().replace(/^(?:#+|[-*•·]|\d+[.、)）](?!\d)|[（(]\d+[)）])\s*/, '').trim())
    .filter(line => line && !/^要点[:：]?$/.test(line));
  if (!lines.length) throw new Error('意图文件是空的：第一行写核心意思，后面每行一个要点');
  const [core, ...points] = lines;
  return { core: core.replace(/^核心(?:意思)?[:：]\s*/, ''), points };
}

/**
 * 校验模型返回的意图核对 JSON，并检查原文依据是否真在原文里
 */
function parseCheck(raw, intent, fullText) {
  let data;
  try {
    data = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new Error('意图核对结果不是有效的 JSON');
  }
  // 模型偶尔把 core 摊平成 "core": "不一致", "reason": "…"，取值照样校验
  const core = data && typeof data.core === 'string' ? { status: data.core, reason: data.reason } : (data && data.core) || {};
  if (!CORE_STATUS.includes(core.status)) {
    throw new Error(`意图核对结果格式不对：核心意思的结果是 ${JSON.stringify(core.status)}`);
  }
  const points = Array.isArray(data.points) ? data.points : [];
  if (points.length !== intent.points.length) {
    throw new Error(`意图核对结果格式不对：意图有 ${intent.points.length} 个要点，返回了 ${points.length} 个`);
  }

  // 模型摘录时可能加了标点，去掉标点和空白再比
  const normalize = s => s.replace(/[\s\p{P}]/gu, '');
  const plainText = normalize(fullText);
  return {
    core: { status: core.status, reason: String(core.reason || '') },
    points: points.map(p => {
      if (!POINT_STATUS.includes(p && p.status)) {
        throw new Error(`意图核对结果格式不对：要点的结果是 ${JSON.stringify(p && p.status)}`);
      }
      const evidence = String(p.evidence || '').trim();
      const evidenceFound = Boolean(evidence) && plainText.includes(normalize(evidence));
      return {
        // 说传达了却拿不出原文依据的，不能算传达
        status: p.status !== '缺失' && !evidenceFound ? UNVERIFIED : p.status,
        claimed: p.status,
        evidence,
        evidenceFound,
        reason: String(p.reason || ''),
      };
    }),
    misunderstood: (Array.isArray(data.misunderstood) ? data.misunderstood : []).map(String).slice(0, 3),
    fix: String(data.fix || ''),
  };
}

function countPoints(check) {
  const count = status => check.points.filter(p => p.status === status).length;
  return {
    total: check.points.length,
    conveyed: count('传达'), partial: count('部分'), unverified: count(UNVERIFIED), missing: count('缺失'),
  };
}

/**
 * 要点传达："3/4（部分 1，待核实 1）"；意图没列要点时为 "—"
 */
function formatPointCount(check) {
  const { total, conveyed, partial, unverified } = countPoints(check);
  if (!total) return '—';
  const notes = [partial && `部分 ${partial}`, unverified && `${UNVERIFIED} ${unverified}`].filter(Boolean);
  return `${conveyed}/${total}${notes.length ? `（${notes.join('，')}）` : ''}`;
}

// 表格单元格里不能有竖线和换行
const cell = text => String(text).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

function formatIntent(intent) {
  const points = intent.points.length
    ? `要点：\n\n${intent.points.map((p, i) => `${i + 1}. ${p}`).join('\n')}`
    : '（没有列出要点）';
  return `核心意思：${intent.core}\n\n${points}`;
}

/**
 * 意图核对的正文（不含标题），报告和前后比较的提示词共用
 */
function formatCheck(intent, check) {
  const { reason } = check.core;
  const lines = [`**核心意思：${check.core.status}**${reason ? `。${reason}` : ''}`];

  if (check.points.length) {
    lines.push('', '| 要点 | 结果 | 原文依据 | 说明 |', '| --- | --- | --- | --- |');
    check.points.forEach((p, i) => {
      const evidence = p.evidence ? `“${cell(p.evidence)}”${p.evidenceFound ? '' : '（原文中未找到）'}` : '';
      const reason = p.status === UNVERIFIED ? `模型判为${p.claimed}，但没有可核对的原文依据。${p.reason}` : p.reason;
      lines.push(`| ${i + 1}. ${cell(intent.points[i])} | ${p.status} | ${evidence} | ${cell(reason)} |`);
    });
    const { total, conveyed, partial, unverified, missing } = countPoints(check);
    const unverifiedNote = unverified ? `，${UNVERIFIED} ${unverified}` : '';
    lines.push('', `要点传达 ${conveyed}/${total}，部分 ${partial}${unverifiedNote}，缺失 ${missing}。`);
  }
  if (check.misunderstood.length) {
    lines.push('', '**听偏的地方**', '', ...check.misunderstood.map(m => `- ${m}`));
  }
  if (check.fix) lines.push('', `**重新表达时最该改**：${check.fix}`);
  return lines.join('\n');
}

const METRICS = [
  ['时长', a => formatTime(a.stats.duration)],
  ['字数', a => a.stats.totalWords],
  ['语速（字/分钟）', a => speedOf(a.stats) ?? '—'],
  ['填充词（次/分钟）', a => perMinuteOf(a.stats.fillers, a.stats.duration) ?? '—'],
  ['犹豫词（次/分钟）', a => perMinuteOf(a.stats.hedges, a.stats.duration) ?? '—'],
  ['表达密度', a => `${densityOf(a.stats) ?? '—'}%`],
  ['核心意思', a => a.check.core.status],
  ['要点传达', a => formatPointCount(a.check)],
];

const sameIntent = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * 到 index 为止、与第 index 次意图相同的各次练习的下标
 */
function sameIntentIndexes(attempts, index) {
  return attempts.slice(0, index + 1).map((a, i) => i).filter(i => sameIntent(attempts[i].intent, attempts[index].intent));
}

/**
 * 前后比较的数据表：同一意图下的第一次、上一次、本次（只有两次时上一次就是第一次）
 * @param {number[]} indexes - sameIntentIndexes 的结果，至少两个；列标题用全局的第几次，与训练记录一致
 */
function formatComparison(attempts, indexes) {
  const current = indexes.at(-1);
  const columns = indexes.length === 2 ? indexes : [indexes[0], indexes.at(-2), current];
  const header = columns.map(i => (i === current ? `第 ${i + 1} 次（本次）` : `第 ${i + 1} 次`));
  return [
    `| 指标 | ${header.join(' | ')} |`,
    `| --- |${' --- |'.repeat(columns.length)}`,
    ...METRICS.map(([name, value]) => `| ${name} | ${columns.map(i => value(attempts[i])).join(' | ')} |`),
  ].join('\n');
}

function loadHistory(dir) {
  const file = path.join(dir, HISTORY_FILE);
  if (!fs.existsSync(file)) return { attempts: [] };
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    // 不覆盖，免得丢掉以前的记录
    throw new Error(`训练记录 ${HISTORY_FILE} 已损坏，请修复或删除后重试`);
  }
}

/**
 * 加入一次练习；同一个录音重新处理时替换原来那次，保留它的次序
 * @returns {number} 这次练习在 attempts 中的下标
 */
function upsertAttempt(history, attempt) {
  const index = history.attempts.findIndex(a => a.file === attempt.file);
  if (index >= 0) {
    history.attempts[index] = attempt;
    return index;
  }
  history.attempts.push(attempt);
  return history.attempts.length - 1;
}

/**
 * 意图核对 + 与上一次比较，并把这次练习写进 history（调用方负责保存）
 * @returns {{ sections: string, attemptNo: number }} sections 为插进报告的「意图核对」「与上次比较」两节
 */
async function runTraining({ file, recordedAt, intent, fullText, stats, report, history, settings }) {
  const paraphrase = extractSection(report, '听众复述');
  if (!paraphrase) throw new Error('报告里没有「听众复述」一节，无法核对意图');

  const raw = await sendPrompt(getIntentCheckPrompt(intent, fullText, paraphrase), settings, { json: true });
  const check = parseCheck(raw, intent, fullText);

  const { duration, totalWords, fillers, hedges, noiseChars } = stats;
  const index = upsertAttempt(history, {
    file: path.basename(file),
    recordedAt,
    processedAt: new Date().toISOString(),
    intent,
    stats: { duration, totalWords, fillers, hedges, noiseChars },
    text: fullText,
    paraphrase,
    check,
  });

  let sections = `## 意图核对\n\n${formatCheck(intent, check)}`;
  const same = sameIntentIndexes(history.attempts, index);
  if (same.length > 1) {
    const previous = history.attempts[same.at(-2)];
    const comparison = await sendPrompt(getComparePrompt(intent,
      { text: previous.text, check: formatCheck(previous.intent, previous.check) },
      { text: fullText, check: formatCheck(intent, check) }), settings);
    sections += `\n\n## 与上次比较\n\n${formatComparison(history.attempts, same)}\n\n${comparison}`;
  } else if (index > 0) {
    // 标准不同的两次核对结果不能直接比较
    sections += '\n\n## 与上次比较\n\n表达意图和之前几次不同，这次不做前后比较；之后按新的意图比较。';
  }
  return { sections, attemptNo: index + 1 };
}

/**
 * 在话题锁内读训练记录 → 核对、比较 → 写回 .训练记录.json 和 训练记录.md
 * 先保存训练记录、再由调用方写报告：中途失败重试时，同一个录音会替换记录里原来那次
 * @returns {{ sections: string, attemptNo: number }}
 */
async function trainAndRecord({ dir, lockOptions, ...attempt }) {
  return withFileLock(path.join(dir, LOCK_FILE), async () => {
    const history = loadHistory(dir);
    const result = await runTraining({ ...attempt, history });
    writeFileAtomic(path.join(dir, HISTORY_FILE), `${JSON.stringify(history, null, 2)}\n`);
    writeFileAtomic(path.join(dir, RECORD_FILE), formatRecord(path.basename(dir), attempt.intent, history.attempts));
    return result;
  }, lockOptions);
}

/**
 * 训练记录.md：意图、每次一行的结果表、每次的听众复述
 */
function formatRecord(topic, intent, attempts) {
  const current = a => sameIntent(a.intent, intent);
  const date = iso => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—');
  const rows = attempts.map((a, i) => `| ${i + 1}${current(a) ? '' : '\\*'} | ${cell(a.file)} | ${date(a.recordedAt)} | ${METRICS.map(([, value]) => value(a)).join(' | ')} |`);
  const note = attempts.some(a => !current(a)) ? '\n\n\\* 这几次是按修改前的意图核对的，不和现在的意图比较。' : '';
  const paraphrases = attempts.map((a, i) => `### 第 ${i + 1} 次：${a.file}\n\n${a.paraphrase}`).join('\n\n');

  return `# 训练记录：${topic}

## 表达意图

${formatIntent(intent)}

## 每次结果

| 次数 | 录音 | 录音时间 | ${METRICS.map(([name]) => name).join(' | ')} |
| --- | --- | --- |${' --- |'.repeat(METRICS.length)}
${rows.join('\n')}${note}

## 每次的听众复述

${paraphrases}
`;
}

/**
 * 把意图核对和前后比较插到报告「听众复述」一节后面
 */
function insertAfterParaphrase(report, sections) {
  const match = report.match(/^##\s*听众复述\s*\n[\s\S]*?(?=^##\s|(?![\s\S]))/m);
  if (!match) return `${sections}\n\n${report}`;
  const end = match.index + match[0].length;
  return `${report.slice(0, end).trimEnd()}\n\n${sections}\n\n${report.slice(end)}`;
}

module.exports = {
  HISTORY_FILE, RECORD_FILE, LOCK_FILE,
  findIntentFile, parseIntent, parseCheck, formatIntent, formatCheck, formatComparison, formatPointCount,
  sameIntentIndexes, loadHistory, upsertAttempt, runTraining, trainAndRecord, formatRecord, insertAfterParaphrase,
};
