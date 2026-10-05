/**
 * 训练流程回归测试：node scripts/test-training-session.js
 * 意图解析、核对结果校验、前后比较表、待处理录音列表、话题锁；模型调用用本地假接口
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const training = require('../lib/training-session');
const { listPending } = require('../lib/recording-report');
const { withFileLock } = require('../lib/fs-utils');

const INTENT = { core: '要做一个评估表达的工具', points: ['听众能复述核心意思', '和原意核对', '记录前后变化'] };
const TEXT = '我想做一个工具就是听我说完以后能复述出来然后跟我原来想说的对一下';

const checkJSON = (points, extra = {}) => JSON.stringify({
  core: { status: '部分一致', reason: '听出了工具，没听出记录' },
  points,
  misunderstood: ['以为是录音软件'],
  fix: '先说三件事是什么',
  ...extra,
});
const POINTS_OK = [
  { status: '传达', evidence: '能复述出来', reason: '明确' },
  { status: '部分', evidence: '跟我原来想说的对一下', reason: '含糊' },
  { status: '缺失', evidence: '', reason: '没说' },
];

const stats = (duration, totalWords, fillers) => ({ duration, totalWords, fillers, hedges: 0, noiseChars: fillers });

// delayMs：模拟模型调用耗时，让并发处理的读写交错
function startServer(handler, delayMs) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => setTimeout(() => {
        const content = handler(JSON.parse(body));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }));
      }, delayMs));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function withFakeModel(handler, fn, delayMs = 0) {
  const server = await startServer(handler, delayMs);
  const settings = { provider: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fake' };
  try {
    return await fn(settings);
  } finally {
    server.close();
  }
}

const REPORT = '## 听众复述\n- 核心意思：想做一个复述工具\n\n## 冗余\n无\n\n## 📊 数据（程序统计）\n表';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'training-test-'));
}

const CASES = [
  ['意图：第一行核心意思，其余为要点，去掉列表符号和前缀', () => {
    const intent = training.parseIntent('﻿核心意思：要做一个工具\n要点：\n1. 第一点\n- 第二点\n（3）第三点\n\n3.5 亿用户\n');
    assert.deepStrictEqual(intent, { core: '要做一个工具', points: ['第一点', '第二点', '第三点', '3.5 亿用户'] });
  }],
  ['意图：只有一行时没有要点；markdown 标题也能解析', () => {
    assert.deepStrictEqual(training.parseIntent('# 先说结论\n'), { core: '先说结论', points: [] });
  }],
  ['意图：RTF 和空文件报错', () => {
    assert.throws(() => training.parseIntent('{\\rtf1\\ansi 内容}'), /RTF/);
    assert.throws(() => training.parseIntent('\n  \n'), /空的/);
  }],
  ['核对结果：正常解析；摘录加了标点也算在原文里，原文里找不到的记为待核实', () => {
    const points = [...POINTS_OK];
    points[0] = { status: '传达', evidence: '能复述出来，', reason: '' };
    points[1] = { status: '部分', evidence: '原文里没有这句', reason: '' };
    const check = training.parseCheck('```json\n' + checkJSON(points) + '\n```', INTENT, TEXT);
    assert.strictEqual(check.core.status, '部分一致');
    assert.deepStrictEqual(check.points.map(p => p.status), ['传达', '待核实', '缺失']);
    assert.strictEqual(training.formatPointCount(check), '1/3（待核实 1）');
  }],
  ['核对结果：判为传达但没给依据的也记为待核实，不计入传达', () => {
    const points = [{ status: '传达', evidence: '', reason: '听得出来' }, ...POINTS_OK.slice(1)];
    const check = training.parseCheck(checkJSON(points), INTENT, TEXT);
    assert.deepStrictEqual(check.points.map(p => p.status), ['待核实', '部分', '缺失']);
    assert.strictEqual(training.formatPointCount(check), '0/3（部分 1，待核实 1）');
    const text = training.formatCheck(INTENT, check);
    assert.ok(text.includes('| 待核实 |  | 模型判为传达，但没有可核对的原文依据。听得出来 |'), text);
    assert.ok(text.includes('要点传达 0/3，部分 1，待核实 1，缺失 1。'), text);
  }],
  ['核对结果：模型把核心意思摊平成字符串时也能解析，取值照样校验', () => {
    const flat = JSON.stringify({ core: '不一致', reason: '只听出是测试', points: POINTS_OK });
    const check = training.parseCheck(flat, INTENT, TEXT);
    assert.deepStrictEqual(check.core, { status: '不一致', reason: '只听出是测试' });
    assert.throws(() => training.parseCheck(JSON.stringify({ core: '大体一致', points: POINTS_OK }), INTENT, TEXT), /核心意思的结果/);
  }],
  ['核对结果：要点条数不对、结果不在选项里、不是 JSON 都报错', () => {
    assert.throws(() => training.parseCheck(checkJSON(POINTS_OK.slice(0, 2)), INTENT, TEXT), /3 个要点，返回了 2 个/);
    assert.throws(() => training.parseCheck(checkJSON(POINTS_OK, { core: { status: '基本一致' } }), INTENT, TEXT), /核心意思的结果/);
    assert.throws(() => training.parseCheck(checkJSON([{ status: '很好' }, ...POINTS_OK.slice(1)]), INTENT, TEXT), /要点的结果/);
    assert.throws(() => training.parseCheck('好的，下面是核对结果', INTENT, TEXT), /不是有效的 JSON/);
  }],
  ['同一个录音重新处理时替换原来那次，保留次序', () => {
    const history = { attempts: [] };
    assert.strictEqual(training.upsertAttempt(history, { file: 'a.m4a', v: 1 }), 0);
    assert.strictEqual(training.upsertAttempt(history, { file: 'b.m4a', v: 1 }), 1);
    assert.strictEqual(training.upsertAttempt(history, { file: 'a.m4a', v: 2 }), 0);
    assert.deepStrictEqual(history.attempts.map(a => `${a.file}:${a.v}`), ['a.m4a:2', 'b.m4a:1']);
  }],
  ['报告：意图核对插在听众复述后面', () => {
    const merged = training.insertAfterParaphrase(REPORT, '## 意图核对\n内容');
    assert.ok(/## 听众复述[\s\S]*## 意图核对[\s\S]*## 冗余/.test(merged), merged);
  }],
  ['第 1 次只核对，第 2 次加上前后比较；第 3 次的比较表有第 1 次、上次、本次', async () => {
    const calls = [];
    await withFakeModel(body => {
      const json = Boolean(body.response_format);
      calls.push(json ? 'check' : 'compare');
      return json ? checkJSON(POINTS_OK) : '### 改进了什么\n先说了结论\n\n### 还差什么\n例子太少';
    }, async settings => {
      const history = { attempts: [] };
      const run = (file, s) => training.runTraining({ file, recordedAt: null, intent: INTENT, fullText: TEXT, stats: s, report: REPORT, history, settings });

      const first = await run('/x/第一次.m4a', stats(120, 300, 6));
      assert.strictEqual(first.attemptNo, 1);
      assert.ok(first.sections.includes('## 意图核对') && !first.sections.includes('## 与上次比较'), first.sections);
      assert.ok(first.sections.includes('要点传达 1/3，部分 1，缺失 1。'), first.sections);

      const second = await run('/x/重说.m4a', stats(60, 150, 1));
      assert.strictEqual(second.attemptNo, 2);
      assert.ok(second.sections.includes('| 指标 | 第 1 次 | 第 2 次（本次） |'), second.sections);
      assert.ok(second.sections.includes('| 填充词（次/分钟） | 3.0 | 1.0 |'), second.sections);
      assert.ok(second.sections.includes('### 改进了什么'), second.sections);

      const third = await run('/x/第三次.m4a', stats(60, 120, 0));
      assert.ok(third.sections.includes('| 指标 | 第 1 次 | 第 2 次 | 第 3 次（本次） |'), third.sections);
      assert.ok(third.sections.includes('| 语速（字/分钟） | 150 | 150 | 120 |'), third.sections);

      assert.deepStrictEqual(calls, ['check', 'check', 'compare', 'check', 'compare']);
      const record = training.formatRecord('周会汇报', INTENT, history.attempts);
      assert.ok(record.includes('# 训练记录：周会汇报') && record.includes('| 3 | 第三次.m4a |'), record);
      assert.ok(!record.includes('修改前的意图'), record);

      const changed = training.formatRecord('周会汇报', { ...INTENT, core: '改过的意图' }, history.attempts);
      assert.ok(changed.includes('| 1\\* |') && changed.includes('修改前的意图'), changed);
    });
  }],
  ['改了意图后不和旧意图的那次比较；改回原意图时和原意图的上一次比较', async () => {
    const calls = [];
    const INTENT2 = { core: '建议推迟上线', points: ['听众能复述核心意思', '和原意核对', '记录前后变化'] };
    await withFakeModel(body => {
      const json = Boolean(body.response_format);
      calls.push(json ? 'check' : 'compare');
      return json ? checkJSON(POINTS_OK) : '### 改进了什么\n无\n\n### 还差什么\n无';
    }, async settings => {
      const history = { attempts: [] };
      const run = (file, intent) => training.runTraining({ file, intent, fullText: TEXT, stats: stats(60, 100, 0), report: REPORT, history, settings });
      await run('/x/a.m4a', INTENT);
      const changed = await run('/x/b.m4a', INTENT2);
      assert.ok(changed.sections.includes('表达意图和之前几次不同，这次不做前后比较'), changed.sections);
      assert.ok(!changed.sections.includes('| 指标 |'), changed.sections);
      const back = await run('/x/c.m4a', INTENT);
      assert.ok(back.sections.includes('| 指标 | 第 1 次 | 第 3 次（本次） |'), back.sections);
      assert.deepStrictEqual(calls, ['check', 'check', 'check', 'compare']);
    });
  }],
  ['同一话题同时处理两个录音：话题锁让第二个等第一个写完，记录不丢', async () => {
    const dir = tempDir();
    try {
      await withFakeModel(body => (body.response_format ? checkJSON(POINTS_OK) : '### 改进了什么\n无\n\n### 还差什么\n无'), async settings => {
        const run = file => training.trainAndRecord({ dir, file, intent: INTENT, fullText: TEXT, stats: stats(60, 100, 0), report: REPORT, settings, lockOptions: { pollMs: 20 } });
        const results = await Promise.all([run(path.join(dir, 'a.m4a')), run(path.join(dir, 'b.m4a'))]);
        assert.deepStrictEqual(results.map(r => r.attemptNo).sort(), [1, 2]);
        const history = training.loadHistory(dir);
        assert.deepStrictEqual(history.attempts.map(a => a.file).sort(), ['a.m4a', 'b.m4a']);
        assert.ok(fs.readFileSync(path.join(dir, training.RECORD_FILE), 'utf-8').includes('| 2 |'));
        assert.ok(!fs.existsSync(path.join(dir, training.LOCK_FILE)), '锁文件没有删除');
      }, 150);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  }],
  ['话题锁：持有者进程已退出的残留锁直接接管；被占用时等待超时报错', async () => {
    const dir = tempDir();
    const lock = path.join(dir, '.test.lock');
    try {
      const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
      fs.writeFileSync(lock, JSON.stringify({ pid: deadPid, host: os.hostname(), at: Date.now() }));
      assert.strictEqual(await withFileLock(lock, async () => 'ok', { waitMs: 200, pollMs: 20 }), 'ok');
      assert.ok(!fs.existsSync(lock));

      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }));
      await assert.rejects(withFileLock(lock, async () => 'ok', { waitMs: 200, pollMs: 20 }), /被另一个进程占用/);
      assert.ok(fs.existsSync(lock), '别人的锁不能删');
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  }],
  ['模型返回的核对结果格式不对时报错，不写进记录', async () => {
    await withFakeModel(() => '不是 JSON', async settings => {
      const history = { attempts: [] };
      await assert.rejects(training.runTraining({ file: '/x/a.m4a', intent: INTENT, fullText: TEXT, stats: stats(60, 100, 0), report: REPORT, history, settings }), /不是有效的 JSON/);
      assert.strictEqual(history.attempts.length, 0);
    });
  }],
  ['待处理录音：根目录照常处理，话题文件夹有意图才处理，已处理和 ._ 文件跳过', () => {
    const dir = tempDir();
    const touch = (rel, mtime) => {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'x');
      if (mtime) fs.utimesSync(file, mtime, mtime);
    };
    touch('随手录.m4a', 300);
    touch('._随手录.m4a');
    touch('已处理.m4a');
    touch('已处理.报告.md');
    touch('失败过.m4a');
    touch('失败过.失败.txt');
    touch('周会汇报/意图.txt');
    touch('周会汇报/重说.m4a', 200);
    touch('周会汇报/第一次.m4a', 100);
    touch('面试/第一次.m4a');
    touch('空话题/意图.txt');
    touch('.隐藏/a.m4a');

    const { files, waiting } = listPending(dir);
    assert.deepStrictEqual(files.map(f => path.relative(dir, f)), ['周会汇报/第一次.m4a', '周会汇报/重说.m4a', '随手录.m4a']);
    assert.deepStrictEqual(waiting.map(d => path.relative(dir, d)), ['面试']);
    fs.rmSync(dir, { recursive: true });
  }],
];

(async () => {
  let failed = 0;
  for (const [name, fn] of CASES) {
    try {
      await fn();
      console.log(`✓ ${name}`);
    } catch (err) {
      failed++;
      console.log(`✗ ${name}\n    ${err.message.split('\n').join('\n    ')}`);
    }
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
