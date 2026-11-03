// MiniMax 语音合成客户端的离线回归（不联网、不烧额度）。
//
// 用本地 http server 冒充 MiniMax：既能验证请求体（model / text / voice_setting / audio_setting /
// output_format），也能覆盖 base_resp 业务错误码、「HTTP 200 但返回非 JSON」这类真实网关故障。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_VOICE_TEXT_CHARS,
  VOICE_EMOTIONS,
  VOICE_GEN_DEFAULTS,
  buildVoicePayload,
  decodeVoicePayload,
  describeMinimaxVoiceError,
  fetchSystemVoices,
  generateVoice,
  listVoiceFiles,
  normalizeAudioFormat,
  normalizeEmotion,
  normalizeSpeed,
  normalizeVoiceId,
  normalizeVoiceOptions,
  normalizeVoiceText,
  saveVoiceFile,
  sniffAudio
} from '../src/voice-gen.js';

// 最小 MP3 帧头（0xFF 0xFB 0x90 0x64）+ 填充：足够让 sniffAudio 认出 MP3，无需真实音频库。
const MP3 = Buffer.concat([Buffer.from('fffb9064', 'hex'), Buffer.alloc(120, 0)]);
const MP3_HEX = MP3.toString('hex');

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

function okBody(extra = {}) {
  return JSON.stringify({
    data: { audio: MP3_HEX, status: 2 },
    extra_info: {
      audio_length: 1500,
      audio_sample_rate: 32000,
      audio_size: MP3.length,
      bitrate: 128000,
      word_count: 8,
      usage_characters: 8,
      audio_format: 'mp3',
      audio_channel: 1
    },
    trace_id: 'trace-voice-1',
    base_resp: { status_code: 0, status_msg: 'success' },
    ...extra
  });
}

await test('normalizeVoiceText 洗掉 Markdown / 代码块 / URL，并压缩空白', () => {
  const raw = '**你好**呀！\n\n```js\nconsole.log(1)\n```\n看这个 https://example.com/a?b=1 和 [链接](https://x.invalid) `代码`';
  const text = normalizeVoiceText(raw);
  assert.ok(!text.includes('**'), '去掉加粗标记');
  assert.ok(!text.includes('console.log'), '代码块整段丢弃');
  assert.ok(!text.includes('https://'), 'URL 被去掉');
  assert.ok(text.includes('你好') && text.includes('链接'), '保留正文与链接文字');
  assert.ok(!/\n/.test(text), '换行压成空格');
});

await test('normalizeVoiceText 拒绝空文本与超长文本', () => {
  assert.throws(() => normalizeVoiceText('   '), /不能为空/);
  assert.throws(() => normalizeVoiceText('```\ncode\n```'), /不能为空/);
  assert.throws(() => normalizeVoiceText('啊'.repeat(MAX_VOICE_TEXT_CHARS + 1)), /太长/);
  // maxChars 可覆盖
  assert.throws(() => normalizeVoiceText('一二三四五', 4), /上限 4 字/);
});

await test('buildVoicePayload 默认值正确', () => {
  const p = buildVoicePayload({ text: '你好呀' });
  assert.equal(p.model, 'speech-2.8-hd');
  assert.equal(p.stream, false);
  assert.equal(p.output_format, 'hex');
  assert.equal(p.language_boost, 'auto');
  assert.deepEqual(p.voice_setting, { voice_id: 'female-shaonv', speed: 1, vol: 1, pitch: 0 });
  assert.deepEqual(p.audio_setting, { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 });
  assert.equal(p.text, '你好呀');
});

await test('buildVoicePayload 带音色/情绪/语速等参数', () => {
  const p = buildVoicePayload({ text: '测试', voiceId: 'Chinese (Mandarin)_Sweet_Lady', emotion: 'happy', speed: 1.3, vol: 2, pitch: 2, format: 'wav', sampleRate: 44100, bitrate: 256000, channel: 2, model: 'speech-02-hd' });
  assert.equal(p.voice_setting.voice_id, 'Chinese (Mandarin)_Sweet_Lady');
  assert.equal(p.voice_setting.emotion, 'happy');
  assert.equal(p.voice_setting.speed, 1.3);
  assert.equal(p.audio_setting.format, 'wav');
  assert.equal(p.audio_setting.sample_rate, 44100);
  assert.equal(p.audio_setting.bitrate, 256000);
  assert.equal(p.audio_setting.channel, 2);
  assert.equal(p.model, 'speech-02-hd');
});

await test('参数校验：非法情绪/语速/音色/模型都给人话', () => {
  assert.throws(() => buildVoicePayload({ text: 'x', emotion: 'excited' }), /不支持的情绪/);
  assert.throws(() => buildVoicePayload({ text: 'x', speed: 9 }), /语速 speed 超出范围/);
  assert.throws(() => buildVoicePayload({ text: 'x', vol: 0 }), /音量 vol 超出范围/);
  assert.throws(() => buildVoicePayload({ text: 'x', pitch: 20 }), /音调 pitch 超出范围/);
  assert.throws(() => buildVoicePayload({ text: 'x', voiceId: '/etc/passwd' }), /非法字符/);
  assert.throws(() => buildVoicePayload({ text: 'x', model: '../evil' }), /model「..\/evil」不合法|model/);
  for (const e of VOICE_EMOTIONS) assert.equal(normalizeEmotion(e), e);
  assert.equal(normalizeEmotion(''), '');
  assert.equal(normalizeSpeed(0.5), 0.5);
  assert.equal(normalizeVoiceId(''), VOICE_GEN_DEFAULTS.voiceId);
  assert.equal(normalizeAudioFormat('MP3'), 'mp3');
  assert.throws(() => normalizeAudioFormat('aac'), /不支持的音频格式/);
});

await test('normalizeVoiceOptions 一次性归一 + maxChars 收敛', () => {
  const opts = normalizeVoiceOptions({ speed: '1.2', vol: '3', voiceId: 'female-tianmei', maxChars: 999999 });
  assert.equal(opts.speed, 1.2);
  assert.equal(opts.vol, 3);
  assert.equal(opts.voiceId, 'female-tianmei');
  assert.equal(opts.maxChars, 5000);
  assert.equal(opts.format, 'mp3');
  assert.equal(opts.emotion, '');
});

await test('sniffAudio 识别常见容器，垃圾字节返回 null', () => {
  assert.equal(sniffAudio(MP3)?.format, 'mp3');
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(16)]);
  assert.equal(sniffAudio(wav)?.format, 'wav');
  const flac = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(16)]);
  assert.equal(sniffAudio(flac)?.format, 'flac');
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(16)]);
  assert.equal(sniffAudio(ogg)?.format, 'ogg');
  assert.equal(sniffAudio(Buffer.from('not audio')), null);
  assert.equal(sniffAudio(Buffer.alloc(2)), null);
});

await test('decodeVoicePayload 支持 hex / base64 / URL，拒绝垃圾', () => {
  assert.equal(decodeVoicePayload(MP3_HEX).buffer.length, MP3.length);
  assert.equal(decodeVoicePayload(Buffer.from(MP3).toString('base64')).buffer.length, MP3.length);
  assert.equal(decodeVoicePayload('https://x.invalid/a.mp3').url, 'https://x.invalid/a.mp3');
  assert.throws(() => decodeVoicePayload(''), /空音频/);
  assert.throws(() => decodeVoicePayload(Buffer.from('garbage!').toString('base64')), /不是可识别的音频/);
});

await test('describeMinimaxVoiceError 翻译错误码并保留原始信息', () => {
  assert.match(describeMinimaxVoiceError(1002), /限流/);
  assert.match(describeMinimaxVoiceError(1008), /额度/);
  assert.match(describeMinimaxVoiceError(2049), /Key 无效/);
  assert.match(describeMinimaxVoiceError(9999, 'weird'), /9999/);
  assert.match(describeMinimaxVoiceError(9999, 'weird'), /weird/);
});

await test('saveVoiceFile 落盘命名 / 权限 / 大小，listVoiceFiles 可列出', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-voice-gen-'));
  const saved = saveVoiceFile(MP3, dir, { format: 'mp3', prefix: 'mm' });
  assert.match(saved.filename, /^mm-\d{8}-\d{6}-[0-9a-f]{6}\.mp3$/);
  assert.equal(saved.bytes, MP3.length);
  assert.equal(fs.statSync(saved.path).size, MP3.length);
  assert.equal(fs.statSync(saved.path).mode & 0o777, 0o600);
  assert.deepEqual(listVoiceFiles(dir), [saved.filename]);
  // 非音频不列
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  assert.deepEqual(listVoiceFiles(dir), [saved.filename]);
  assert.throws(() => saveVoiceFile(Buffer.alloc(0), dir), /内容为空/);
  fs.rmSync(dir, { recursive: true, force: true });
});

await test('generateVoice 成功：请求体正确、解析 hex 音频与元信息', async () => {
  let seen = null;
  const { server, baseUrl } = await startFakeMiniMax(async (req, res) => {
    seen = { url: req.url, auth: req.headers.authorization, body: await readJsonBody(req) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(okBody());
  });
  try {
    const result = await generateVoice({
      text: '你好，我是小鲸鱼',
      voiceId: 'female-tianmei',
      emotion: 'happy',
      gen: { baseUrl, apiKey: 'sk-voice-test', model: 'speech-2.8-hd' }
    });
    assert.equal(seen.url, '/v1/t2a_v2');
    assert.equal(seen.auth, 'Bearer sk-voice-test');
    assert.equal(seen.body.model, 'speech-2.8-hd');
    assert.equal(seen.body.text, '你好，我是小鲸鱼');
    assert.equal(seen.body.voice_setting.voice_id, 'female-tianmei');
    assert.equal(seen.body.voice_setting.emotion, 'happy');
    assert.equal(seen.body.output_format, 'hex');
    assert.equal(seen.body.audio_setting.format, 'mp3');
    assert.equal(result.format, 'mp3');
    assert.equal(result.buffer.length, MP3.length);
    assert.equal(result.audioLengthMs, 1500);
    assert.equal(result.usageCharacters, 8);
    assert.equal(result.voiceId, 'female-tianmei');
    assert.equal(result.traceId, 'trace-voice-1');
    assert.ok(result.latencyMs >= 0);
  } finally {
    server.close();
  }
});

await test('generateVoice 业务错误码（HTTP 200 + base_resp!=0）转成人话', async () => {
  const { server, baseUrl } = await startFakeMiniMax(async (req, res) => {
    await readJsonBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: {}, base_resp: { status_code: 1008, status_msg: 'quota exceeded' } }));
  });
  try {
    await assert.rejects(
      () => generateVoice({ text: '测试', gen: { baseUrl, apiKey: 'sk-test' } }),
      (error) => /额度/.test(error.message) && /quota exceeded/.test(error.message)
    );
  } finally {
    server.close();
  }
});

await test('generateVoice 非 JSON 响应/空音频都给可读错误', async () => {
  const bad = await startFakeMiniMax(async (req, res) => {
    await readJsonBody(req);
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>bad gateway</html>');
  });
  try {
    await assert.rejects(
      () => generateVoice({ text: '测试', gen: { baseUrl: bad.baseUrl, apiKey: 'sk-test' } }),
      /非 JSON 响应/
    );
  } finally {
    bad.server.close();
  }

  const empty = await startFakeMiniMax(async (req, res) => {
    await readJsonBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: { audio: '', status: 2 }, base_resp: { status_code: 0 } }));
  });
  try {
    await assert.rejects(
      () => generateVoice({ text: '测试', gen: { baseUrl: empty.baseUrl, apiKey: 'sk-test' } }),
      /空音频/
    );
  } finally {
    empty.server.close();
  }
});

await test('generateVoice 没配 Key 时给 NO_API_KEY 可读错误', async () => {
  const error = await generateVoice({ text: '测试', gen: { apiKey: '', apiKeyEnv: 'NO_SUCH_ENV_XYZ' } }).catch((e) => e);
  assert.equal(error?.code, 'NO_API_KEY');
  assert.match(error.message, /API Key/);
});

await test('fetchSystemVoices 解析 system_voice 列表并翻译错误', async () => {
  const { server, baseUrl } = await startFakeMiniMax(async (req, res) => {
    const body = await readJsonBody(req);
    assert.equal(req.url, '/v1/get_voice');
    assert.equal(body.voice_type, 'system');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      system_voice: [
        { voice_id: 'female-shaonv', voice_name: '少女音色', description: [] },
        { voice_id: 'Chinese (Mandarin)_Sweet_Lady', voice_name: '甜美女声', description: ['温柔'] }
      ],
      base_resp: { status_code: 0, status_msg: 'success' }
    }));
  });
  try {
    const list = await fetchSystemVoices({ gen: { baseUrl, apiKey: 'sk-test' } });
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'female-shaonv');
    assert.equal(list[1].name, '甜美女声');
    assert.equal(list[1].description, '温柔');
  } finally {
    server.close();
  }

  const bad = await startFakeMiniMax(async (req, res) => {
    await readJsonBody(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ base_resp: { status_code: 2049, status_msg: 'invalid api key' } }));
  });
  try {
    await assert.rejects(
      () => fetchSystemVoices({ gen: { baseUrl: bad.baseUrl, apiKey: 'sk-bad' } }),
      /Key 无效/
    );
  } finally {
    bad.server.close();
  }
});

if (failures > 0) {
  console.error(`\n${failures} 个语音生成用例失败`);
  process.exit(1);
}
console.log('\n语音生成客户端：全部通过');
