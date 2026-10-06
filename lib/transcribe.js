/**
 * 录音文件转写：ffmpeg 解码为 16kHz 单声道，按停顿切段，每段用离线模型整段识别
 * （应用里的实时字幕仍用流式模型，见 lib/asr.js；流式模型会漏掉每句最后一个字，文件处理不用它）
 */

const { execFileSync } = require('child_process');
const { initOfflineASR, recognizeOffline } = require('./asr');
const { findSpeechSegments } = require('./segmenter');

const SAMPLE_RATE = 16000;

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
 *          start/end 为秒：start 是这句开始说的时刻，end 是下一句开始的时刻（含句尾停顿）
 */
async function transcribeFile(file) {
  const samples = decodeAudio(file);
  const duration = samples.length / SAMPLE_RATE;
  initOfflineASR();

  const segments = [];
  for (const { speechStart, from, to } of findSpeechSegments(samples, SAMPLE_RATE)) {
    const text = recognizeOffline(samples.subarray(Math.round(from * SAMPLE_RATE), Math.round(to * SAMPLE_RATE)));
    if (text) segments.push({ text, start: speechStart, end: duration });
  }
  for (let i = 0; i + 1 < segments.length; i++) segments[i].end = segments[i + 1].start;

  return { duration, segments };
}

module.exports = { transcribeFile };
