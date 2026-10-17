/**
 * 推送与通知（设备令牌登记 + APNs 投递 + 角标 + 触发）的后端测试。
 *
 * 诚实前提：本机没有 Apple 开发者账号的 .p8 私钥，也没有真机令牌，所以这里**从不真的投递**。
 *  - JWT 用真 `crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })` 生成临时私钥签名，
 *    并用公钥真的 `crypto.verify` 验签（真加密、没有真实密钥）；
 *  - 发送一律注入假 `connect`，断言 URL / 头部 / 超时 / 401 / 410，不连 Apple；
 *  - 未配置时用注入的 connect 计数为 0 断言「任何发送入口都不产生网络调用」；
 *  - 集成部分单开子进程跑真实 Express + JSON 存储，只有网络出口是替身，地址一律 example.invalid。
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import http2 from 'node:http2';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-push-'));
process.env.DAYLIGHT_DATA_DIR = directory;
// 测试自己控制「有没有配置」：先把环境里的 APNs 变量清掉，避免宿主机配置泄进来。
for (const key of Object.keys(process.env)) if (key.startsWith('DAYLIGHT_APNS_')) delete process.env.DAYLIGHT_APNS_;

const settingsFile = () => path.join(directory, 'settings.json');
fs.writeFileSync(settingsFile(), JSON.stringify({
  activeMailboxId: 'default',
  mailboxes: [
    { id: 'default', provider: 'custom', email: 'sender@example.invalid', authorizationCode: 'invented-push-code',
      imapHost: 'imap.example.invalid', smtpHost: 'smtp.example.invalid', fromName: '合成发件人', signature: '' },
    { id: 'secondary', provider: 'custom', email: 'second@example.invalid', authorizationCode: 'invented-push-code-2',
      imapHost: 'imap.example.invalid', smtpHost: 'smtp.example.invalid', fromName: '合成发件人 2', signature: '' },
  ],
  baseUrl: '', apiKey: '', model: '',
}, null, 2));
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false }, mq: { enabled: false } }, null, 2));

const push = await import('./push.js');
const { readAssistantState, mutateAssistantState } = await import('./assistant-state.js');
const { checkReceipts, createReceipt } = await import('./receipts.js');
const { mailboxDirectory } = await import('./store.js');

const TOKEN = 'a1b2c3d4'.repeat(8); // 64 位十六进制（合成值，不是真机令牌）
const TOKEN_TAIL = '…c3d4';
const KEYS = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PRIVATE_PEM = KEYS.privateKey.export({ type: 'pkcs8', format: 'pem' });

function configuredConfig(overrides = {}) {
  return {
    configured: true, environment: 'sandbox', teamId: 'TEAM123456', keyId: 'KEY7890',
    privateKey: PRIVATE_PEM, bundleId: 'com.daylight.app', teamIdTail: '…3456', keyIdTail: '…7890', reason: '',
    ...overrides,
  };
}

function stateFile(mailboxId, namespace) {
  return path.join(mailboxDirectory(mailboxId), `assistant-${namespace}.json`);
}

function reset(...mailboxIds) {
  const ids = mailboxIds.length ? mailboxIds : ['default', 'secondary'];
  for (const id of ids) {
    for (const namespace of ['devices', 'receipts']) {
      const file = stateFile(id, namespace);
      for (const candidate of [file, `${file}.lock`, `${file}.postgres`]) if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
  }
}

const devices = async (mailboxId = 'default') => (await readAssistantState(mailboxId, 'devices')).items || [];
const deviceRecord = async (mailboxId = 'default') => (await devices(mailboxId))[0];

async function reject(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status, `${error.message} 的状态码`);
    assert.equal(error.code, code, `${error.message} 的错误码`);
    return true;
  });
}

/** 假 APNs 会话：把请求头和请求体全录下来，按脚本回状态码。绝不连网。 */
function fakeApns({ status = 200, body = '', hang = false } = {}) {
  const calls = [];
  const connect = () => {
    const client = new EventEmitter();
    client.close = () => { client.closed = true; };
    client.request = (headers) => {
      const stream = new EventEmitter();
      stream.headers = headers;
      stream._body = '';
      stream.setEncoding = () => {};
      stream.write = (chunk) => { stream._body += chunk; };
      stream.close = () => {};
      stream.end = () => {
        calls.push({ headers, body: stream._body });
        if (hang) return;
        setImmediate(() => {
          stream.emit('response', { ':status': status });
          if (body) stream.emit('data', body);
          stream.emit('end');
        });
      };
      return stream;
    };
    return client;
  };
  connect.calls = calls;
  return connect;
}

// ── 配置：没配置就说没配置 ───────────────────────────────────

test('APNs 配置归一：缺项就 configured:false 且 reason 明确，主机分 sandbox / production', () => {
  const missing = push.apnsConfigFrom({ env: {}, infra: {} });
  assert.equal(missing.configured, false);
  assert.match(missing.reason, /没有配置 APNs 密钥/);
  assert.match(missing.reason, /\.p8 密钥/);
  assert.match(missing.reason, /Key ID/);
  assert.match(missing.reason, /Team ID/);
  assert.match(missing.reason, /Bundle ID/);

  // 只给一部分也算没配全。
  const partial = push.apnsConfigFrom({ env: { DAYLIGHT_APNS_TEAM_ID: 'TEAM', DAYLIGHT_APNS_KEY_ID: 'KEY' }, infra: {} });
  assert.equal(partial.configured, false);
  assert.match(partial.reason, /缺少/);

  const ready = push.apnsConfigFrom({ env: {
    DAYLIGHT_APNS_TEAM_ID: 'TEAM123456', DAYLIGHT_APNS_KEY_ID: 'KEY7890',
    DAYLIGHT_APNS_PRIVATE_KEY: PRIVATE_PEM, DAYLIGHT_APNS_BUNDLE_ID: 'com.daylight.app',
    DAYLIGHT_APNS_ENVIRONMENT: 'sandbox',
  }, infra: {} });
  assert.equal(ready.configured, true);
  assert.equal(ready.environment, 'sandbox');
  assert.equal(ready.teamIdTail, '…3456');
  assert.equal(push.apnsHost('sandbox'), 'api.sandbox.push.apple.com');
  assert.equal(push.apnsHost('production'), 'api.push.apple.com');
  assert.equal(push.apnsHost('nonsense'), 'api.push.apple.com');
  // base64 里塞进来的 p8 也能还原。
  const base64 = push.apnsConfigFrom({ env: { DAYLIGHT_APNS_TEAM_ID: 'T', DAYLIGHT_APNS_KEY_ID: 'K',
    DAYLIGHT_APNS_PRIVATE_KEY: Buffer.from(PRIVATE_PEM).toString('base64'), DAYLIGHT_APNS_BUNDLE_ID: 'b' }, infra: {} });
  assert.equal(base64.configured, true);
});

test('未配置时：status 说没配置、test 返回 503、所有发送入口都不建连', async (t) => {
  reset();
  const connect = t.mock.method(http2, 'connect', () => assert.fail('未配置时不应该建立 APNs 连接'));

  const status = await push.pushStatus('default', { env: {}, infra: {} });
  assert.equal(status.configured, false);
  assert.match(status.reason, /没有配置 APNs 密钥/);
  assert.deepEqual(status.devices, []);
  assert.equal(status.lastAttempt, null);

  await reject(push.sendTestPush('default', {}, { env: {}, infra: {} }), 503, 'PUSH_NOT_CONFIGURED');

  // 登记一台设备，确认「有设备但没配置」同样是 no-op，而不是偷偷发出去。
  await push.registerDevice('default', { token: TOKEN });
  const unconfigured = push.apnsConfigFrom({ env: {}, infra: {} });
  assert.deepEqual(await push.notifyNewMail('default', { newCount: 3, unreadCount: 3, env: {}, infra: {} }),
    { sent: 0, failed: 0, results: [], skipped: true, configured: false });
  const dispatch = await push.dispatchPush('default', { env: {}, infra: {}, briefing: async () => ({ text: 'x' }) });
  assert.deepEqual(dispatch, { briefing: 0, receipts: 0, skipped: 1 });
  assert.deepEqual(await push.notifyOverdueReceipts('default', { env: {}, infra: {} }),
    { pushed: 0, failed: 0, skipped: 0, configured: false });
  const engine = push.createApnsSender({ config: unconfigured, connect });
  const outcome = await engine.send({ token: TOKEN, environment: 'sandbox' }, { aps: {} });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.configured, false);
  assert.equal(connect.mock.callCount(), 0, '任何发送入口都不能产生网络调用');
});

// ── 设备登记 ────────────────────────────────────────────────

test('设备登记：首次 / 重复只更新不新增 / mailboxIds 合并', async () => {
  reset();
  const first = await push.registerDevice('default', { token: TOKEN, platform: 'ios', locale: 'zh-CN' });
  assert.equal(first.device.tokenTail, TOKEN_TAIL);
  assert.equal(first.device.platform, 'ios');
  assert.equal(first.device.environment, 'production');
  assert.deepEqual(first.device.mailboxIds, ['default']);
  assert.ok(first.device.createdAt);
  assert.equal('token' in first.device, false, '对外形态绝不能带完整令牌');

  const again = await push.registerDevice('default', { token: TOKEN, environment: 'sandbox', mailboxIds: ['default', 'secondary'] });
  assert.equal((await devices()).length, 1, '重复登记不能产生第二条');
  assert.equal(again.device.id, first.device.id);
  assert.equal(again.device.environment, 'sandbox');
  assert.deepEqual(again.device.mailboxIds, ['default', 'secondary'], 'mailboxIds 做并集合并');
  // 再登记一次（只带 default）不能把已有邮箱缩掉。
  const merged = await push.registerDevice('default', { token: TOKEN });
  assert.deepEqual(merged.device.mailboxIds, ['default', 'secondary']);
  assert.equal(JSON.stringify(merged.device).includes(TOKEN), false);

  // 越权邮箱：合并请求里带不属于自己的邮箱一律 403。
  await reject(push.registerDevice('default', { token: TOKEN, mailboxIds: ['someone-elses'] }), 403, 'MAILBOX_FORBIDDEN');

  const removed = await push.removeDevice('default', TOKEN);
  assert.equal(removed.removed, true);
  assert.equal((await devices()).length, 0);
  assert.deepEqual(await push.removeDevice('default', TOKEN), { removed: false }, '删不掉也如实说');
});

test('令牌校验：缺失 / 非法一律显式错误码，错误消息不带令牌原文', async () => {
  reset();
  await reject(push.registerDevice('default', {}), 400, 'PUSH_DEVICE_REQUIRED');
  await reject(push.registerDevice('default', { token: '   ' }), 400, 'PUSH_DEVICE_REQUIRED');
  await reject(push.registerDevice('default', { token: 'zz' }), 400, 'PUSH_DEVICE_INVALID');
  await reject(push.registerDevice('default', { token: 'not hex!' }), 400, 'PUSH_DEVICE_INVALID');
  const long = 'a'.repeat(201);
  const error = await push.registerDevice('default', { token: long }).then(() => null, (failure) => failure);
  assert.equal(error.status, 400);
  assert.equal(error.message.includes(long), false, '错误消息不能回显完整令牌');
  await reject(push.registerDevice('default', { token: TOKEN, platform: 'android' }), 400, 'PUSH_DEVICE_INVALID');
  await reject(push.registerDevice('default', { token: TOKEN, environment: 'staging' }), 400, 'PUSH_DEVICE_INVALID');
  await reject(push.removeDevice('default', ''), 400, 'PUSH_DEVICE_REQUIRED');
  await reject(push.setClientBadge('default', 10000), 400, 'PUSH_BADGE_INVALID');
  await reject(push.setClientBadge('default', -1), 400, 'PUSH_BADGE_INVALID');
  await reject(push.setClientBadge('default', null), 400, 'PUSH_BADGE_INVALID');
  assert.deepEqual(await push.setClientBadge('default', 7), { badge: 7, updatedAt: (await readAssistantState('default', 'devices')).badgeUpdatedAt });
});

test('状态只有 tokenTail：响应、日志、错误里都没有完整令牌', async (t) => {
  reset();
  const logs = [];
  for (const name of ['log', 'warn', 'error']) t.mock.method(console, name, (...args) => { logs.push(args.map(String).join(' ')); });

  await push.registerDevice('default', { token: TOKEN });
  const status = await push.pushStatus('default', { env: {}, infra: {} });
  assert.equal(status.devices[0].tokenTail, TOKEN_TAIL);
  assert.equal(JSON.stringify(status).includes(TOKEN), false, 'status 里不能出现完整令牌');
  assert.equal(JSON.stringify(push.publicDevice((await devices())[0])).includes(TOKEN), false, '对外形态不能外带完整令牌');

  // 失败发送会写 lastError，同样不能带来令牌。
  const config = configuredConfig();
  const engine = push.createApnsSender({ config, connect: fakeApns({ status: 400, body: JSON.stringify({ reason: 'BadTopic' }) }) });
  await push.sendTestPush('default', {}, { config, sender: engine });
  const after = await push.pushStatus('default', { config });
  assert.equal(JSON.stringify(after).includes(TOKEN), false);
  assert.equal(after.devices[0].lastError, 'BadTopic');
  assert.equal(logs.join('\n').includes(TOKEN), false, '日志里也不能出现完整令牌');
});

test('角标：存客户端给的数，范围 0–9999，用于后续推送', async () => {
  reset();
  await push.registerDevice('default', { token: TOKEN });
  assert.deepEqual(await push.setClientBadge('default', 0), { badge: 0, updatedAt: (await readAssistantState('default', 'devices')).badgeUpdatedAt });
  assert.equal((await push.pushStatus('default', { env: {}, infra: {} })).badge, 0);
  const config = configuredConfig();
  const connect = fakeApns();
  const engine = push.createApnsSender({ config, connect, now: () => Date.parse('2026-10-18T09:00:00+08:00') });
  await push.sendTestPush('default', { title: '角标测试' }, { config, sender: engine });
  const sent = JSON.parse(connect.calls[0].body);
  assert.equal(sent.aps.badge, 0, '没有额外角标时应使用客户端当前角标');
});

// ── JWT ────────────────────────────────────────────────────

test('JWT：header/payload 正确、真 EC 公钥验签通过、同一小时复用跨小时重签', async () => {
  const config = configuredConfig();
  assert.deepEqual(push.buildJwtHeader({ keyId: 'KEY7890' }), { alg: 'ES256', kid: 'KEY7890' });
  assert.deepEqual(push.buildJwtPayload({ teamId: 'TEAM123456', issuedAt: 1000 }), { iss: 'TEAM123456', iat: 1000 });

  const fixed = Date.parse('2026-10-18T09:00:00+08:00');
  const connect = fakeApns();
  const engine = push.createApnsSender({ config, connect, now: () => fixed });
  await engine.send({ token: TOKEN, environment: 'sandbox' }, { aps: { alert: { title: 't', body: 'b' } } });
  const token = connect.calls[0].headers.authorization.replace(/^bearer /, '');
  const [encodedHeader, encodedPayload, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')), { alg: 'ES256', kid: 'KEY7890' });
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  assert.equal(payload.iss, 'TEAM123456');
  assert.equal(payload.iat, Math.floor(fixed / 1000));
  const verified = crypto.verify('sha256', Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key: KEYS.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'));
  assert.equal(verified, true, '必须能用公钥真的验签通过');

  // 同一小时内复用（即使 now 前进几分钟）。
  assert.equal(engine.bearerToken(fixed + 5 * 60_000), token);
  // 跨小时重签。
  assert.notEqual(engine.bearerToken(fixed + 2 * 3_600_000), token);
});

// ── 载荷 ───────────────────────────────────────────────────

test('buildApnsPayload：字段与角标夹取', () => {
  const payload = push.buildApnsPayload({ title: '标题', body: '正文', badge: 3, threadId: 'default',
    category: 'daylight-mail', data: { kind: 'mail' } });
  assert.deepEqual(payload, {
    aps: {
      alert: { title: '标题', body: '正文' }, badge: 3, sound: 'default',
      'thread-id': 'default', category: 'daylight-mail', 'interruption-level': 'active',
    },
    data: { kind: 'mail' },
  });
  assert.equal(push.buildApnsPayload({ badge: 100000 }).aps.badge, 9999);
  assert.equal(push.buildApnsPayload({ badge: -5 }).aps.badge, 0);
  assert.equal('badge' in push.buildApnsPayload({}).aps, false);
  assert.equal('category' in push.buildApnsPayload({}).aps, false);
  const silent = push.buildApnsPayload({ sound: '', interruptionLevel: '' });
  assert.equal('sound' in silent.aps, false);
  assert.equal('interruption-level' in silent.aps, false);
  assert.equal(push.publicDevice({ token: 'abcdef1234' }).tokenTail, '…1234');
  assert.equal(push.tokenTail(''), '');
});

// ── 发送：路径 / 头部 / 超时 / 401 / 410 ─────────────────────

test('发送：URL 含令牌、apns-topic 正确、410 标 invalid 后不再重发、lastError 落库', async () => {
  reset();
  const config = configuredConfig();
  const fake = fakeApns({ status: 410, body: JSON.stringify({ reason: 'Unregistered' }) });
  await push.registerDevice('default', { token: TOKEN, environment: 'sandbox' });
  const engine = push.createApnsSender({ config, connect: fake, now: () => Date.parse('2026-10-18T09:00:00+08:00') });

  const outcome = await push.sendTestPush('default', {}, { config, sender: engine });
  assert.equal(outcome.sent, 0);
  assert.equal(outcome.failed, 1);
  assert.deepEqual(outcome.results[0], { deviceId: (await deviceRecord()).id, tokenTail: TOKEN_TAIL, ok: false, status: 410, reason: 'Unregistered', tokenInvalid: true });

  const call = fake.calls[0];
  assert.equal(call.headers[':path'], `/3/device/${TOKEN}`);
  assert.equal(call.headers[':authority'], 'api.sandbox.push.apple.com');
  assert.equal(call.headers['apns-topic'], 'com.daylight.app');
  assert.equal(call.headers['apns-push-type'], 'alert');
  assert.equal(call.headers['apns-priority'], '10');
  assert.ok(Number(call.headers['apns-expiration']) > 0);

  const stored = await deviceRecord();
  assert.equal(stored.status, 'invalid');
  assert.equal(stored.lastError, 'Unregistered');
  const attempt = (await readAssistantState('default', 'devices')).lastAttempt;
  assert.equal(attempt.ok, false);
  assert.equal(attempt.error, 'Unregistered');

  // 死令牌不再重发：直接把整份记录交给 sendToDevices，invalid 会被跳过，连接数不增加。
  const records = await devices();
  const second = await push.sendToDevices('default', records, () => ({ aps: {} }), { config, sender: engine });
  assert.deepEqual(second.results, []);
  assert.equal(fake.calls.length, 1, '410 之后不再重发死令牌');
});

test('发送：401 不标 invalid（是 JWT / topic 问题，不是令牌失效）', async () => {
  reset();
  const config = configuredConfig();
  const fake = fakeApns({ status: 401, body: JSON.stringify({ reason: 'InvalidProviderToken' }) });
  await push.registerDevice('default', { token: TOKEN });
  const engine = push.createApnsSender({ config, connect: fake });
  const outcome = await push.sendTestPush('default', {}, { config, sender: engine });
  assert.equal(outcome.results[0].status, 401);
  assert.equal(outcome.results[0].reason, 'InvalidProviderToken');
  assert.equal((await deviceRecord()).status, 'active', '401 不能把设备判死');
  assert.equal((await deviceRecord()).lastError, 'InvalidProviderToken');
});

test('发送：超时有结构化结果、连接错误不抛出', async () => {
  reset();
  const config = configuredConfig();
  await push.registerDevice('default', { token: TOKEN });
  const hang = fakeApns({ hang: true });
  const engine = push.createApnsSender({ config, connect: hang, timeoutMs: 20 });
  const outcome = await engine.send({ token: TOKEN, environment: 'production' }, { aps: {} });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'TIMEOUT');
  assert.equal(outcome.status, 0);

  const boom = push.createApnsSender({ config, connect: () => { throw new Error('synthetic connect failure'); }, timeoutMs: 50 });
  const failed = await boom.send({ token: TOKEN }, { aps: {} });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'CONNECT_ERROR');
});

// ── 触发 ───────────────────────────────────────────────────

test('新邮件触发：有新邮件才推，载荷含数量/未读/角标/分类', async () => {
  reset();
  const config = configuredConfig();
  await push.registerDevice('default', { token: TOKEN, environment: 'sandbox' });
  const fake = fakeApns();
  const engine = push.createApnsSender({ config, connect: fake });

  const skipped = await push.notifyNewMail('default', { newCount: 0, unreadCount: 2, config, sender: engine });
  assert.equal(skipped.skipped, true);
  assert.equal(fake.calls.length, 0, '没有新邮件就不推');

  const outcome = await push.notifyNewMail('default', { newCount: 2, unreadCount: 5, config, sender: engine });
  assert.equal(outcome.sent, 1);
  assert.equal(fake.calls.length, 1);
  const payload = JSON.parse(fake.calls[0].body);
  assert.equal(payload.aps.alert.body, '收到 2 封新邮件 · 未读 5 封');
  assert.equal(payload.aps.badge, 5);
  assert.equal(payload.aps['thread-id'], 'default');
  assert.equal(payload.aps.category, 'daylight-mail');
});

test('早间简报：北京时间 08:00 后推、用「邮箱 + 北京日期」做幂等，一天只推一次', async () => {
  reset();
  const config = configuredConfig();
  await push.registerDevice('default', { token: TOKEN, environment: 'sandbox' });
  const fake = fakeApns();
  const engine = push.createApnsSender({ config, connect: fake });
  const at = Date.parse('2026-10-18T09:00:00+08:00');
  const briefing = async () => ({ text: '10月18日 周日 · 今天 1 个日程' });

  const first = await push.dispatchPush('default', { now: at, config, sender: engine, briefing });
  assert.deepEqual(first, { briefing: 1, receipts: 0, skipped: 0 });
  assert.equal(fake.calls.length, 1);
  const payload = JSON.parse(fake.calls[0].body);
  assert.equal(payload.aps.alert.body, '10月18日 周日 · 今天 1 个日程');
  assert.equal(payload.aps.category, 'daylight-briefing');

  const second = await push.dispatchPush('default', { now: at + 60_000, config, sender: engine, briefing });
  assert.equal(second.briefing, 0, '同一天第二次不再推');
  assert.ok(second.skipped >= 1);
  assert.equal(fake.calls.length, 1);

  // 第二天照样推。
  const nextDay = await push.dispatchPush('default', { now: at + 86_400_000, config, sender: engine, briefing });
  assert.equal(nextDay.briefing, 1);
  assert.equal(fake.calls.length, 2);
});

test('早间简报：08:00 之前不推', async () => {
  reset();
  const config = configuredConfig();
  await push.registerDevice('default', { token: TOKEN });
  const fake = fakeApns();
  const engine = push.createApnsSender({ config, connect: fake });
  const before = Date.parse('2026-10-18T07:00:00+08:00');
  const summary = await push.dispatchPush('default', { now: before, config, sender: engine, briefing: async () => ({ text: 'x' }) });
  assert.equal(summary.briefing, 0);
  assert.equal(fake.calls.length, 0);
});

test('超时触发：waiting→overdue 只推一次，回执本身行为不变，钩子抛错不影响', async () => {
  reset();
  const config = configuredConfig();
  await push.registerDevice('default', { token: TOKEN, environment: 'sandbox' });
  const fake = fakeApns();
  const engine = push.createApnsSender({ config, connect: fake });
  const DAY = 86_400_000;
  const sentMs = Date.now() - 2 * DAY;
  await createReceipt('default', {
    id: 'outbound-1', status: 'sent', messageId: '<daylight-outbound-1@example.invalid>',
    to: ['someone@example.invalid'], cc: [], subject: '合成主题', sentAt: new Date(sentMs).toISOString(),
  }, { awaitReplyDays: 1, now: sentMs });

  const store = { events: [], tasks: [], emails: [] };
  const notifyOverdue = (mailboxId, options) => push.notifyOverdueReceipts(mailboxId, { ...options, config, sender: engine });
  const first = await checkReceipts('default', { now: Date.now(), store, save: () => {}, notifyOverdue });
  assert.equal(first.overdue, 1, '回执照旧超时（既有行为不变）');
  assert.equal(store.tasks.length, 1, '超时待办照旧创建');
  assert.equal(store.tasks[0].source, 'mail-receipt');
  assert.equal(fake.calls.length, 1, '超时推一条');
  const payload = JSON.parse(fake.calls[0].body);
  assert.equal(payload.aps.alert.body, '等回信超时：合成主题');
  assert.equal(payload.aps.category, 'daylight-receipt');

  const receiptItem = (await readAssistantState('default', 'receipts')).items[0];
  assert.ok(receiptItem.notifiedOverdueAt, '在回执记录上标 notifiedOverdueAt');

  // 第二次不再推。
  const second = await checkReceipts('default', { now: Date.now(), store, save: () => {}, notifyOverdue });
  assert.equal(second.overdue, 0);
  assert.equal(fake.calls.length, 1, '同一条只推一次');

  // 钩子抛错：回执与待办照常，绝不被推送拖垮。
  reset('secondary');
  await mutateAssistantState('secondary', 'receipts', (data) => {
    data.items = [{ id: 'r-broken', subject: '钩子抛错的回执', status: 'waiting', sentAt: new Date(Date.now() - 2 * DAY).toISOString(),
      dueAt: new Date(Date.now() - DAY).toISOString(), to: [], cc: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }];
    return null;
  });
  const brokenStore = { events: [], tasks: [], emails: [] };
  const result = await checkReceipts('secondary', { now: Date.now(), store: brokenStore, save: () => {},
    notifyOverdue: () => { throw new Error('合成推送失败'); } });
  assert.equal(result.overdue, 1);
  assert.equal(brokenStore.tasks.length, 1);
  assert.equal((await readAssistantState('secondary', 'receipts')).items[0].status, 'overdue');
});

test('dispatchPush：简报到点 + 超时遗漏重推的汇总', async () => {
  reset();
  const config = configuredConfig();
  await push.registerDevice('default', { token: TOKEN });
  const fake = fakeApns();
  const engine = push.createApnsSender({ config, connect: fake });
  const at = Date.parse('2026-10-18T09:00:00+08:00');
  const summary = await push.dispatchPush('default', { now: at, config, sender: engine, briefing: async () => ({ text: '简报' }) });
  assert.deepEqual(summary, { briefing: 1, receipts: 0, skipped: 0 });

  // 没有设备时直接 skipped，不建连。
  reset('secondary');
  const empty = await push.dispatchPush('secondary', { now: at, config, sender: engine });
  assert.deepEqual(empty, { briefing: 0, receipts: 0, skipped: 1 });
});

// ── 路由级子进程集成 ────────────────────────────────────────

/**
 * 子进程内跑真实 Express + JSON 存储。只做两件事的替身：冻结 setInterval（去掉后台节拍），
 * 以及把 http2.connect 计数（未配置时任何推送入口都不该建连）。地址一律 example.invalid。
 */
async function servePushFixture(fixture) {
  const { mock } = await import('node:test');
  const { default: express } = await import('express');
  const http2 = await import('node:http2');
  let httpServer;
  let apnsConnects = 0;
  mock.timers.enable({ apis: ['setInterval'] });
  mock.method(globalThis, 'fetch', async () => { throw new Error('测试中不应该发起网络请求'); });
  mock.method(http2.default, 'connect', () => { apnsConnects += 1; throw new Error('测试中不应该连接 APNs'); });
  const listen = express.application.listen;
  mock.method(express.application, 'listen', function (...args) {
    const server = httpServer = listen.apply(this, args);
    server.once('listening', () => process.send({ port: server.address().port }));
    return server;
  });
  process.on('message', async (message) => {
    if (message.type === 'shutdown') {
      try {
        await new Promise((resolve, reject) => {
          httpServer.close((error) => error ? reject(error) : resolve());
          httpServer.closeAllConnections();
        });
        mock.timers.reset();
        mock.restoreAll();
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      } finally {
        process.disconnect();
      }
      return;
    }
    process.send({ apnsConnects });
  });
  process.argv.push('--production'); // 跳过 Vite dev server，DAYLIGHT_RUNTIME 仍是 local。
  await import(fixture.indexUrl);
}

async function pushFixture(t) {
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const data = fs.mkdtempSync(path.join(root, 'work', 'push-http-'));
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    activeMailboxId: 'default',
    mailboxes: [
      { id: 'default', provider: 'custom', email: 'sender@example.invalid', authorizationCode: 'invented-http-code',
        imapHost: 'imap.example.invalid', smtpHost: 'smtp.example.invalid', fromName: '合成发件人', signature: '' },
      { id: 'secondary', provider: 'custom', email: 'second@example.invalid', authorizationCode: 'invented-http-code-2',
        imapHost: 'imap.example.invalid', smtpHost: 'smtp.example.invalid', fromName: '合成发件人 2', signature: '' },
    ],
    baseUrl: '', apiKey: '', model: '', ragEnabled: false, fetchLimit: 15,
  }, null, 2));
  fs.writeFileSync(path.join(data, 'infra.json'), JSON.stringify({
    postgres: { enabled: false }, mq: { enabled: false },
    auth: { requireAuth: false, allowLocalDemoLogin: true, sessionDays: 14, jwtSecret: 'test', adminEmails: [] },
  }, null, 2));

  const env = { ...process.env, PORT: '0', DAYLIGHT_RUNTIME: 'local', DAYLIGHT_DATA_DIR: data,
    DAYLIGHT_REQUIRE_AUTH: '0', DAYLIGHT_AUTO_PROXY: '0' };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
    ...Object.keys(env).filter((key) => key.startsWith('DAYLIGHT_APNS_'))]) delete env[key];
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `(${servePushFixture.toString()})(${JSON.stringify({ indexUrl: new URL('./index.js', import.meta.url).href })}).catch(error => {
      console.error(error); process.exitCode = 1; if (process.connected) process.disconnect();
    })`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env });
  let output = '', exitResult, stopping;
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-16384); });
  const exited = new Promise((resolve) => {
    child.once('error', (error) => { exitResult = { error }; resolve(exitResult); });
    child.once('exit', (code, signal) => { exitResult = { code, signal }; resolve(exitResult); });
  });
  const failure = (message, result = exitResult) => new Error(
    `${message}; exitCode=${result?.code ?? 'pending'}, signal=${result?.signal ?? 'none'}\n${result?.error?.message || ''}\n${output}`);
  const nextMessage = () => new Promise((resolve, reject) => {
    if (exitResult) { reject(failure('Push API fixture already exited')); return; }
    const cleanup = () => { clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError); };
    const onMessage = (value) => { cleanup(); resolve(value); };
    const onExit = (code, signal) => { cleanup(); reject(failure('Push API fixture exited before replying', { code, signal })); };
    const onError = (error) => { cleanup(); reject(failure('Push API fixture process failed', { error })); };
    const timer = setTimeout(() => { cleanup(); reject(failure('Push API fixture did not reply within 15 seconds')); }, 15000);
    child.once('message', onMessage); child.once('exit', onExit); child.once('error', onError);
  });
  const send = (value) => new Promise((resolve, reject) => child.send(value, (error) => error ? reject(error) : resolve()));
  const command = async (message) => { const [response] = await Promise.all([nextMessage(), send(message)]); return response; };
  const stop = () => stopping ||= (async () => {
    let timer;
    try {
      if (!exitResult) await send({ type: 'shutdown' });
      const result = await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('Push API fixture did not shut down within 5 seconds')), 5000);
      })]);
      if (result.error || result.code !== 0 || result.signal) throw failure('Push API fixture exited unsuccessfully', result);
    } catch (error) {
      if (!exitResult) { child.kill(); await exited; }
      throw error;
    } finally { clearTimeout(timer); }
  })();
  t.after(stop);
  const { port } = await nextMessage();
  assert.ok(Number.isInteger(port) && port > 0, failure('Push API fixture returned an invalid port'));
  const request = async (route, method = 'GET', body, mailboxId) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(mailboxId ? { 'X-Mailbox-Id': mailboxId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { data, output: () => output, request, command };
}

test('HTTP：未配置下 status / 登记 / 重复登记 / 注销 / test / badge / dispatch 都按约定回答', async (t) => {
  const app = await pushFixture(t);

  const status = await app.request('/api/push/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.configured, false);
  assert.match(status.body.reason, /没有配置 APNs 密钥/);
  assert.deepEqual(status.body.devices, []);

  const registered = await app.request('/api/push/devices', 'POST', { token: TOKEN, platform: 'ios' });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.configured, false);
  assert.equal(registered.body.device.tokenTail, TOKEN_TAIL);
  assert.equal(JSON.stringify(registered.body).includes(TOKEN), false);

  const duplicated = await app.request('/api/push/devices', 'POST', { token: TOKEN, platform: 'ios' });
  assert.equal(duplicated.status, 201);
  assert.equal(duplicated.body.device.id, registered.body.device.id);
  const list = await app.request('/api/push/status');
  assert.equal(list.body.devices.length, 1);
  assert.equal(JSON.stringify(list.body).includes(TOKEN), false);

  // 非活跃但属于自己的邮箱放行；别人的邮箱 403。
  assert.equal((await app.request('/api/push/status', 'GET', undefined, 'secondary')).status, 200);
  const foreign = await app.request('/api/push/status', 'GET', undefined, 'someone-elses');
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.code, 'MAILBOX_FORBIDDEN');

  assert.equal((await app.request('/api/push/devices', 'POST', {})).body.code, 'PUSH_DEVICE_REQUIRED');
  assert.equal((await app.request('/api/push/devices', 'POST', { token: 'zz' })).body.code, 'PUSH_DEVICE_INVALID');

  const tested = await app.request('/api/push/test', 'POST', { title: 't', body: 'b' });
  assert.equal(tested.status, 503);
  assert.equal(tested.body.code, 'PUSH_NOT_CONFIGURED');

  const badge = await app.request('/api/push/badge', 'POST', { badge: 12 });
  assert.equal(badge.status, 200);
  assert.equal(badge.body.badge, 12);
  assert.equal((await app.request('/api/push/badge', 'POST', { badge: 100000 })).status, 400);

  const dispatch = await app.request('/api/push/dispatch', 'POST', {});
  assert.equal(dispatch.status, 200);
  assert.deepEqual(dispatch.body, { briefing: 0, receipts: 0, skipped: 1 });

  const removed = await app.request(`/api/push/devices?token=${TOKEN}`, 'DELETE');
  assert.equal(removed.status, 200);
  assert.equal(removed.body.removed, true);
  assert.equal((await app.request(`/api/push/devices?token=${TOKEN}`, 'DELETE')).body.removed, false);

  const { apnsConnects } = await app.command({ type: 'counts' });
  assert.equal(apnsConnects, 0, '整轮 HTTP 交互都没有真正连接 APNs');
});
