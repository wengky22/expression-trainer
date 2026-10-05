/**
 * 模型调用回归测试：node scripts/test-ai-feedback.js
 * 用本地假接口模拟被截断、空正文、正常三种返回，确认截断/空报告不会被当成功
 */

const http = require('http');
const { sendReport } = require('../lib/ai-feedback');

const STATS = { duration: 60, totalWords: 100, fillers: 0, hedges: 0, noiseChars: 0, fillerCounts: {}, hedgeCounts: {} };

function startServer(reply) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ finish_reason: reply.finish_reason, message: { content: reply.content } }] }));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function report(reply) {
  const server = await startServer(reply);
  const settings = { provider: 'custom', baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fake' };
  try {
    return await sendReport('测试原文', STATS, settings, null);
  } finally {
    server.close();
  }
}

const CASES = [
  ['输出达到长度上限时报错', async () => {
    await report({ finish_reason: 'length', content: '## 一句话复述\n写到一半' }).then(
      () => { throw new Error('应当报错却返回了报告'); },
      err => { if (!err.message.includes('长度上限')) throw err; });
  }],
  ['正文为空时报错', async () => {
    await report({ finish_reason: 'stop', content: '' }).then(
      () => { throw new Error('应当报错却返回了报告'); },
      err => { if (!err.message.includes('没有返回报告正文')) throw err; });
  }],
  ['正常返回时附上数据表', async () => {
    const text = await report({ finish_reason: 'stop', content: '## 一句话复述\n完整内容' });
    if (!text.startsWith('## 一句话复述') || !text.includes('## 📊 数据（程序统计）')) throw new Error(text);
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
      console.log(`✗ ${name}\n    ${err.message}`);
    }
  }
  console.log(`\n${CASES.length - failed}/${CASES.length} 通过`);
  process.exit(failed ? 1 : 0);
})();
