// voice-gen.js —— MiniMax 语音合成（T2A v2）客户端 + 音频落盘/校验（bridge.js 与离线测试共用）。
//
// 为什么单独成文件（与 image-gen.js 同构）：
//   桥接主文件已经上万行，把「构造请求 / 解析响应 / 错误码翻译 / 落盘」拆出来后，
//   测试可以起一个本地 HTTP server 冒充 MiniMax，不需要真烧额度，也不需要跑起整个桥接。
//
// 官方接口（2026-11 按 platform.minimax.cn 文档核对，并用本机 M Plan Key 实测通过）：
//   POST {baseUrl}/v1/t2a_v2
//   Authorization: Bearer <M Plan API Key 或按量付费 Key>
//   请求：{ model:'speech-2.8-hd', text, stream:false, output_format:'hex',
//           voice_setting:{voice_id,speed,vol,pitch,(emotion)}, language_boost:'auto',
//           audio_setting:{sample_rate:32000,bitrate:128000,format:'mp3',channel:1} }
//   成功：{ data:{ audio:'<hex>', status:2 }, extra_info:{audio_length(ms), audio_size,
//           audio_format, usage_characters, ...}, trace_id, base_resp:{status_code:0} }
//   业务失败：HTTP 200 + base_resp.status_code != 0
//            （1002 限流 / 1004 鉴权 / 1008 余额 / 1026 内容安全 / 2013 参数 / 2049 Key 无效）
//   音色列表：POST {baseUrl}/v1/get_voice  {voice_type:'system'} → system_voice:[{voice_id,voice_name,...}]
//
// 国内站 baseUrl = https://api.minimax.cn，国际站 = https://api.minimax.io。
// baseUrl 做成配置项：同一份代码能跑两个站，测试时也能指向 http://127.0.0.1:xxxx。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeBaseUrl, readApiKey } from './image-gen.js';

/** 官方常用语音模型（不强制白名单，只做提示；填错模型时服务端会回 2013）。 */
export const VOICE_MODELS = Object.freeze([
  'speech-2.8-hd', 'speech-2.8-turbo',
  'speech-2.6-hd', 'speech-2.6-turbo',
  'speech-02-hd', 'speech-02-turbo',
  'speech-01-hd', 'speech-01-turbo'
]);

/** 官方支持的音色情绪；空字符串 = 不传 emotion（让模型按文本自行判断）。 */
export const VOICE_EMOTIONS = Object.freeze([
  'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'neutral'
]);

/** 官方 audio_setting 支持的容器格式。语音条最终由 SnowLuma 转 SILK，mp3 最稳。 */
export const VOICE_FORMATS = Object.freeze(['mp3', 'wav', 'flac', 'pcm']);

/** 官方支持的采样率 / 码率 / 声道。 */
export const VOICE_SAMPLE_RATES = Object.freeze([8000, 16000, 22050, 24000, 32000, 44100]);
export const VOICE_BITRATES = Object.freeze([32000, 64000, 128000, 256000]);

/** 语音文本上限：语音只适合两三句话；1200 字足够一次自然回复，也远低于服务端上限。 */
export const MAX_VOICE_TEXT_CHARS = 1200;

/** 语音生成配置的默认值（会与 config.json 的 socialV2.voice.generation 深度合并）。 */
export const VOICE_GEN_DEFAULTS = Object.freeze({
  enabled: true,
  baseUrl: 'https://api.minimax.cn',
  apiKey: '',
  apiKeyEnv: 'MINIMAX_API_KEY',
  model: 'speech-2.8-hd',
  voiceId: 'female-shaonv',
  emotion: '',
  speed: 1,
  vol: 1,
  pitch: 0,
  languageBoost: 'auto',
  format: 'mp3',
  sampleRate: 32000,
  bitrate: 128000,
  channel: 1,
  timeoutMs: 120000,
  maxChars: MAX_VOICE_TEXT_CHARS
});

/** 控制台「测试语音」的默认台词。 */
export const VOICE_PREVIEW_TEXT = '你好呀，我是小鲸鱼。今天也想和你说说话，你在忙吗？';

/** 语言增强：官方常用值；其余值原样透传给服务端（由服务端决定是否接受）。 */
const LANGUAGE_BOOSTS = new Set([
  'auto', 'Chinese', 'Chinese,Yue', 'English', 'Japanese', 'Korean',
  'Arabic', 'Russian', 'Spanish', 'French', 'Portuguese', 'German',
  'Turkish', 'Dutch', 'Ukrainian', 'Vietnamese', 'Indonesian', 'Italian',
  'Thai', 'Polish', 'Romanian', 'Greek', 'Czech', 'Finnish', 'Hindi'
]);

const EXT_BY_FORMAT = Object.freeze({
  mp3: 'mp3',
  wav: 'wav',
  flac: 'flac',
  pcm: 'pcm'
});

const MIME_BY_FORMAT = Object.freeze({
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  pcm: 'application/octet-stream'
});

const MINIMAX_VOICE_ERROR_HINTS = Object.freeze({
  1002: 'MiniMax 限流（1002）：请求太频繁，等一会儿再试',
  1004: 'MiniMax 鉴权失败（1004）：检查 API Key 是否填错、是否与站点匹配（国内站用 api.minimax.cn，国际站用 api.minimax.io）',
  1008: 'MiniMax 额度/余额不足（1008）：M Plan 套餐额度用完、或未订阅；到控制台 Plan 页看剩余用量',
  1026: '文本触发了 MiniMax 内容安全（1026）：换个说法再试',
  2013: 'MiniMax 参数不合法（2013）：检查 voice_id / model / 语速 / 情绪等参数',
  2049: 'MiniMax API Key 无效（2049）：重新复制 M Plan API Key（注意不要混用标准按量付费 Key）'
});

/** 取 Key：优先 config.json，其次环境变量（launchd 可以在 plist 里注入）。 */
export { readApiKey };

/** baseUrl 归一（复用 image-gen 的实现与报错口径）。 */
export { normalizeBaseUrl };

/** 只给控制台看的状态用；完整 Key 绝不回显。 */
export function maskApiKey(key) {
  const s = String(key ?? '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** 音色 id 校验：官方 id 含字母数字、下划线、点、连字符、空格与括号（如 Chinese (Mandarin)_Sweet_Lady）。 */
export function normalizeVoiceId(value, fallback = VOICE_GEN_DEFAULTS.voiceId) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (raw.length > 120) throw new Error('voice_id 太长（上限 120 字符）');
  if (!/^[A-Za-z0-9 _().\-\u4e00-\u9fff]+$/.test(raw)) {
    throw new Error(`voice_id「${raw}」含非法字符；只允许字母数字、下划线、点、连字符、空格、括号`);
  }
  return raw;
}

/** 情绪归一：空 = 不指定；其余必须是官方枚举。 */
export function normalizeEmotion(value, fallback = VOICE_GEN_DEFAULTS.emotion) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (!VOICE_EMOTIONS.includes(raw)) {
    throw new Error(`不支持的情绪「${raw}」，可选：${VOICE_EMOTIONS.join('、')}（留空 = 自动）`);
  }
  return raw;
}

function clampNumber(value, { min, max, fallback, name }) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} 不是合法数字`);
  if (n < min || n > max) throw new Error(`${name} 超出范围（${min}~${max}）`);
  return n;
}

/** 语速 0.5~2；音量 0.1~10；音调 -12~12（官方音调单位是半音）。 */
export function normalizeSpeed(value, fallback = VOICE_GEN_DEFAULTS.speed) {
  return clampNumber(value, { min: 0.5, max: 2, fallback, name: '语速 speed' });
}
export function normalizeVol(value, fallback = VOICE_GEN_DEFAULTS.vol) {
  return clampNumber(value, { min: 0.1, max: 10, fallback, name: '音量 vol' });
}
export function normalizePitch(value, fallback = VOICE_GEN_DEFAULTS.pitch) {
  return clampNumber(value, { min: -12, max: 12, fallback, name: '音调 pitch' });
}

export function normalizeAudioFormat(value, fallback = VOICE_GEN_DEFAULTS.format) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (!VOICE_FORMATS.includes(raw)) throw new Error(`不支持的音频格式「${raw}」，可选：${VOICE_FORMATS.join('、')}`);
  return raw;
}

export function normalizeSampleRate(value, fallback = VOICE_GEN_DEFAULTS.sampleRate) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || !VOICE_SAMPLE_RATES.includes(n)) {
    throw new Error(`不支持的采样率「${value}」，可选：${VOICE_SAMPLE_RATES.join('、')}`);
  }
  return n;
}

export function normalizeBitrate(value, fallback = VOICE_GEN_DEFAULTS.bitrate) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || !VOICE_BITRATES.includes(n)) {
    throw new Error(`不支持的码率「${value}」，可选：${VOICE_BITRATES.join('、')}`);
  }
  return n;
}

export function normalizeChannel(value, fallback = VOICE_GEN_DEFAULTS.channel) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  if (n !== 1 && n !== 2) throw new Error('声道只支持 1（单声道）或 2（立体声）');
  return n;
}

/** language_boost：auto 或官方语言名；未知值透传（服务端可能回 2013）。 */
export function normalizeLanguageBoost(value, fallback = VOICE_GEN_DEFAULTS.languageBoost) {
  const raw = String(value ?? '').trim();
  if (!raw) return fallback;
  if (LANGUAGE_BOOSTS.has(raw)) return raw;
  if (/^[A-Za-z,() _-]{1,40}$/.test(raw)) return raw;
  throw new Error(`language_boost「${raw}」不合法`);
}

/** 一次性归一所有语音参数（配置读取与 HTTP 入参共用）。 */
export function normalizeVoiceOptions(input = {}, defaults = VOICE_GEN_DEFAULTS) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const maxCharsRaw = Number(src.maxChars ?? defaults.maxChars);
  return {
    voiceId: normalizeVoiceId(src.voiceId ?? defaults.voiceId, defaults.voiceId),
    emotion: normalizeEmotion(src.emotion ?? defaults.emotion, defaults.emotion),
    speed: normalizeSpeed(src.speed ?? defaults.speed, defaults.speed),
    vol: normalizeVol(src.vol ?? defaults.vol, defaults.vol),
    pitch: normalizePitch(src.pitch ?? defaults.pitch, defaults.pitch),
    languageBoost: normalizeLanguageBoost(src.languageBoost ?? defaults.languageBoost, defaults.languageBoost),
    format: normalizeAudioFormat(src.format ?? defaults.format, defaults.format),
    sampleRate: normalizeSampleRate(src.sampleRate ?? defaults.sampleRate, defaults.sampleRate),
    bitrate: normalizeBitrate(src.bitrate ?? defaults.bitrate, defaults.bitrate),
    channel: normalizeChannel(src.channel ?? defaults.channel, defaults.channel),
    maxChars: Number.isFinite(maxCharsRaw) ? Math.min(5000, Math.max(50, Math.round(maxCharsRaw))) : defaults.maxChars
  };
}

/**
 * 把要朗读的文本洗成「适合念出来」的样子。
 *
 * 模型的文本常常带 Markdown（`**加粗**`、```代码```、链接、列表符号）—— TTS 会把星号、
 * 括号、URL 一个字符一个字符念出来，很难听。这里做的是**保守清洗**：只去掉明显是排版
 * 标记的东西，保留原文的字与标点。清洗后为空或超长都直接报可读错误。
 */
export function normalizeVoiceText(text, maxChars = MAX_VOICE_TEXT_CHARS) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  // 代码块整段丢掉：读代码没有意义（而且模型经常在其中夹带路径/URL）。
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/~~~[\s\S]*?~~~/g, ' ');
  // 行内代码保留内容，去掉反引号
  s = s.replace(/`([^`]*)`/g, '$1');
  // 图片整段丢掉；链接保留可见文字
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  // 裸露 URL 去掉（念 URL 很怪，也避免把带 token 的链接发进语音）
  s = s.replace(/https?:\/\/\S+/g, ' ');
  // 标题/引用/列表符号
  s = s.replace(/^[ \t]*(#{1,6}|>|[-*+]|\d+[.)])[ \t]+/gm, '');
  // 强调符号（** __ ~~ * _）
  s = s.replace(/\*\*|__|~~|\*|_/g, '');
  // 所有换行与连续空白压成单空格：分句靠标点，不靠换行
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) throw new Error('语音文本不能为空（去掉 Markdown 后没有可朗读的内容）');
  const max = Number(maxChars);
  const limit = Number.isFinite(max) && max > 0 ? Math.round(max) : MAX_VOICE_TEXT_CHARS;
  if (s.length > limit) {
    throw new Error(`语音文本太长（${s.length} 字，上限 ${limit} 字）：语音只适合两三句话，长内容请打字`);
  }
  return s;
}

/**
 * 构造 /v1/t2a_v2 请求体（纯函数，便于单测）。
 *
 * 不传 `emotion` 时保持「按文本自动判断」；其余参数统一用归一后的值，
 * 避免手工传字符串 "1.0" 之类导致服务端 2013。
 */
export function buildVoicePayload({
  text,
  model,
  voiceId,
  emotion,
  speed,
  vol,
  pitch,
  languageBoost,
  format,
  sampleRate,
  bitrate,
  channel,
  maxChars
} = {}) {
  const norm = normalizeVoiceOptions({ voiceId, emotion, speed, vol, pitch, languageBoost, format, sampleRate, bitrate, channel, maxChars });
  const spoken = normalizeVoiceText(text, norm.maxChars);
  const modelName = String(model ?? '').trim() || VOICE_GEN_DEFAULTS.model;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(modelName)) {
    throw new Error(`model「${modelName}」不合法（只允许字母数字、点、下划线、连字符）`);
  }
  const voiceSetting = {
    voice_id: norm.voiceId,
    speed: norm.speed,
    vol: norm.vol,
    pitch: norm.pitch
  };
  if (norm.emotion) voiceSetting.emotion = norm.emotion;
  return {
    model: modelName,
    text: spoken,
    stream: false,
    output_format: 'hex',
    language_boost: norm.languageBoost,
    voice_setting: voiceSetting,
    audio_setting: {
      sample_rate: norm.sampleRate,
      bitrate: norm.bitrate,
      format: norm.format,
      channel: norm.channel
    }
  };
}

/** 把 base_resp.status_code 翻译成人话；未知码也带上原始信息，别让模型/人瞎猜。 */
export function describeMinimaxVoiceError(statusCode, statusMsg = '') {
  const code = Number(statusCode);
  const hint = MINIMAX_VOICE_ERROR_HINTS[code];
  const suffix = statusMsg ? `（原始信息：${statusMsg}）` : '';
  if (hint) return `${hint}${suffix}`;
  return `MiniMax 语音接口返回错误码 ${Number.isFinite(code) ? code : '?'}${suffix}`;
}

/** 认出常见音频容器；认不出返回 null。用于防止把 HTML 错误页/JSON 当音频发出去。 */
export function sniffAudio(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return null;
  const magic4 = buffer.subarray(0, 4).toString('latin1');
  if (magic4.slice(0, 3) === 'ID3') return { format: 'mp3', ext: 'mp3', mimeType: MIME_BY_FORMAT.mp3 };
  // MPEG audio frame sync：0xFF 0xEx/0xFx
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return { format: 'mp3', ext: 'mp3', mimeType: MIME_BY_FORMAT.mp3 };
  if (magic4 === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WAVE') return { format: 'wav', ext: 'wav', mimeType: MIME_BY_FORMAT.wav };
  if (magic4 === 'fLaC') return { format: 'flac', ext: 'flac', mimeType: MIME_BY_FORMAT.flac };
  if (magic4 === 'OggS') return { format: 'ogg', ext: 'ogg', mimeType: 'audio/ogg' };
  return null;
}

/**
 * 解析 T2A 响应里的 audio 字段（hex / base64 / URL 三种形态都兜住）。
 * 返回 { buffer, format, mimeType } 或 { url }。
 */
export function decodeVoicePayload(audio, { expectedFormat = 'mp3' } = {}) {
  const raw = String(audio ?? '').trim();
  if (!raw) throw new Error('MiniMax 返回了空音频');
  if (/^https?:\/\//i.test(raw)) return { url: raw };
  const compact = raw.replace(/\s+/g, '');
  let buffer;
  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0) {
    buffer = Buffer.from(compact, 'hex');
  } else {
    // 兼容按量付费网关可能返回 base64 的情况；解码失败再报错。
    buffer = Buffer.from(compact, 'base64');
  }
  if (!buffer.length) throw new Error('MiniMax 返回的音频解码为空');
  const info = sniffAudio(buffer);
  if (!info) throw new Error('返回的内容不是可识别的音频（支持 MP3/WAV/FLAC/OGG）');
  // 服务端理应尊重 audio_setting.format；不一致时按真实容器落盘更可靠（只会更准）。
  void expectedFormat;
  const format = info.format;
  return { buffer, format, ext: info.ext, mimeType: info.mimeType || MIME_BY_FORMAT[format] || 'application/octet-stream' };
}

/**
 * 调一次 MiniMax 语音合成（非流式）。
 *
 * 返回 { buffer, format, mimeType, latencyMs, model, voiceId, audioLengthMs,
 *        usageCharacters, audioSize, traceId }。
 * 只返回音频，不碰磁盘 —— 落盘由 saveVoiceFile 负责，这样测试可以只测网络层。
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {string} [opts.voiceId]
 * @param {object} [opts.gen]       socialV2.voice.generation（baseUrl/model/timeout 等）
 * @param {string} [opts.apiKey]    显式传入的 Key；缺省时从 gen/env 读
 * @param {Function} [opts.fetchImpl] 测试注入用
 * @param {AbortSignal} [opts.signal]
 */
export async function generateVoice({
  text,
  voiceId,
  emotion,
  speed,
  vol,
  pitch,
  languageBoost,
  format,
  sampleRate,
  bitrate,
  channel,
  maxChars,
  gen = {},
  apiKey,
  fetchImpl = fetch,
  signal
} = {}) {
  const merged = { ...VOICE_GEN_DEFAULTS, ...(gen && typeof gen === 'object' ? gen : {}) };
  const keyInfo = apiKey ? { key: String(apiKey).trim(), source: 'explicit' } : readApiKey(merged);
  if (!keyInfo.key) {
    const error = new Error('还没有配置 MiniMax API Key：在控制台「语音生成」面板填写，或设置 MINIMAX_API_KEY 环境变量');
    error.code = 'NO_API_KEY';
    throw error;
  }
  const baseUrl = normalizeBaseUrl(merged.baseUrl);
  const payload = buildVoicePayload({
    text,
    model: merged.model,
    voiceId: voiceId ?? merged.voiceId,
    emotion, speed, vol, pitch, languageBoost,
    format, sampleRate, bitrate, channel,
    maxChars: maxChars ?? merged.maxChars
  });
  const timeoutMs = clampTimeout(merged.timeoutMs);
  const started = Date.now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let res;
  try {
    res = await fetchImpl(`${baseUrl}/v1/t2a_v2`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${keyInfo.key}`
      },
      body: JSON.stringify(payload),
      signal: combined
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`MiniMax 语音合成超时（${Math.round(timeoutMs / 1000)} 秒）：网络到 ${baseUrl} 可能不通，或服务端排队`);
    }
    throw new Error(`连不上 MiniMax（${baseUrl}）：${error?.cause?.code || error?.code || error?.message || error}`);
  }

  const bodyText = await res.text().catch(() => '');
  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    throw new Error(`MiniMax 返回了非 JSON 响应（HTTP ${res.status}）：${bodyText.slice(0, 180)}`);
  }

  if (!res.ok) {
    const code = body?.base_resp?.status_code;
    const msg = body?.base_resp?.status_msg || body?.error?.message || body?.message || `HTTP ${res.status}`;
    throw new Error(Number.isFinite(Number(code)) && Number(code) !== 0
      ? describeMinimaxVoiceError(code, msg)
      : `MiniMax 语音请求失败（HTTP ${res.status}）：${msg}`);
  }

  const statusCode = Number(body?.base_resp?.status_code ?? 0);
  if (statusCode !== 0) {
    throw new Error(describeMinimaxVoiceError(statusCode, body?.base_resp?.status_msg));
  }
  const dataStatus = body?.data?.status;
  if (dataStatus !== undefined && Number(dataStatus) !== 2) {
    const error = new Error(`MiniMax 语音合成未完成（data.status=${dataStatus}），请稍后重试`);
    error.code = 'VOICE_NOT_READY';
    error.traceId = body?.trace_id ? String(body.trace_id) : '';
    throw error;
  }
  const decoded = decodeVoicePayload(body?.data?.audio, { expectedFormat: payload.audio_setting.format });
  if (decoded.url) {
    throw new Error('MiniMax 返回了音频 URL 而不是音频数据：当前实现只接受 hex/base64 的音频数据');
  }

  const extra = body?.extra_info ?? {};
  return {
    buffer: decoded.buffer,
    format: decoded.format,
    ext: decoded.ext,
    mimeType: decoded.mimeType || MIME_BY_FORMAT[decoded.format] || 'application/octet-stream',
    latencyMs: Date.now() - started,
    model: payload.model,
    voiceId: payload.voice_setting.voice_id,
    emotion: payload.voice_setting.emotion || '',
    audioLengthMs: Number(extra.audio_length) > 0 ? Number(extra.audio_length) : null,
    audioSize: Number(extra.audio_size) > 0 ? Number(extra.audio_size) : decoded.buffer.length,
    audioFormat: extra.audio_format ? String(extra.audio_format) : decoded.format,
    usageCharacters: Number(extra.usage_characters) > 0 ? Number(extra.usage_characters) : payload.text.length,
    traceId: body?.trace_id ? String(body.trace_id) : ''
  };
}

/** 拉取官方系统音色列表（控制台音色下拉用；不消耗合成额度）。 */
export async function fetchSystemVoices({ gen = {}, apiKey, fetchImpl = fetch, signal } = {}) {
  const merged = { ...VOICE_GEN_DEFAULTS, ...(gen && typeof gen === 'object' ? gen : {}) };
  const keyInfo = apiKey ? { key: String(apiKey).trim(), source: 'explicit' } : readApiKey(merged);
  if (!keyInfo.key) {
    const error = new Error('还没有配置 MiniMax API Key');
    error.code = 'NO_API_KEY';
    throw error;
  }
  const baseUrl = normalizeBaseUrl(merged.baseUrl);
  const res = await fetchImpl(`${baseUrl}/v1/get_voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${keyInfo.key}` },
    body: JSON.stringify({ voice_type: 'system' }),
    signal: signal ?? AbortSignal.timeout(20000)
  });
  const text = await res.text().catch(() => '');
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(`MiniMax 音色列表返回非 JSON（HTTP ${res.status}）`); }
  const statusCode = Number(body?.base_resp?.status_code ?? 0);
  if (!res.ok || statusCode !== 0) {
    throw new Error(describeMinimaxVoiceError(statusCode || res.status, body?.base_resp?.status_msg || `HTTP ${res.status}`));
  }
  const list = Array.isArray(body?.system_voice) ? body.system_voice : [];
  return list
    .filter((v) => v && typeof v.voice_id === 'string' && v.voice_id)
    .map((v) => ({
      id: v.voice_id,
      name: String(v.voice_name || v.voice_id),
      description: Array.isArray(v.description) ? v.description.join('；') : ''
    }));
}

/**
 * 把合成/下载到的音频写进语音库。
 *
 * 文件名带时间戳 + 随机后缀：方便按时间排查，也避免同名覆盖。
 * 权限 0600：语音内容属于聊天隐私，没必要让同机其它用户随便读。
 */
export function saveVoiceFile(buffer, dir, { format = 'mp3', prefix = 'mm', now = Date.now() } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('音频内容为空，拒绝落盘');
  const ext = EXT_BY_FORMAT[format] || 'mp3';
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const filename = `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer, { mode: 0o600 });
  return { path: filePath, filename, bytes: buffer.length, format, mimeType: MIME_BY_FORMAT[format] || 'audio/mpeg' };
}

/** 语音库里的音频文件名（给「找不到」错误做提示；只暴露文件名，不暴露绝对路径）。 */
export function listVoiceFiles(dir, { limit = 30 } = {}) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(mp3|wav|flac|ogg|oga|opus|m4a|aac|amr|silk|slk)$/i.test(f))
      .sort()
      .slice(-limit);
  } catch {
    return [];
  }
}

/** 生成失败时给模型看的错误文本：不夹带本机绝对路径。 */
export function describeVoiceGenerationFailure(error) {
  return String(error?.message ?? error ?? '未知错误');
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return VOICE_GEN_DEFAULTS.timeoutMs;
  return Math.min(300000, Math.max(10000, Math.round(n)));
}
