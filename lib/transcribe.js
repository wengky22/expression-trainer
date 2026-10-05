/**
 * 录音文件转写：ffmpeg 解码为 16kHz 单声道，按应用相同的方式（4096 采样分块）送入流式识别
 */

const { execFileSync } = require('child_process');
const { initASR, feedAudio, stopRecognition } = require('./asr');

const SAMPLE_RATE = 16000;
const CHUNK = 4096; // 与 src/app.js 中 createScriptProcessor(4096) 一致

function decodeAudio(file) {
  const ffmpeg = require('ffmpeg-static');
  let buf;
  try {
    buf = execFileSync(ffmpeg, [
      '-v', 'error', '-i', file, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', '-'
    ], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // ffmpeg 报错多行且重复，只取最后一行原因
    const reason = String(err.stderr || err.message).trim().split('\n').pop();
    throw new Error(`无法解码音频（文件损坏或格式不支持）：${reason}`);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
}

/**
 * @param {string} file - 任意 ffmpeg 能解码的音频文件
 * @returns {{ duration: number, segments: Array<{text: string, start: number, end: number}> }}
 *          start/end 为秒，按识别断句时刻划分（含句尾停顿）
 */
async function transcribeFile(file) {
  const samples = decodeAudio(file);
  await initASR();

  const segments = [];
  let segmentStart = 0;
  for (let i = 0; i < samples.length; i += CHUNK) {
    const result = feedAudio(samples.subarray(i, i + CHUNK));
    if (result && result.isFinal) {
      const end = Math.min(i + CHUNK, samples.length) / SAMPLE_RATE;
      segments.push({ text: result.text, start: segmentStart, end });
      segmentStart = end;
    }
  }

  // 录音结尾停顿不够时，最后一段还没断句
  const duration = samples.length / SAMPLE_RATE;
  const tail = stopRecognition();
  if (tail) segments.push({ text: tail, start: segmentStart, end: duration });

  return { duration, segments };
}

module.exports = { transcribeFile };
