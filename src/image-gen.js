// image-gen.js —— MiniMax 文生图客户端 + 图片落盘（bridge.js 与离线测试共用）。
//
// 为什么单独成文件：
//   桥接主文件已经 8000 行，把「构造请求 / 解析响应 / 错误码翻译 / 落盘」拆出来后，
//   测试可以起一个本地 HTTP server 冒充 MiniMax，不需要真烧额度，也不需要跑起整个桥接。
//
// 官方接口（2026-11 按 platform.minimax.cn 文档核对）：
//   POST {baseUrl}/v1/image_generation
//   Authorization: Bearer <M Plan API Key 或按量付费 Key>
//   请求：{ model:'image-01', prompt, aspect_ratio, response_format:'base64', n:1, prompt_optimizer }
//   成功：{ data:{ image_base64:[...] }, metadata:{ success_count, failed_count }, id,
//           base_resp:{ status_code:0 } }
//   业务失败：HTTP 200 + base_resp.status_code != 0
//            （1002 限流 / 1004 鉴权 / 1008 余额 / 1026 敏感内容 / 2013 参数 / 2049 Key 无效）
//
// 国内站 baseUrl = https://api.minimax.cn，国际站 = https://api.minimax.io。
// baseUrl 做成配置项：同一份代码能跑两个站，测试时也能指向 http://127.0.0.1:xxxx。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sniffImage } from './media-normalize.js';

/** 官方支持的画幅（image-01）。 */
export const ASPECT_RATIOS = Object.freeze(['1:1', '16:9', '4:3', '3:2', '2:3', '3:4', '9:16', '21:9']);

/** 官方 prompt 上限 1500 字；这里用同一个数，超了直接给可读错误而不是让服务端 2013。 */
export const MAX_PROMPT_CHARS = 1500;

/** 图片生成配置的默认值（会与 config.json 的 socialV2.image.generation 深度合并）。 */
export const IMAGE_GEN_DEFAULTS = Object.freeze({
  enabled: true,
  baseUrl: 'https://api.minimax.cn',
  apiKey: '',
  apiKeyEnv: 'MINIMAX_API_KEY',
  model: 'image-01',
  aspectRatio: '1:1',
  promptOptimizer: true,
  timeoutMs: 180000
});

const MIME_BY_FORMAT = Object.freeze({
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif'
});

const EXT_BY_FORMAT = Object.freeze({
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
  gif: 'gif'
});

const MINIMAX_ERROR_HINTS = Object.freeze({
  1002: 'MiniMax 限流（1002）：请求太频繁，等一会儿再试',
  1004: 'MiniMax 鉴权失败（1004）：检查 API Key 是否填错、是否与站点匹配（国内站用 api.minimax.cn，国际站用 api.minimax.io）',
  1008: 'MiniMax 额度/余额不足（1008）：M Plan 套餐额度用完、或未订阅；到控制台 Plan 页看剩余用量',
  1026: '提示词触发了 MiniMax 内容安全（1026）：换个说法再试',
  2013: 'MiniMax 参数不合法（2013）：检查提示词/画幅等参数',
  2049: 'MiniMax API Key 无效（2049）：重新复制 M Plan API Key（注意不要混用标准按量付费 Key）'
});

/** 取 Key：优先 config.json，其次环境变量（launchd 可以在 plist 里注入）。 */
export function readApiKey(gen = {}, env = process.env) {
  const direct = String(gen.apiKey ?? '').trim();
  if (direct) return { key: direct, source: 'config' };
  const envName = String(gen.apiKeyEnv ?? '').trim() || 'MINIMAX_API_KEY';
  const fromEnv = String(env[envName] ?? '').trim();
  if (fromEnv) return { key: fromEnv, source: `env:${envName}` };
  return { key: '', source: 'none' };
}

/** 只给控制台看的状态用，绝不把完整 Key 回显给前端/模型。 */
export function maskApiKey(key) {
  const s = String(key ?? '');
  if (!s) return '';
  if (s.length <= 8) return '••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * baseUrl 归一：去掉末尾斜杠并校验协议。
 * 允许 http 是为了本地假服务器/自建反代；真正的 MiniMax 两端都是 https。
 */
export function normalizeBaseUrl(value, fallback = IMAGE_GEN_DEFAULTS.baseUrl) {
  const raw = String(value ?? '').trim() || fallback;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`MiniMax baseUrl 不是合法 URL：${raw}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('MiniMax baseUrl 只支持 http(s)');
  }
  return raw.replace(/\/+$/, '');
}

/** 画幅校验；空值回落默认值，非法值直接报错（不静默改成 1:1）。 */
export function normalizeAspectRatio(value, fallback = IMAGE_GEN_DEFAULTS.aspectRatio) {
  const s = String(value ?? '').trim();
  if (!s) return fallback;
  if (!ASPECT_RATIOS.includes(s)) {
    throw new Error(`不支持的画幅「${s}」，可选：${ASPECT_RATIOS.join('、')}`);
  }
  return s;
}

/**
 * 构造请求体（纯函数，便于单测）。
 * prompt 里的换行/连续空白压成单空格：MiniMax 不认格式，压缩后还能省几个 token。
 */
export function buildImagePayload({ prompt, aspectRatio, model, promptOptimizer } = {}) {
  const text = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('图片提示词不能为空');
  if (text.length > MAX_PROMPT_CHARS) {
    throw new Error(`图片提示词太长（${text.length} 字，上限 ${MAX_PROMPT_CHARS} 字）`);
  }
  return {
    model: String(model || IMAGE_GEN_DEFAULTS.model),
    prompt: text,
    aspect_ratio: normalizeAspectRatio(aspectRatio),
    response_format: 'base64',
    n: 1,
    prompt_optimizer: promptOptimizer !== false
  };
}

/** 把 base_resp.status_code 翻译成人话；未知码也带上原始信息，别让模型/人瞎猜。 */
export function describeMinimaxError(statusCode, statusMsg = '') {
  const code = Number(statusCode);
  const hint = MINIMAX_ERROR_HINTS[code];
  const suffix = statusMsg ? `（原始信息：${statusMsg}）` : '';
  if (hint) return `${hint}${suffix}`;
  return `MiniMax 返回错误码 ${Number.isFinite(code) ? code : '?'}${suffix}`;
}

/** 把一段 base64 解成图片并识别格式；不是图片就抛错（防止把 HTML 错误页当图发出去）。 */
export function decodeImagePayload(base64) {
  const raw = String(base64 ?? '').replace(/\s/g, '');
  if (!raw) throw new Error('MiniMax 返回了空图片');
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw new Error('MiniMax 返回的图片 base64 解码为空');
  return bufferToImage(buffer);
}

/** Buffer → { buffer, format, width, height, mimeType }，格式认不出直接拒绝。 */
export function bufferToImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('图片内容为空');
  const info = sniffImage(buffer);
  if (!info) throw new Error('返回的内容不是可识别的图片（支持 JPEG/PNG/WebP/GIF）');
  return {
    buffer,
    format: info.format,
    width: info.width,
    height: info.height,
    mimeType: MIME_BY_FORMAT[info.format] || 'application/octet-stream'
  };
}

/**
 * 调一次 MiniMax 文生图。
 *
 * 返回 { images:[{buffer,format,width,height,mimeType}], urls:[], failedCount, traceId,
 *        model, aspectRatio, latencyMs }。
 * 只返回图片，不碰磁盘 —— 落盘由 saveImageFile 负责，这样测试可以只测网络层。
 *
 * @param {object} opts
 * @param {string} opts.prompt
 * @param {string} [opts.aspectRatio]
 * @param {object} [opts.gen]       socialV2.image.generation（baseUrl/model/timeout）
 * @param {string} [opts.apiKey]    显式传入的 Key；缺省时从 gen/env 读
 * @param {Function} [opts.fetchImpl] 测试注入用
 * @param {AbortSignal} [opts.signal]
 */
export async function generateImage({ prompt, aspectRatio, gen = {}, apiKey, fetchImpl = fetch, signal } = {}) {
  const merged = { ...IMAGE_GEN_DEFAULTS, ...gen };
  const keyInfo = apiKey ? { key: String(apiKey).trim(), source: 'explicit' } : readApiKey(merged);
  if (!keyInfo.key) {
    const error = new Error('还没有配置 MiniMax API Key：在控制台「图片生成」面板填写，或设置 MINIMAX_API_KEY 环境变量');
    error.code = 'NO_API_KEY';
    throw error;
  }
  const baseUrl = normalizeBaseUrl(merged.baseUrl);
  const payload = buildImagePayload({
    prompt,
    aspectRatio: aspectRatio ?? merged.aspectRatio,
    model: merged.model,
    promptOptimizer: merged.promptOptimizer
  });
  const timeoutMs = clampTimeout(merged.timeoutMs);
  const started = Date.now();
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  let res;
  try {
    res = await fetchImpl(`${baseUrl}/v1/image_generation`, {
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
      throw new Error(`MiniMax 文生图超时（${Math.round(timeoutMs / 1000)} 秒）：网络到 api.minimax.cn 可能不通，或服务端排队`);
    }
    throw new Error(`连不上 MiniMax（${baseUrl}）：${error?.cause?.code || error?.code || error?.message || error}`);
  }

  const bodyText = await res.text().catch(() => '');
  let body = {};
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    // 非 JSON 多半是网关 HTML 错误页；截一小段给排错用，别把整页塞进上下文。
    throw new Error(`MiniMax 返回了非 JSON 响应（HTTP ${res.status}）：${bodyText.slice(0, 180)}`);
  }

  if (!res.ok) {
    const code = body?.base_resp?.status_code;
    const msg = body?.base_resp?.status_msg || body?.error?.message || body?.message || `HTTP ${res.status}`;
    throw new Error(Number.isFinite(Number(code)) && Number(code) !== 0
      ? describeMinimaxError(code, msg)
      : `MiniMax 请求失败（HTTP ${res.status}）：${msg}`);
  }

  const statusCode = Number(body?.base_resp?.status_code ?? 0);
  if (statusCode !== 0) {
    throw new Error(describeMinimaxError(statusCode, body?.base_resp?.status_msg));
  }

  const base64List = Array.isArray(body?.data?.image_base64) ? body.data.image_base64 : [];
  const urls = Array.isArray(body?.data?.image_urls) ? body.data.image_urls.filter((u) => typeof u === 'string' && u) : [];
  const images = base64List.map((b64) => decodeImagePayload(b64)).filter(Boolean);
  if (!images.length && !urls.length) {
    const failed = Number(body?.metadata?.failed_count ?? 0);
    throw new Error(failed > 0
      ? `MiniMax 没有返回图片（${failed} 张被内容安全拦截），换个说法再试`
      : 'MiniMax 没有返回图片（响应里既没有 image_base64 也没有 image_urls）');
  }

  return {
    images,
    urls,
    failedCount: Number(body?.metadata?.failed_count ?? 0) || 0,
    traceId: body?.id ? String(body.id) : '',
    model: payload.model,
    aspectRatio: payload.aspect_ratio,
    latencyMs: Date.now() - started
  };
}

/**
 * 把生成/下载到的图片写进图片库。
 *
 * 文件名带时间戳 + 随机后缀：既方便按时间排查，也避免同名覆盖（并发生成时尤其重要）。
 * 权限 0600：图片虽然不是密钥，但没必要让同机其它用户随便读聊天里要发的内容。
 */
export function saveImageFile(buffer, dir, { format = 'jpeg', prefix = 'mm', now = Date.now() } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('图片内容为空，拒绝落盘');
  const ext = EXT_BY_FORMAT[format] || 'jpg';
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const filename = `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}.${ext}`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, buffer, { mode: 0o600 });
  return { path: filePath, filename, bytes: buffer.length, format };
}

/** 图片库文件名列表（给「找不到」错误做提示；只暴露文件名，不暴露绝对路径）。 */
export function listImageFiles(dir, { limit = 30 } = {}) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.(jpe?g|png|webp|gif)$/i.test(f))
      .sort()
      .slice(-limit);
  } catch {
    return [];
  }
}

/** 生成失败时给模型看的错误文本：不夹带本机绝对路径。 */
export function describeGenerationFailure(error) {
  return String(error?.message ?? error ?? '未知错误');
}

function clampTimeout(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return IMAGE_GEN_DEFAULTS.timeoutMs;
  return Math.min(300000, Math.max(10000, Math.round(n)));
}
