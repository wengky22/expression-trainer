/**
 * 语音识别模块 - 基于 sherpa-onnx-node
 * 使用 streaming recognizer 实现实时中文语音识别
 * 录音通过 Electron 渲染进程的 Web Audio API 采集，音频数据通过 IPC 传入
 */

const path = require('path');
const fs = require('fs');

let recognizer = null;
let stream = null;
let isRunning = false;
let offlineRecognizer = null;

const MODELS_DIR = path.join(__dirname, '..', 'models');
const MODEL_SUBDIR = 'sherpa-onnx-streaming-paraformer-bilingual-zh-en';
const OFFLINE_MODEL_SUBDIR = 'sherpa-onnx-paraformer-zh-2024-03-09';

/**
 * 检查模型文件是否存在
 */
function checkModels(subdir = MODEL_SUBDIR, files = ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt']) {
  const modelDir = path.join(MODELS_DIR, subdir);

  for (const file of files) {
    const fullPath = path.join(modelDir, file);
    if (!fs.existsSync(fullPath)) {
      throw new Error(
        `模型文件未找到: ${file}\n` +
        `请确认 models/${subdir}/ 目录下有完整的模型文件（下载方法见 README「下载语音识别模型」）`
      );
    }
  }
}

/**
 * 初始化 ASR 引擎
 */
async function initASR() {
  if (recognizer) {
    // 已初始化，重置stream即可
    stream = recognizer.createStream();
    isRunning = true;
    console.log('[ASR] 重用已有引擎，创建新stream');
    return;
  }

  checkModels();

  const sherpa = require('sherpa-onnx-node');
  const modelDir = path.join(MODELS_DIR, MODEL_SUBDIR);

  const config = {
    featConfig: {
      sampleRate: 16000,
      featureDim: 80
    },
    modelConfig: {
      paraformer: {
        encoder: path.join(modelDir, 'encoder.int8.onnx'),
        decoder: path.join(modelDir, 'decoder.int8.onnx'),
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: false
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.2,
    rule3MinUtteranceLength: 20
  };

  recognizer = new sherpa.OnlineRecognizer(config);
  stream = recognizer.createStream();
  isRunning = true;

  console.log('[ASR] 识别引擎初始化完成');
}

/**
 * 接收渲染进程发来的音频数据进行识别
 * @param {Float32Array} samples - 16kHz 单声道音频采样
 * @returns {{ text: string, isFinal: boolean } | null}
 */
function feedAudio(samples) {
  if (!isRunning || !stream || !recognizer) return null;

  // sherpa-onnx-node API: acceptWaveform({ samples, sampleRate })
  stream.acceptWaveform({ samples, sampleRate: 16000 });

  while (recognizer.isReady(stream)) {
    recognizer.decode(stream);
  }

  const result = recognizer.getResult(stream);
  const text = (result.text || '').trim();
  const isEndpoint = recognizer.isEndpoint(stream);

  if (isEndpoint && text) {
    recognizer.reset(stream);
    return { text, isFinal: true };
  } else if (text) {
    return { text, isFinal: false };
  }

  return null;
}

/**
 * 停止识别
 * @returns {string} 最后的未确认文本
 */
function stopRecognition() {
  isRunning = false;

  let finalText = '';
  if (stream && recognizer) {
    stream.inputFinished();
    while (recognizer.isReady(stream)) {
      recognizer.decode(stream);
    }
    const result = recognizer.getResult(stream);
    finalText = (result.text || '').trim();
    stream = null;
  }

  console.log('[ASR] 停止录制');
  return finalText;
}

/**
 * 初始化离线识别引擎（录音文件用）
 * 流式模型在每句话结尾常漏掉最后一个字：字的声学权重累计到 1 才输出，
 * sherpa-onnx 在断句和输入结束时都不做补偿，最后一个字攒不满就丢了。
 * 处理录音文件不需要边说边出字，按停顿切段后用离线模型整段识别
 */
function initOfflineASR() {
  if (offlineRecognizer) return;

  checkModels(OFFLINE_MODEL_SUBDIR, ['model.int8.onnx', 'tokens.txt']);

  const sherpa = require('sherpa-onnx-node');
  const modelDir = path.join(MODELS_DIR, OFFLINE_MODEL_SUBDIR);

  offlineRecognizer = new sherpa.OfflineRecognizer({
    featConfig: {
      sampleRate: 16000,
      featureDim: 80
    },
    modelConfig: {
      paraformer: {
        model: path.join(modelDir, 'model.int8.onnx'),
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      numThreads: 2,
      provider: 'cpu',
      debug: false
    },
    decodingMethod: 'greedy_search'
  });

  console.log('[ASR] 离线识别引擎初始化完成');
}

/**
 * 识别一段完整的语音（16kHz 单声道）
 * @param {Float32Array} samples
 * @returns {string}
 */
function recognizeOffline(samples) {
  const s = offlineRecognizer.createStream();
  s.acceptWaveform({ samples, sampleRate: 16000 });
  offlineRecognizer.decode(s);
  return (offlineRecognizer.getResult(s).text || '').trim();
}

module.exports = { initASR, feedAudio, stopRecognition, initOfflineASR, recognizeOffline };
