/**
 * 文件工具：原子写入、跨进程锁（录音目录在 gio 挂载的 SMB 上，两者都已在该挂载上验证）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * 先写临时文件再改名，避免在 NAS 上看到写了一半的文件
 */
function writeFileAtomic(target, content) {
  fs.writeFileSync(`${target}.tmp`, content, 'utf-8');
  fs.renameSync(`${target}.tmp`, target);
}

/**
 * 锁文件是否是残留：超过 staleMs，或持有它的进程（同一台机器上）已经不在
 */
function isStaleLock(lockFile, staleMs) {
  let owner;
  try {
    owner = JSON.parse(fs.readFileSync(lockFile, 'utf-8'));
  } catch {
    // 刚被删除，或持有者还没写完内容：按修改时间判断
    try {
      return Date.now() - fs.statSync(lockFile).mtimeMs > staleMs;
    } catch {
      return false;
    }
  }
  if (Date.now() - owner.at > staleMs) return true;
  if (owner.host !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (err) {
    return err.code === 'ESRCH';
  }
}

/**
 * 跨进程互斥执行 fn：独占创建锁文件，执行完删除；被占用时轮询等待，残留的锁直接接管
 * @param {number} options.waitMs - 最长等待时间，超时报错（调用方的重试机制会再试）
 */
async function withFileLock(lockFile, fn, { waitMs = 180000, staleMs = 600000, pollMs = 1000 } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now() }), { flag: 'wx' });
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (isStaleLock(lockFile, staleMs)) {
      fs.rmSync(lockFile, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${path.basename(lockFile)} 被另一个进程占用（等待超时），稍后重试`);
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  try {
    return await fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

module.exports = { writeFileAtomic, withFileLock };
