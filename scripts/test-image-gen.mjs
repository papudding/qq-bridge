// MiniMax 文生图客户端的离线回归（不联网、不烧额度）。
//
// 用本地 http server 冒充 MiniMax：既能验证请求体（model / aspect_ratio / response_format / n），
// 也能覆盖 base_resp 业务错误码与「HTTP 200 但返回非 JSON」这类真实网关故障。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  ASPECT_RATIOS,
  MAX_PROMPT_CHARS,
  buildImagePayload,
  decodeImagePayload,
  describeMinimaxError,
  generateImage,
  listImageFiles,
  maskApiKey,
  normalizeAspectRatio,
  normalizeBaseUrl,
  readApiKey,
  saveImageFile
} from '../src/image-gen.js';

// 1×1 透明 PNG（67 字节）：足够让 sniffImage 认出格式与尺寸，又不用引入图片库。
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let failures = 0;
async function test(name, run) {
  try {
    await run();
    console.log('PASS', name);
  } catch (error) {
    failures++;
    console.error('FAIL', name, '—', error?.stack ?? error);
  }
}

function startFakeMiniMax(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

await test('buildImagePayload 归一化 prompt / 画幅 / 默认参数', () => {
  const payload = buildImagePayload({ prompt: '  一只   蓝色鲸鱼\n在云上  ', aspectRatio: '16:9' });
  assert.equal(payload.prompt, '一只 蓝色鲸鱼 在云上');
  assert.equal(payload.aspect_ratio, '16:9');
  assert.equal(payload.model, 'image-01');
  assert.equal(payload.response_format, 'base64');
  assert.equal(payload.n, 1);
  assert.equal(payload.prompt_optimizer, true);
});

await test('buildImagePayload 拒绝空 prompt 与超长 prompt', () => {
  assert.throws(() => buildImagePayload({ prompt: '   ' }), /提示词不能为空/);
  assert.throws(() => buildImagePayload({ prompt: '啊'.repeat(MAX_PROMPT_CHARS + 1) }), /提示词太长/);
});

await test('normalizeAspectRatio 只接受官方画幅', () => {
  for (const ratio of ASPECT_RATIOS) assert.equal(normalizeAspectRatio(ratio), ratio);
  assert.equal(normalizeAspectRatio(''), '1:1');
  assert.throws(() => normalizeAspectRatio('5:4'), /不支持的画幅/);
});

await test('normalizeBaseUrl 去掉末尾斜杠并拒绝非 http(s)', () => {
  assert.equal(normalizeBaseUrl('https://api.minimax.cn/'), 'https://api.minimax.cn');
  assert.throws(() => normalizeBaseUrl('file:///etc/passwd'), /只支持 http/);
  assert.throws(() => normalizeBaseUrl('不是URL'), /不是合法 URL/);
});

await test('readApiKey 优先 config，其次环境变量', () => {
  assert.deepEqual(readApiKey({ apiKey: 'sk-config' }, {}), { key: 'sk-config', source: 'config' });
  assert.deepEqual(readApiKey({ apiKey: '', apiKeyEnv: 'MM_KEY' }, { MM_KEY: 'sk-env' }), { key: 'sk-env', source: 'env:MM_KEY' });
  assert.deepEqual(readApiKey({}, {}), { key: '', source: 'none' });
});

await test('maskApiKey 不回显完整 Key', () => {
  assert.equal(maskApiKey('sk-1234567890abcdef'), 'sk-1…cdef');
  assert.equal(maskApiKey('short'), '••••');
  assert.equal(maskApiKey(''), '');
});

await test('generateImage 成功：请求体正确、解析 base64 图片', async () => {
  let seen = null;
  const { server, baseUrl } = await startFakeMiniMax(async (req, res) => {
    seen = { url: req.url, auth: req.headers.authorization, body: await readJsonBody(req) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'trace-1',
      data: { image_base64: [PNG_1X1] },
      metadata: { success_count: 1, failed_count: 0 },
      base_resp: { status_code: 0, status_msg: 'success' }
    }));
  });
  try {
    const result = await generateImage({
      prompt: '一只蓝色鲸鱼',
      aspectRatio: '3:2',
      gen: { baseUrl, apiKey: 'sk-test', model: 'image-01' }
    });
    assert.equal(seen.url, '/v1/image_generation');
    assert.equal(seen.auth, 'Bearer sk-test');
    assert.equal(seen.body.aspect_ratio, '3:2');
    assert.equal(seen.body.response_format, 'base64');
    assert.equal(seen.body.n, 1);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].format, 'png');
    assert.equal(result.images[0].width, 1);
    assert.equal(result.images[0].height, 1);
    assert.equal(result.images[0].mimeType, 'image/png');
    assert.equal(result.traceId, 'trace-1');
  } finally {
    server.close();
  }
});

await test('generateImage 支持 image_urls 回退', async () => {
  const { server, baseUrl } = await startFakeMiniMax((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      data: { image_urls: ['https://example.invalid/a.jpg'] },
      base_resp: { status_code: 0 }
    }));
  });
  try {
    const result = await generateImage({ prompt: '测试', gen: { baseUrl, apiKey: 'sk-test' } });
    assert.deepEqual(result.urls, ['https://example.invalid/a.jpg']);
    assert.equal(result.images.length, 0);
  } finally {
    server.close();
  }
});

await test('generateImage 业务错误码 → 可读错误', async () => {
  const { server, baseUrl } = await startFakeMiniMax((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }));
  });
  try {
    await assert.rejects(
      () => generateImage({ prompt: '测试', gen: { baseUrl, apiKey: 'sk-test' } }),
      /额度\/余额不足（1008）/
    );
  } finally {
    server.close();
  }
});

await test('generateImage 非 JSON 响应（网关错误页）给出截断提示', async () => {
  const { server, baseUrl } = await startFakeMiniMax((req, res) => {
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>bad gateway</html>');
  });
  try {
    await assert.rejects(
      () => generateImage({ prompt: '测试', gen: { baseUrl, apiKey: 'sk-test' } }),
      /非 JSON 响应（HTTP 502）/
    );
  } finally {
    server.close();
  }
});

await test('generateImage 无 Key 时给 NO_API_KEY 而不是发请求', async () => {
  await assert.rejects(
    () => generateImage({ prompt: '测试', gen: { apiKey: '', apiKeyEnv: 'MISSING_KEY_XYZ' } }),
    (error) => error.code === 'NO_API_KEY' && /还没有配置 MiniMax API Key/.test(error.message)
  );
});

await test('decodeImagePayload 拒绝非图片字节', () => {
  assert.throws(() => decodeImagePayload(Buffer.from('not an image').toString('base64')), /不是可识别的图片/);
  assert.throws(() => decodeImagePayload(''), /空图片/);
});

await test('saveImageFile 落盘、扩展名与内容一致、文件名不冲突', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-image-test-'));
  try {
    const buffer = Buffer.from(PNG_1X1, 'base64');
    const a = saveImageFile(buffer, dir, { format: 'png', now: 1762000000000 });
    const b = saveImageFile(buffer, dir, { format: 'png', now: 1762000000000 });
    assert.ok(fs.existsSync(a.path));
    assert.match(a.filename, /^mm-\d{8}-\d{6}-[0-9a-f]{6}\.png$/);
    assert.notEqual(a.filename, b.filename);
    assert.deepEqual(fs.readFileSync(a.path), buffer);
    assert.deepEqual(listImageFiles(dir).sort(), [a.filename, b.filename].sort());
    assert.throws(() => saveImageFile(Buffer.alloc(0), dir), /内容为空/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('describeMinimaxError 保留原始信息', () => {
  assert.match(describeMinimaxError(2049, 'invalid api key'), /API Key 无效（2049）/);
  assert.match(describeMinimaxError(2049, 'invalid api key'), /invalid api key/);
  assert.match(describeMinimaxError(9999, 'weird'), /错误码 9999/);
});

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
