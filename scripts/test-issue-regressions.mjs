// GitHub issue 回归：把上游 issue 里**已确认可复现**的缺陷钉死，防止回退。
//
// 覆盖：
//   #22 控制台切模式被 5 秒轮询改回去 —— DSH 0.2.0-rc.2 的 settings/update 只写 user 层，
//       同进程内 describe().value 不更新；读取必须 user 优先、value 回退。
//   #11/#19/#23/#26 回合结束信号丢了 → 会话永久 busy —— 回合判忙改为「起始时间 + 15 分钟租约」，
//       无起始时间的残留 collector 不再判忙；collector 保留，迟到回复照常 flush。
//   #29 被 @ 了不理人 —— 机器人昵称/QQ 号必须写进唤醒 prompt（否则 agent 把 @自己 当 @别人）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const KEY = 'group:1001';
const SID = 'session-1';

await test('#22 settingFromDshNamespace：user 层优先、value 回退', async () => {
  const h = await bridgeHarness();
  try {
    const f = h.settingFromDshNamespace;
    assert.equal(f({ value: { mode: 'reserved2' }, user: { mode: 'chat' } }, 'mode'), 'chat', 'user 层必须优先');
    assert.equal(f({ value: { mode: 'reserved2' }, user: {} }, 'mode'), 'reserved2', 'user 为空时回退 value');
    assert.equal(f({ value: { mode: 'reserved2' } }, 'mode'), 'reserved2', '没有 user 键时回退 value');
    assert.equal(f({ user: { ownerQQ: '' }, value: { ownerQQ: '123' } }, 'ownerQQ'), '', '空串也是显式值');
    assert.equal(f(undefined, 'mode'), undefined);
    assert.equal(f({ value: null }, 'mode'), undefined);
  } finally { await h.close(); }
});

await test('#22 refreshMode 采纳控制台刚写入的 user 层（否则 5 秒后被改回去）', async () => {
  const h = await bridgeHarness();
  try {
    h.api.settings.describe = async () => ({
      result: { ok: true, value: {
        namespaces: [
          { ns: 'qq-mode', value: { mode: 'reserved2', ownerQQ: '10001' }, user: { mode: 'chat' } }
        ]
      } }
    });
    await h.refreshMode();
    assert.equal(h.getMode(), 'chat', '必须读 user 层，而不是未热更新的 value');

    // 老行为兜底：从没在控制台写过（user 为空）时仍读 value。
    h.api.settings.describe = async () => ({
      result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'reserved' }, user: {} }] } }
    });
    await h.refreshMode();
    assert.equal(h.getMode(), 'reserved');

    // ownerQQ：user 层空串表示「不覆盖 config.json」。
    h.cfg.ownerQQ = 20002;
    h.api.settings.describe = async () => ({
      result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'chat', ownerQQ: 30003 }, user: { ownerQQ: '' } }] } }
    });
    await h.refreshMode();
    assert.equal(h.cfg.ownerQQ, 20002, 'user 层空串不得把 config.json 的 ownerQQ 抹掉');

    h.api.settings.describe = async () => ({
      result: { ok: true, value: { namespaces: [{ ns: 'qq-mode', value: { mode: 'chat' }, user: { ownerQQ: '40004' } }] } }
    });
    await h.refreshMode();
    assert.equal(h.cfg.ownerQQ, 40004, 'user 层显式 ownerQQ 必须生效');
  } finally { await h.close(); }
});

await test('#11/#19 回合判忙：无起始时间的残留 collector 不再永久 busy', async () => {
  const h = await bridgeHarness();
  try {
    h.state.sessions[KEY] = SID;
    const st = h.getSocialV2State(KEY);
    const collector = { push() { return true; }, size() { return 1; } };

    assert.equal(h.isConversationBusyV2(KEY, st), false, '空状态不忙');

    h.collectors.set(SID, collector);
    assert.equal(h.isConversationBusyV2(KEY, st), false, '只有 collector、没有起始时间 → 不判忙（旧版这里永久忙）');

    h.v2TurnStartAt.set(SID, Date.now());
    assert.equal(h.isConversationBusyV2(KEY, st), true, '回合刚开始必须判忙');

    h.v2TurnStartAt.set(SID, Date.now() - (h.TURN_BUSY_LEASE_MS + 60_000));
    assert.equal(h.isConversationBusyV2(KEY, st), false, '超过租约必须解除忙碌');
    assert.equal(h.collectors.has(SID), true, '租约过期不能丢掉 collector（迟到回复仍要 flush）');

    h.v2TurnStartAt.delete(SID);
    h.collectors.delete(SID);
    h.v2TurnStartAt.set(SID, Date.now());
    assert.equal(h.isConversationBusyV2(KEY, st), true, '只有起始时间（collector 还没建）也算回合在进行');

    h.promptQueues.set(KEY, { running: true, queue: [] });
    assert.equal(h.isConversationBusyV2(KEY, st), true, 'prompt 在途仍算忙');
  } finally { await h.close(); }
});

await test('#29 唤醒 prompt 必须写明机器人自己的昵称与 QQ 号', async () => {
  const h = await bridgeHarness();
  try {
    h.setSelfIdentity('樰', '10001');
    const line = h.selfIdentityTextV2();
    assert.match(line, /【你的身份】/);
    assert.match(line, /樰/);
    assert.match(line, /10001/);
    assert.match(line, /@樰/, '必须明确「@昵称」指的是自己');

    const prompt = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(prompt, /【你的身份】/, '每次唤醒都要带身份（它是 agent 唯一能对上号的地方）');
    assert.match(prompt, /@樰/);
    assert.match(prompt, /10001/);

    const reminder = h.buildWakeReminderPromptV2(KEY);
    assert.match(reminder, /【你的身份】/, '收尾提醒也要带身份');

    h.setSelfIdentity('', '');
    assert.equal(h.selfIdentityTextV2(), '', '身份未知时不注入空行（不能写「你的昵称是（）」）');
    assert.doesNotMatch(h.buildWakePromptV2(KEY, 'timeout'), /【你的身份】/);
  } finally { await h.close(); }
});

await test('#29 账号昵称≠群昵称：身份提示要带群昵称，被叫群昵称也算 nameMention', async () => {
  const h = await bridgeHarness();
  try {
    h.setSelfIdentity('账号昵称示例', '10001');
    // 走真实刷新路径：群昵称由 get_group_member_info 提供（夹具返回「群昵称示例」）
    assert.equal(await h.refreshSelfGroupNameV2(KEY), true, '应能从夹具网关取到群昵称');
    assert.equal(h.selfGroupNameV2(KEY), '群昵称示例');

    const line = h.selfIdentityTextV2(KEY);
    assert.match(line, /账号昵称示例/, '账号昵称要保留');
    assert.match(line, /群昵称示例/, '群昵称必须写进身份提示（消息里 @ 段渲染的是它）');
    assert.match(line, /@群昵称示例/, '必须说明「@群昵称」指的是自己');
    assert.match(line, /10001/);

    const prompt = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(prompt, /【你的身份】/);
    assert.match(prompt, /群昵称示例/, '每次唤醒的身份提示都要带群昵称');

    // 群里 @ 渲染出来就是群昵称文本：只叫群昵称也必须触发 nameMention
    const st = h.getSocialV2State(KEY);
    // 概率触发是随机项，会掩盖「不该唤醒」的断言，这里钉成 0。
    st.wakeConfig.triggers.probability = 0;
    const reasonOf = (text) => h.evaluateWakeTriggerV2(KEY, st, {}, 'group', text, text, false);
    assert.equal(reasonOf('@群昵称示例 在吗'), 'nameMention', '@群昵称必须算叫自己');
    assert.equal(reasonOf('群昵称示例 出来'), 'nameMention', '直接叫群昵称必须算叫自己');
    assert.equal(reasonOf('今天天气不错'), null, '没叫自己、没关键词时不能误唤醒');

    // 私聊没有群昵称：退回账号昵称，不能把别的群昵称串进来
    const priv = h.selfIdentityTextV2('private:10001');
    assert.match(priv, /账号昵称示例/);
    assert.doesNotMatch(priv, /群昵称示例/);
  } finally { await h.close(); }
});

await test('#角色卡注入：reserved2 唤醒提示必须带人格卡正文（旧实现只给角色名）', async () => {
  const h = await bridgeHarness({
    files: {
      'roles/测试人格.md': '# 测试人格\n\n- 性格：偏执、只认一个称呼。\n- 称呼：叫他「宝宝」。\n',
      'state/current-role.json': JSON.stringify({ role: '测试人格', mode: 'active' }),
    },
  });
  try {
    const prompt = h.buildWakePromptV2(KEY, 'atMention');
    assert.match(prompt, /【当前角色】测试人格/);
    assert.match(prompt, /叫他「宝宝」/, '人格卡正文必须进唤醒提示，否则模型只知道名字、按预设即兴发挥');
    assert.doesNotMatch(
      prompt,
      /完整角色卡请调用 qq_get_prompt 查看/,
      '不能只留「请调用 qq_get_prompt」——实测模型不会去调，人设等于没注入',
    );

    // 收尾提醒发生在同一回合内（刚看过全卡），按 #118 的节奏只点名角色、不重复整张卡；
    // 「换卡/新会话必须重新全量」由 scripts/test-role-injection-cadence.mjs 覆盖。
    const reminder = h.buildWakeReminderPromptV2(KEY);
    assert.match(reminder, /【当前角色】测试人格/, '收尾提醒仍须点名当前角色');
    assert.doesNotMatch(reminder, /叫他「宝宝」/, '同一回合内不重复整张人格卡（省 token）');

    // 没有启用角色时不得凭空注入空段落
    const plain = await bridgeHarness({ files: { 'state/current-role.json': JSON.stringify({ role: null, mode: 'active' }) } });
    try {
      assert.doesNotMatch(plain.buildWakePromptV2(KEY, 'atMention'), /【当前角色】/);
    } finally { await plain.close(); }
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过');
}
