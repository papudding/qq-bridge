// 图片发送/生成的桥接层回归：在 audit harness 里跑真实 bridge.js，用假网关记录发出的段。
//
// 覆盖：
//   ① 图片库文件 → send_group_msg 的 image 段（base64://），并写进二代会话记录；
//   ② 省略扩展名能命中；路径穿越被拒绝；
//   ③ 超过 maxBytes 拒绝；
//   ④ http(s) 图片走 safeFetchBuffer（本测试注入桩，不联网）；
//   ⑤ 生成 → 落盘 images/ → 发送 → 统计计数；
//   ⑥ 没配 Key 时给出可读错误，且不发送；
//   ⑦ 图片频率上限独立计数（generateAndSend 内部 check + commit）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bufferToImage } from '../src/image-gen.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

// 1×1 透明 PNG。
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

const generatedImage = async () => ({
  images: [bufferToImage(PNG)],
  urls: [],
  failedCount: 0,
  traceId: 'fixture-trace',
  model: 'image-01',
  aspectRatio: '1:1',
  latencyMs: 7
});

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

async function makeBridge({ config = {}, globals = {} } = {}) {
  const baseImage = {
    enabled: true,
    maxBytes: 8 * 1024 * 1024,
    maxPerMinute: 10,
    maxPerHour: 100,
    generation: { enabled: true, apiKey: 'sk-fixture', baseUrl: 'http://fixture.invalid', timeoutMs: 30000 }
  };
  const wantSocialV2 = config.socialV2 || {};
  const image = {
    ...baseImage,
    ...(wantSocialV2.image || {}),
    generation: { ...baseImage.generation, ...((wantSocialV2.image || {}).generation || {}) }
  };
  const harness = await bridgeHarness({
    config: {
      ...config,
      socialV2: { ...wantSocialV2, image }
    },
    globals: { generateImage: generatedImage, ...globals }
  });
  harness.setReady(true);
  harness.setMode('reserved2');
  return harness;
}

function seedImage(harness, name = 'fixture.png') {
  const dir = path.join(harness.temp, 'images');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), PNG);
  return dir;
}

function lastSend(harness, action = 'send_group_msg') {
  return [...harness.calls.http].reverse().find((call) => call.url.endsWith('/' + action));
}

await test('图片库文件 → image 段（base64://）并写入会话记录', async () => {
  const h = await makeBridge();
  try {
    seedImage(h);
    const sent = await h.sendImageForV2('group:456', 'fixture.png', { guard: false });
    assert.equal(sent.messageId, 9001);
    assert.equal(sent.width, 1);
    assert.equal(sent.height, 1);
    assert.equal(sent.format, 'png');
    const call = lastSend(h);
    assert.equal(call.body.group_id, 456);
    const image = call.body.message.find((s) => s.type === 'image');
    assert.ok(image, '应该有 image 段');
    assert.ok(image.data.file.startsWith('base64://'), 'image 段应该是 base64://');
    assert.equal(Buffer.from(image.data.file.slice('base64://'.length), 'base64').length, PNG.length);
    const st = h.getSocialV2State('group:456');
    assert.ok(st.recentMessages.some((m) => String(m.text || '').includes('[图片')), '应记录到 recentMessages');
  } finally {
    await h.close();
  }
});

await test('省略扩展名命中图片库；路径穿越被拒绝', async () => {
  const h = await makeBridge();
  try {
    seedImage(h);
    const sent = await h.sendImageForV2('group:456', 'fixture', { guard: false });
    assert.equal(sent.format, 'png');
    await assert.rejects(
      () => h.sendImageForV2('group:456', '../state/sessions.json', { guard: false }),
      /「\.\.」|图片库里找不到/
    );
    await assert.rejects(
      () => h.sendImageForV2('group:456', '/etc/hosts', { guard: false }),
      /只能发图片库/
    );
  } finally {
    await h.close();
  }
});

await test('超过 maxBytes 的图片被拒绝', async () => {
  const h = await makeBridge();
  try {
    seedImage(h);
    h.cfg.socialV2.image.maxBytes = 10;
    await assert.rejects(
      () => h.sendImageForV2('group:456', 'fixture.png', { guard: false }),
      /图片太大/
    );
    assert.equal(lastSend(h), undefined, '被拒绝时不应该发出去');
  } finally {
    await h.close();
  }
});

await test('http(s) 图片走 safeFetchBuffer 并发出', async () => {
  let fetchedUrl = null;
  const h = await makeBridge({
    globals: {
      safeFetchBuffer: async (url) => {
        fetchedUrl = String(url);
        return { buffer: PNG, contentType: 'image/png' };
      }
    }
  });
  try {
    const sent = await h.sendImageForV2('group:456', 'https://cdn.example.com/a.png?sig=secret', { guard: false });
    assert.equal(fetchedUrl, 'https://cdn.example.com/a.png?sig=secret');
    assert.equal(sent.origin, 'url:cdn.example.com', 'origin 只应保留 host，不回显带签名的 URL');
    const image = lastSend(h).body.message.find((s) => s.type === 'image');
    assert.ok(image);
  } finally {
    await h.close();
  }
});

await test('生成 → 落盘 → 发送 → 统计计数', async () => {
  const h = await makeBridge();
  try {
    const before = h.imageStats().generated;
    const result = await h.generateAndSendImageForV2('group:456', { prompt: '一只蓝色鲸鱼' });
    assert.equal(result.generated.width, 1);
    assert.equal(result.generated.mimeType, 'image/png');
    assert.ok(fs.existsSync(result.generated.path), '生成结果应落盘');
    assert.ok(result.generated.path.startsWith(path.join(h.temp, 'images')), '应落在图片库目录');
    assert.equal(result.sent.messageId, 9001);
    assert.equal(h.imageStats().generated, before + 1);
    assert.equal(h.imageStats().lastOk, true);
    assert.equal(h.imageStats().lastSource, 'agent');
    // 统计必须真的落盘：只断言内存缓存会漏掉「常量未定义被 try/catch 吞掉」这类 bug。
    const statsFile = path.join(h.temp, 'state', 'image-stats.json');
    assert.ok(fs.existsSync(statsFile), 'image-stats.json 应写盘');
    assert.equal(JSON.parse(fs.readFileSync(statsFile, 'utf8')).generated, before + 1);
  } finally {
    await h.close();
  }
});

await test('没配 Key 时给可读错误且不发送', async () => {
  const h = await makeBridge({ config: { socialV2: { image: { generation: { apiKey: '' } } } } });
  try {
    await assert.rejects(
      () => h.generateAndSendImageForV2('group:456', { prompt: '测试' }),
      /还没有配置 MiniMax API Key/
    );
    assert.equal(lastSend(h), undefined);
    assert.equal(h.imageStats().lastOk, false);
    assert.match(h.imageStats().lastError, /MiniMax API Key/);
  } finally {
    await h.close();
  }
});

await test('生成失败记录错误并把可读原因抛给调用方', async () => {
  const h = await makeBridge({
    globals: {
      generateImage: async () => {
        const error = new Error('MiniMax 额度/余额不足（1008）：M Plan 套餐额度用完');
        throw error;
      }
    }
  });
  try {
    await assert.rejects(
      () => h.generateAndSendImageForV2('group:456', { prompt: '测试' }),
      /额度\/余额不足（1008）/
    );
    assert.equal(h.imageStats().lastOk, false);
    assert.match(h.imageStats().lastError, /1008/);
  } finally {
    await h.close();
  }
});

await test('图片频率上限独立计数', async () => {
  const h = await makeBridge({ config: { socialV2: { image: { maxPerMinute: 1, maxPerHour: 100 } } } });
  try {
    await h.generateAndSendImageForV2('group:456', { prompt: '第一张' });
    await assert.rejects(
      () => h.generateAndSendImageForV2('group:456', { prompt: '第二张' }),
      /每分钟最多 1 张/
    );
  } finally {
    await h.close();
  }
});

if (failures > 0) {
  console.error(`\n${failures} 个用例失败`);
  process.exit(1);
}
console.log('\n全部通过');
