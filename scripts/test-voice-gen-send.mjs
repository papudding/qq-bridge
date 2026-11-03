// 语音生成/发送的桥接层回归：在 audit harness 里跑真实 bridge.js，用假网关记录发出的段。
//
// 覆盖：
//   ① 生成 → 落盘 audio/ → send_group_msg 的 record 段 → 会话记录 + 统计；
//   ② 引用/at 段的顺序（at → reply → record）；
//   ③ 没配 Key 时给出可读错误，且不发送；
//   ④ 语音生成开关关闭时拒绝；
//   ⑤ 文本过长在合成前就被拦下（不烧额度）；
//   ⑥ 语音频率上限独立计数（生成前检查 + 发送后记账）；
//   ⑦ 合成失败时统计失败数并原样抛出。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildVoicePayload } from '../src/voice-gen.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

// 最小 MP3 帧头 + 填充：足够被语音库/审计接受（真实 ffprobe 在 harness 里被桩掉）。
const MP3 = Buffer.concat([Buffer.from('fffb9064', 'hex'), Buffer.alloc(512, 0)]);

/** 与真实 generateVoice 一样先做文本/参数校验，再返回固定音频（不联网、不烧额度）。 */
async function generatedVoice(opts = {}) {
  buildVoicePayload({
    text: opts.text,
    voiceId: opts.voiceId,
    emotion: opts.emotion,
    speed: opts.speed,
    vol: opts.vol,
    pitch: opts.pitch,
    format: opts.format,
    sampleRate: opts.sampleRate,
    bitrate: opts.bitrate,
    channel: opts.channel,
    maxChars: opts.maxChars
  });
  if (opts.failWith) throw new Error(opts.failWith);
  return {
    buffer: MP3,
    format: 'mp3',
    ext: 'mp3',
    mimeType: 'audio/mpeg',
    latencyMs: 7,
    model: opts.gen?.model || 'speech-2.8-hd',
    voiceId: opts.voiceId || 'female-shaonv',
    emotion: opts.emotion || '',
    audioLengthMs: 1500,
    audioSize: MP3.length,
    audioFormat: 'mp3',
    usageCharacters: 12,
    traceId: 'fixture-trace'
  };
}

/** 真 ffprobe 在这个沙箱里不跑；桩成"能解析"，返回可读时长。 */
async function fakeInspectAudio(file, { maxBytes } = {}) {
  const stat = fs.statSync(file);
  if (stat.size === 0) return { ok: false, error: '空文件' };
  if (maxBytes && stat.size > maxBytes) return { ok: false, error: '音频过大' };
  return { ok: true, size: stat.size, duration: 1.5, codec: 'mp3', sampleRate: 32000, channels: 1, warnings: [] };
}

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

async function makeBridge({ voice = {}, globals = {} } = {}) {
  const baseVoice = {
    enabled: true,
    prefer: true,
    maxPerMinute: 10,
    maxPerHour: 100,
    generation: {
      enabled: true,
      apiKey: 'sk-fixture',
      baseUrl: 'http://fixture.invalid',
      model: 'speech-2.8-hd',
      voiceId: 'female-shaonv',
      maxChars: 200,
      timeoutMs: 30000
    }
  };
  const want = voice || {};
  const merged = {
    ...baseVoice,
    ...want,
    generation: { ...baseVoice.generation, ...(want.generation || {}) }
  };
  const harness = await bridgeHarness({
    config: { socialV2: { voice: merged } },
    globals: {
      generateVoice: generatedVoice,
      inspectAudio: fakeInspectAudio,
      ...globals
    }
  });
  harness.setReady(true);
  harness.setMode('reserved2');
  return harness;
}

function lastSend(harness, action = 'send_group_msg') {
  return [...harness.calls.http].reverse().find((call) => call.url.endsWith('/' + action));
}

function audioDir(harness) {
  return path.join(harness.temp, 'audio');
}

await test('生成 → 落盘 → 发 record 段 → 记录会话与统计', async () => {
  const h = await makeBridge();
  try {
    const { generated, sent } = await h.generateAndSendVoiceForV2('group:456', { text: '你好呀，今天过得怎么样？' });
    assert.match(generated.filename, /^mm-\d{8}-\d{6}-[0-9a-f]{6}\.mp3$/);
    assert.ok(fs.existsSync(path.join(audioDir(h), generated.filename)), '音频落到语音库');
    assert.equal(generated.duration, 1.5);
    assert.equal(generated.voiceId, 'female-shaonv');

    const send = lastSend(h);
    assert.ok(send, '应该调用 send_group_msg');
    const segments = send.body.message;
    assert.equal(segments.length, 1, '无引用/at 时只有一个 record 段');
    assert.equal(segments[0].type, 'record');
    // 网关可能在另一台机器（SSH 隧道），所以语音必须内联 base64:// 而不是本地路径。
    assert.match(segments[0].data.file, /^base64:\/\//);
    assert.equal(Buffer.from(segments[0].data.file.slice('base64://'.length), 'base64').length, MP3.length);
    assert.equal(sent.messageId, 9001);
    assert.equal(sent.verification?.confirmed, true, 'get_msg 回读到 record 段');

    const stats = h.voiceStats();
    assert.equal(stats.generated, 1);
    assert.equal(stats.sent, 1);
    assert.equal(stats.lastVoiceId, 'female-shaonv');
    assert.equal(stats.lastDurationSec, 1.5);
    assert.equal(stats.lastOk, true);
    // 统计落盘（不是只留在内存）
    const raw = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'voice-stats.json'), 'utf8'));
    assert.equal(raw.generated, 1);
  } finally {
    await h.close();
  }
});

await test('引用 + @ 的段顺序：at → reply → record', async () => {
  const h = await makeBridge();
  try {
    await h.generateAndSendVoiceForV2('group:456', { text: '回你一句', replyToMessageId: 12345, atUserId: 111111 });
    const send = lastSend(h);
    const types = send.body.message.map((s) => s.type);
    assert.deepEqual(types, ['at', 'reply', 'record']);
    assert.equal(send.body.message[0].data.qq, '111111');
    assert.equal(send.body.message[1].data.id, '12345');
  } finally {
    await h.close();
  }
});

await test('私聊带 atUserId 会被拒绝（不发送）', async () => {
  const h = await makeBridge();
  try {
    const before = h.calls.http.length;
    await assert.rejects(
      () => h.generateAndSendVoiceForV2('private:123', { text: '私聊', atUserId: 111111 }),
      /私聊不能 @ 人/
    );
    const sends = h.calls.http.slice(before).filter((c) => c.url.endsWith('/send_private_msg'));
    assert.equal(sends.length, 0, '不应该真的发出私聊消息');
  } finally {
    await h.close();
  }
});

await test('没配 Key 时给可读错误且不发送', async () => {
  const h = await makeBridge({ voice: { generation: { apiKey: '', apiKeyEnv: 'NO_SUCH_ENV_XYZ' } } });
  try {
    const before = h.calls.http.length;
    const error = await h.generateAndSendVoiceForV2('group:456', { text: '你好' }).catch((e) => e);
    assert.equal(error?.code, 'NO_API_KEY');
    assert.match(error.message, /API Key/);
    assert.equal(h.voiceStats().generated, 0);
    assert.equal(h.voiceStats().failed, 1);
    const sends = h.calls.http.slice(before).filter((c) => c.url.endsWith('/send_group_msg'));
    assert.equal(sends.length, 0, '没 Key 不能发');
  } finally {
    await h.close();
  }
});

await test('语音生成开关关闭时拒绝', async () => {
  const h = await makeBridge({ voice: { generation: { enabled: false } } });
  try {
    await assert.rejects(
      () => h.generateAndSendVoiceForV2('group:456', { text: '你好' }),
      /语音生成已关闭/
    );
  } finally {
    await h.close();
  }
});

await test('文本过长在合成前被拦下（不烧额度、不发送）', async () => {
  const h = await makeBridge({ voice: { generation: { maxChars: 20 } } });
  try {
    const before = h.calls.http.length;
    await assert.rejects(
      () => h.generateAndSendVoiceForV2('group:456', { text: '这句话明显超过二十个字的限制了吧？'.repeat(3) }),
      /语音文本太长/
    );
    assert.equal(h.voiceStats().generated, 0);
    const sends = h.calls.http.slice(before).filter((c) => c.url.endsWith('/send_group_msg'));
    assert.equal(sends.length, 0);
  } finally {
    await h.close();
  }
});

await test('语音频率上限独立计数', async () => {
  const h = await makeBridge({ voice: { maxPerMinute: 1, maxPerHour: 10 } });
  try {
    await h.generateAndSendVoiceForV2('group:456', { text: '第一条' });
    await assert.rejects(
      () => h.generateAndSendVoiceForV2('group:456', { text: '第二条' }),
      /语音发送频率超限/
    );
  } finally {
    await h.close();
  }
});

await test('合成失败时统计失败数并原样抛出', async () => {
  const h = await makeBridge({
    globals: {
      generateVoice: async (opts) => {
        await generatedVoice({ ...opts, failWith: 'MiniMax 限流（1002）：请求太频繁' });
      }
    }
  });
  try {
    await assert.rejects(
      () => h.generateAndSendVoiceForV2('group:456', { text: '你好' }),
      /限流/
    );
    assert.equal(h.voiceStats().generated, 0);
    assert.equal(h.voiceStats().failed, 1);
    assert.match(h.voiceStats().lastError, /限流/);
  } finally {
    await h.close();
  }
});

await test('voiceCfg 装配默认值：prefer / generation / 音色参数', async () => {
  const h = await makeBridge();
  try {
    const vc = h.voiceCfg();
    assert.equal(vc.enabled, true);
    assert.equal(vc.prefer, true);
    assert.equal(vc.generation.model, 'speech-2.8-hd');
    assert.equal(vc.generation.voiceId, 'female-shaonv');
    assert.equal(vc.generation.format, 'mp3');
    assert.equal(vc.generation.maxChars, 200);
    assert.equal(vc.generation.keySource, 'config');
  } finally {
    await h.close();
  }
});

await test('唤醒提示词注入「语音优先」，关闭 prefer 后不注入', async () => {
  const h = await makeBridge();
  try {
    const prompt = h.buildWakePromptV2('group:456', 'message');
    assert.match(prompt, /【语音优先】/);
    assert.match(prompt, /qq_gen_voice/);
  } finally {
    await h.close();
  }
  const h2 = await makeBridge({ voice: { prefer: false } });
  try {
    assert.doesNotMatch(h2.buildWakePromptV2('group:456', 'message'), /【语音优先】/);
  } finally {
    await h2.close();
  }
});

if (failures > 0) {
  console.error(`\n${failures} 个语音生成/发送用例失败`);
  process.exit(1);
}
console.log('\n语音生成/发送（桥接层）：全部通过');
