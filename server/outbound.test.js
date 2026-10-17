/**
 * 出站邮件（手写回复 / 定时发送 / 撤销发送 / 已发送留档）的后端测试。
 *
 * 全程只连本地合成对象：SMTP 用 mock 的 nodemailer.createTransport，IMAP 用假的 clientFactory，
 * 地址一律 example.invalid。发信与 IMAP 写指令只发到内存里的记录里，不碰真邮箱。
 */
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import nodemailer from 'nodemailer';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-outbound-'));
process.env.DAYLIGHT_DATA_DIR = directory;

const mailbox = {
  id: 'default', provider: 'custom', email: 'sender@example.invalid',
  authorizationCode: 'invented-outbound-code',
  imapHost: 'imap.example.invalid', imapPort: 993, imapSecure: true,
  smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpSecure: true,
  fromName: '合成发件人', signature: '合成签名\n产品团队',
};

function writeSettings(overrides = {}) {
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
    activeMailboxId: 'default', mailboxes: [{ ...mailbox, ...overrides }],
    baseUrl: '', apiKey: '', model: '',
  }, null, 2));
}
writeSettings();
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false }, mq: { enabled: false } }, null, 2));

const {
  appendSignatureText, buildOutboundMessage, buildReplyDraft, cancelOutbound, composeOutbound,
  dispatchDueOutbound, listOutbound, markOutboundSentNow, parseMailRecipients, publicOutbound,
  readOutbound, replySubject,
} = await import('./outbound.js');
const { appendMailboxMessage, resolveMailFolder } = await import('./agent.js');
const { mutateAssistantState, readAssistantState } = await import('./assistant-state.js');
const { readSettings, normalizeMailbox } = await import('./store.js');

function settings(overrides = {}) {
  const current = readSettings();
  return { ...current, mailboxes: current.mailboxes.map((item) => ({ ...item, ...overrides })) };
}

function reset() {
  const file = path.join(directory, 'assistant-outbound.json');
  for (const candidate of [file, `${file}.lock`, `${file}.postgres`]) if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
}

/** 派发的默认替身：默认测试里绝不允许真的连 IMAP，所有派发都要带上它。 */
const noImap = {
  listFolders: async () => [{ path: '已发送', flags: ['\\Sent'] }],
  compileRaw: async () => Buffer.from('合成 MIME'),
  appendSent: async () => ({ ok: true, folder: '已发送' }),
};

const items = async () => (await readAssistantState('default', 'outbound')).items;
const one = async () => (await items())[0];

async function waitFor(check) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await delay(5);
  }
  assert.fail('合成发信未在预期时间内开始');
}

async function reject(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status, `${error.message} 的状态码`);
    assert.equal(error.code, code, `${error.message} 的错误码`);
    return true;
  });
}

function fakeImap({ folders = [{ path: 'INBOX' }, { path: '已发送', flags: ['\\Sent'] }], fail = null } = {}) {
  const calls = [];
  return {
    calls,
    clientFactory: () => ({
      async connect() {},
      async getMailboxLock() { return { release() {} }; },
      async logout() {},
      async *list() { for (const folder of folders) yield folder; },
      async append(folder, raw) {
        if (fail) throw fail;
        calls.push({ folder, bytes: Buffer.from(raw).length });
        return { uid: 1 };
      },
    }),
  };
}

// ── 写邮件：撤销窗口与输入校验 ────────────────────────────────

test('默认进入 10 秒撤销窗口：只落库、状态 scheduled、绝不连 SMTP', async (t) => {
  reset();
  const lookup = t.mock.method(dns, 'lookup', () => assert.fail('写邮件时不应该解析 SMTP 域名'));
  const transport = t.mock.method(nodemailer, 'createTransport', () => assert.fail('写邮件时不应该创建 SMTP 连接'));
  const before = Date.now();
  const { outbound } = await composeOutbound('default', { to: 'someone@example.invalid', subject: '合成主题', body: '合成正文' });
  assert.equal(outbound.status, 'scheduled');
  assert.equal(outbound.source, 'compose');
  assert.equal(outbound.messageId, null);
  const offset = Date.parse(outbound.sendAt) - before;
  assert.ok(offset >= 9_000 && offset <= 11_000, `默认撤销窗口约 10 秒，实际 ${offset}ms`);
  assert.match(outbound.body, /合成正文\n\n合成签名\n产品团队/);
  assert.equal(outbound.signature, mailbox.signature);
  assert.equal(lookup.mock.callCount(), 0);
  assert.equal(transport.mock.callCount(), 0);
  // 到点前派发什么也不做。
  const summary = await dispatchDueOutbound({ now: Date.parse(outbound.sendAt) - 1_000 });
  assert.deepEqual(summary, { attempted: 0, sent: 0, failed: 0, unknown: 0, reaped: 0 });
});

test('收件人解析与输入校验都显式带错误码', async () => {
  reset();
  const parsed = await composeOutbound('default', { to: 'A <a@x.invalid>, b@y.invalid\nc@z.invalid; a@x.invalid', body: '正文' });
  assert.deepEqual(parsed.outbound.to, ['a@x.invalid', 'b@y.invalid', 'c@z.invalid']);
  assert.deepEqual(parsed.outbound.cc, []);
  assert.deepEqual(parseMailRecipients(['one@x.invalid', 'two@y.invalid']), ['one@x.invalid', 'two@y.invalid']);

  await reject(composeOutbound('default', { to: '没有地址', body: '正文' }), 400, 'MAIL_RECIPIENT_INVALID');
  await reject(composeOutbound('default', { to: 'a@x.invalid, garbage', body: '正文' }), 400, 'MAIL_RECIPIENT_INVALID');
  await reject(composeOutbound('default', { to: '', body: '正文' }), 400, 'MAIL_RECIPIENT_REQUIRED');
  await reject(composeOutbound('default', { to: 'a@x.invalid', body: '   ' }), 400, 'MAIL_BODY_REQUIRED');
  await reject(composeOutbound('default', { to: 'a@x.invalid', body: 'x'.repeat(200_001) }), 400, 'MAIL_BODY_TOO_LONG');
  await reject(composeOutbound('default', { to: 'a@x.invalid', body: '正文', sendAt: Date.now() - 60_000 }), 400, 'MAIL_SEND_AT_INVALID');
  await reject(composeOutbound('default', { to: 'a@x.invalid', body: '正文', sendAt: new Date(Date.now() - 60_000).toISOString() }), 400, 'MAIL_SEND_AT_INVALID');
  await reject(composeOutbound('default', { to: 'a@x.invalid', body: '正文', sendAt: '明天下午' }), 400, 'MAIL_SEND_AT_INVALID');
  await reject(composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 999 }), 400, 'MAIL_UNDO_WINDOW_INVALID');
  await reject(composeOutbound('someone-elses-mailbox', { to: 'a@x.invalid', body: '正文' }), 403, 'MAILBOX_FORBIDDEN');

  // epoch 毫秒字符串和 ISO 都认。
  const future = Date.now() + 3_600_000;
  assert.equal(Date.parse((await composeOutbound('default', { to: 'a@x.invalid', body: '正文', sendAt: String(future) })).outbound.sendAt), future);
  assert.equal(Date.parse((await composeOutbound('default', { to: 'a@x.invalid', body: '正文', sendAt: new Date(future).toISOString() })).outbound.sendAt), future);
  // undoSeconds: 0 表示不等待：sendAt 就是现在，派发立刻能拿到。
  const immediate = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 0 });
  assert.equal(Date.parse(immediate.outbound.sendAt), Date.parse(immediate.outbound.createdAt));
});

test('签名：默认追加、已以签名结尾不重复、useSignature:false 不追加、fromName 体现在 from', async () => {
  reset();
  const plain = await composeOutbound('default', { to: 'a@x.invalid', body: '正文' });
  assert.ok(plain.outbound.body.endsWith('合成签名\n产品团队\n'));
  const again = await composeOutbound('default', { to: 'a@x.invalid', body: '正文\n\n合成签名\n产品团队\n' });
  assert.equal((again.outbound.body.match(/产品团队/g) || []).length, 1, '签名不重复追加');
  const none = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', useSignature: false });
  assert.equal(none.outbound.body, '正文');
  assert.equal(none.outbound.signature, '');
  assert.equal(appendSignatureText('', '签名'), '签名\n');

  const record = await one();
  assert.equal(buildOutboundMessage(record, { mailbox: mailbox }).from, '合成发件人 <sender@example.invalid>');
  assert.equal(buildOutboundMessage({ ...record, fromName: '' }, { mailbox: { email: 'sender@example.invalid' } }).from, 'sender@example.invalid');
  assert.equal(buildOutboundMessage({ ...record, fromName: '' }, { mailbox: { email: 'sender@example.invalid', fromName: '  ' } }).from, 'sender@example.invalid');
});

// ── 派发 ──────────────────────────────────────────────

test('到点才发一次：发信带签名、显示名、线程头，并落盘 sent 回执', async () => {
  reset();
  const sent = [];
  const { outbound } = await composeOutbound('default', {
    to: ['one@example.invalid', 'two@example.invalid'], cc: 'observer@example.invalid', bcc: 'hidden@example.invalid',
    subject: '合成主题', body: '合成的正文', inReplyTo: '<original@example.invalid>',
    references: ['<older@example.invalid>', '<original@example.invalid>'], undoSeconds: 5,
  });
  const at = Date.parse(outbound.sendAt);
  const options = {
    ...noImap,
    listFolders: async () => [{ path: '已发送', flags: ['\\Sent'] }],
    sendMail: async (_settings, message) => { sent.push(message); return { accepted: message.to, rejected: [], messageId: '<sent@example.invalid>' }; },
  };
  assert.equal((await dispatchDueOutbound({ ...options, now: at - 1 })).attempted, 0, '没到点不能发');
  assert.equal(sent.length, 0);
  const summary = await dispatchDueOutbound({ ...options, now: at });
  assert.deepEqual(summary, { attempted: 1, sent: 1, failed: 0, unknown: 0, reaped: 0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, '合成发件人 <sender@example.invalid>');
  assert.deepEqual(sent[0].to, ['one@example.invalid', 'two@example.invalid']);
  assert.deepEqual(sent[0].cc, ['observer@example.invalid']);
  assert.deepEqual(sent[0].bcc, ['hidden@example.invalid']);
  assert.equal(sent[0].inReplyTo, '<original@example.invalid>');
  assert.deepEqual(sent[0].references, ['<older@example.invalid>', '<original@example.invalid>']);
  assert.equal(sent[0].text, '合成的正文\n\n合成签名\n产品团队\n');
  assert.match(sent[0].messageId, /^<daylight-outbound-.*@example\.invalid>$/);

  const record = await one();
  assert.equal(record.status, 'sent');
  assert.equal(record.messageId, '<sent@example.invalid>');
  assert.deepEqual(record.delivery, { accepted: ['one@example.invalid', 'two@example.invalid'], rejected: [] });
  assert.equal(record.retryable, false);
  assert.equal(record.error, null);
  assert.equal(record.sentFolderAppended, true);
  // 再派发一次不会重发。
  assert.equal((await dispatchDueOutbound({ ...options, now: at + 60_000 })).attempted, 0);
  assert.equal(sent.length, 1);
});

test('SMTP 抛错 → failed + retryable；回执保存失败 → unknown，绝不重发', async () => {
  reset();
  const { outbound } = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 0 });
  const at = Date.parse(outbound.sendAt) + 1;
  const failure = await dispatchDueOutbound({ ...noImap, now: at, sendMail: async () => { throw new Error('合成 SMTP 连接失败'); } });
  assert.deepEqual(failure, { attempted: 1, sent: 0, failed: 1, unknown: 0, reaped: 0 });
  const failed = await one();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.retryable, true);
  assert.match(failed.error, /合成 SMTP 连接失败/);
  assert.ok(Number.isFinite(Date.parse(failed.attemptedAt)));

  // 已经被 SMTP 接受的收件人 → 不敢重发，记 unknown。
  reset();
  const ambiguous = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 0 });
  const ambiguousAt = Date.parse(ambiguous.outbound.sendAt) + 1;
  const partial = await dispatchDueOutbound({ ...noImap, now: ambiguousAt,
    sendMail: async () => { throw Object.assign(new Error('合成连接中断'), { accepted: ['a@x.invalid'] }); } });
  assert.equal(partial.unknown, 1);
  assert.equal((await one()).status, 'unknown');
  assert.equal((await one()).retryable, false);

  // SMTP 已返回但回执写不进去：状态收敛成 unknown，不重发。
  reset();
  const broken = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 0 });
  const brokenAt = Date.parse(broken.outbound.sendAt) + 1;
  let writes = 0;
  const flaky = async (mailboxId, namespace, change) => {
    writes += 1;
    if (writes === 2) throw new Error('合成：回执保存失败');
    return mutateAssistantState(mailboxId, namespace, change);
  };
  const sent = [];
  const summary = await dispatchDueOutbound({ ...noImap, now: brokenAt, mutateState: flaky,
    sendMail: async (_settings, message) => { sent.push(message); return { accepted: message.to, messageId: '<ok@example.invalid>' }; } });
  assert.equal(sent.length, 1, '回执写入失败也不能再发一次');
  assert.deepEqual(summary, { attempted: 1, sent: 0, failed: 0, unknown: 1, reaped: 0 });
  assert.equal((await one()).status, 'unknown');
  assert.match((await one()).error, /回执/);
});

test('并发/重入靠 sending 屏障挡住：两个派发同时跑，SMTP 只被调用一次', async () => {
  reset();
  const { outbound } = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 0 });
  const at = Date.parse(outbound.sendAt) + 1;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const sendMail = async (_settings, message) => {
    sent.push(message);
    await blocked;
    return { accepted: message.to, messageId: '<once@example.invalid>' };
  };
  const first = dispatchDueOutbound({ ...noImap, now: at, sendMail });
  await waitFor(() => sent.length > 0);
  assert.equal((await one()).status, 'sending', '发信前先写 sending 屏障');
  const second = await dispatchDueOutbound({ ...noImap, now: at, sendMail });
  assert.deepEqual(second, { attempted: 0, sent: 0, failed: 0, unknown: 0, reaped: 0 });
  release();
  assert.equal((await first).sent, 1);
  assert.equal(sent.length, 1);
  assert.equal((await one()).status, 'sent');
});

test('超过 5 分钟卡在 sending 的记录收敛成 unknown，且不会被重发', async () => {
  reset();
  const { outbound } = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 0 });
  await mutateAssistantState('default', 'outbound', (data) => {
    Object.assign(data.items[0], { status: 'sending', attemptedAt: new Date(Date.now() - 6 * 60_000).toISOString() });
  });
  const sent = [];
  const summary = await dispatchDueOutbound({ ...noImap, now: Date.now(), sendMail: async () => { sent.push(1); } });
  assert.equal(summary.reaped, 1);
  assert.equal(summary.attempted, 0);
  assert.equal(sent.length, 0);
  assert.equal((await one()).status, 'unknown');
  assert.ok(Date.parse(outbound.sendAt) <= Date.now());
});

// ── 撤销 / 立即发送 / 幂等 ──────────────────────────────

test('撤销只对窗口里的 scheduled 生效；已发出的邮件返回 409 + OUTBOUND_NOT_CANCELLABLE', async () => {
  reset();
  const cancelled = await composeOutbound('default', { to: 'a@x.invalid', body: '正文' });
  const reversal = await cancelOutbound('default', cancelled.outbound.id);
  assert.equal(reversal.outbound.status, 'cancelled');
  const sent = [];
  const summary = await dispatchDueOutbound({ ...noImap, now: Date.now() + 60_000, sendMail: async (_s, message) => { sent.push(message); return { accepted: message.to }; } });
  assert.equal(summary.sent, 0);
  assert.equal(sent.length, 0);

  reset();
  const going = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 0 });
  const at = Date.parse(going.outbound.sendAt) + 1;
  await dispatchDueOutbound({ ...noImap, now: at, sendMail: async (_s, message) => ({ accepted: message.to, messageId: '<x@example.invalid>' }) });
  assert.equal((await one()).status, 'sent');
  await reject(cancelOutbound('default', going.outbound.id), 409, 'OUTBOUND_NOT_CANCELLABLE');

  reset();
  const failing = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 0 });
  const failAt = Date.parse(failing.outbound.sendAt) + 1;
  await dispatchDueOutbound({ ...noImap, now: failAt, sendMail: async () => { throw new Error('合成 SMTP 连接失败'); } });
  assert.equal((await one()).status, 'failed');
  await reject(cancelOutbound('default', failing.outbound.id), 409, 'OUTBOUND_NOT_CANCELLABLE');
  await reject(cancelOutbound('default', 'missing-id'), 404, 'OUTBOUND_NOT_FOUND');
  await reject(readOutbound('default', 'missing-id'), 404, 'OUTBOUND_NOT_FOUND');
});

test('立即发送跳过剩余窗口；重复 idempotencyKey 只创建一条、只发一次', async () => {
  reset();
  const { outbound } = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 120 });
  assert.ok(Date.parse(outbound.sendAt) - Date.now() > 100_000);
  await markOutboundSentNow('default', outbound.id);
  const now = Date.now();
  assert.ok(Math.abs(Date.parse((await one()).sendAt) - now) < 5_000, '立即发送把 sendAt 提前到现在');
  await reject(markOutboundSentNow('default', 'missing-id'), 404, 'OUTBOUND_NOT_FOUND');

  reset();
  const key = 'compose-once';
  const first = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 0, idempotencyKey: key });
  const second = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 0, idempotencyKey: key });
  assert.equal(first.outbound.id, second.outbound.id);
  assert.equal(second.reused, true);
  assert.equal((await items()).length, 1, '同一幂等键只落一条记录');
  const sent = [];
  const summary = await dispatchDueOutbound({ ...noImap, now: Date.now() + 1_000, sendMail: async (_s, message) => { sent.push(message); return { accepted: message.to }; } });
  assert.equal(summary.sent, 1);
  assert.equal(sent.length, 1);
  await reject(composeOutbound('default', { to: 'a@x.invalid', body: '正文', idempotencyKey: 'x'.repeat(201) }), 400, 'MAIL_IDEMPOTENCY_INVALID');
});

test('列表最新在前，counts 覆盖该邮箱全部记录', async () => {
  reset();
  const base = Date.now();
  await composeOutbound('default', { to: 'a@x.invalid', body: '第一条', undoSeconds: 0 }, { now: base });
  const second = await composeOutbound('default', { to: 'a@x.invalid', body: '第二条', undoSeconds: 0 }, { now: base + 1_000 });
  await composeOutbound('default', { to: 'a@x.invalid', body: '第三条', undoSeconds: 0 }, { now: base + 2_000 });
  await cancelOutbound('default', second.outbound.id);
  const listed = await listOutbound('default', { limit: 2 });
  assert.equal(listed.outbound.length, 2, 'limit 只影响列表，不影响计数');
  assert.deepEqual(listed.counts, { scheduled: 2, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 1 });
  assert.deepEqual(listed.outbound.map((item) => item.body), ['第三条\n\n合成签名\n产品团队\n', '第二条\n\n合成签名\n产品团队\n']);
  assert.equal('operationKey' in listed.outbound[0], false, '对内字段不外泄');
  assert.equal('idempotencyKey' in listed.outbound[0], false);
  assert.equal('outgoingMessageId' in listed.outbound[0], false);
  assert.deepEqual(await listOutbound('default', { limit: 999 }), (await listOutbound('default', { limit: 200 })));
});

// ── 已发送文件夹留档 ──────────────────────────────────

test('resolveMailFolder 支持已发送：先 SPECIAL-USE，再按常见命名兜底', () => {
  assert.equal(resolveMailFolder([{ path: 'INBOX' }], 'sent'), null);
  for (const name of ['Sent', 'Sent Messages', 'Sent Items', '已发送', '已发送邮件']) {
    assert.equal(resolveMailFolder([{ path: 'INBOX' }, { path: name }], 'sent'), name, name);
  }
  assert.equal(resolveMailFolder([{ path: 'Sent' }, { path: '发件箱', flags: ['\\Sent'] }], 'sent'), '发件箱', 'SPECIAL-USE 优先');
  assert.equal(resolveMailFolder([{ path: 'Sent' }, { path: '发件箱', specialUse: '\\Sent' }], 'sent'), '发件箱');
  assert.equal(resolveMailFolder([{ path: 'Sent' }], 'archive'), null);
});

test('appendMailboxMessage 只写 resolveMailFolder 认得的文件夹，找不到就抛 MAIL_FOLDER_NOT_FOUND', async () => {
  const sent = fakeImap({ folders: [{ path: 'INBOX' }, { path: '已发送邮件', flags: ['\\Sent'] }] });
  const appended = await appendMailboxMessage({ ...mailbox }, { folder: '已发送邮件', raw: Buffer.from('MIME') }, { clientFactory: sent.clientFactory });
  assert.deepEqual(appended, { ok: true, folder: '已发送邮件' });
  assert.deepEqual(sent.calls, [{ folder: '已发送邮件', bytes: 4 }]);

  // 不传 folder 时自己列目录解析，仍然走 resolveMailFolder。
  const resolved = fakeImap({ folders: [{ path: 'INBOX' }, { path: 'Sent Items' }] });
  assert.equal((await appendMailboxMessage({ ...mailbox }, { raw: Buffer.from('MIME') }, { clientFactory: resolved.clientFactory })).folder, 'Sent Items');
  assert.deepEqual(resolved.calls, [{ folder: 'Sent Items', bytes: 4 }]);

  const missing = fakeImap({ folders: [{ path: 'INBOX' }] });
  await assert.rejects(appendMailboxMessage({ ...mailbox }, { raw: Buffer.from('MIME'), folder: '不存在的目录' }, { clientFactory: missing.clientFactory }),
    (error) => error.code === 'MAIL_FOLDER_NOT_FOUND');
  await assert.rejects(appendMailboxMessage({ ...mailbox }, { raw: Buffer.from('MIME') }, { clientFactory: missing.clientFactory }),
    (error) => error.code === 'MAIL_FOLDER_NOT_FOUND');
  assert.equal(missing.calls.length, 0, '找不到文件夹时绝不写');

  const rejected = fakeImap({ fail: Object.assign(new Error("Mailbox doesn't exist: 已发送"), { responseText: 'NO [TRYCREATE] Mailbox does not exist' }) });
  await assert.rejects(appendMailboxMessage({ ...mailbox }, { raw: Buffer.from('MIME'), folder: '已发送' }, { clientFactory: rejected.clientFactory }),
    (error) => error.code === 'MAIL_FOLDER_NOT_FOUND');
  await assert.rejects(appendMailboxMessage({ ...mailbox }, { raw: 42 }, { clientFactory: fakeImap().clientFactory }),
    (error) => error.code === 'MAIL_APPEND_INVALID');
});

test('已发送留档失败只记 sentFolderError，绝不影响已发出的 sent 状态', async () => {
  reset();
  const { outbound } = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', undoSeconds: 0 });
  const at = Date.parse(outbound.sendAt) + 1;
  const summary = await dispatchDueOutbound({ ...noImap, listFolders: async () => { throw new Error('合成 IMAP 连接失败'); }, now: at,
    sendMail: async (_s, message) => ({ accepted: message.to, messageId: '<kept@example.invalid>' }) });
  assert.equal(summary.sent, 1);
  const record = await one();
  assert.equal(record.status, 'sent');
  assert.equal(record.sentFolderAppended, false);
  assert.match(record.sentFolderError, /合成 IMAP 连接失败/);
  assert.equal(record.messageId, '<kept@example.invalid>');
});

// ── 回复草稿（预填） ────────────────────────────────────

const incoming = {
  id: 'imap-v2:user-1:sender%40example.invalid:INBOX:42:7',
  subject: '合成会议邀请', sender: '合成来信者 <sender@example.invalid>',
  senderAddress: 'sender@example.invalid', replyTo: '合成回复联系人 <reply-to@example.invalid>',
  to: ['sender@example.invalid', 'colleague@example.invalid'], cc: ['observer@example.invalid', 'sender@example.invalid'],
  messageId: '<original@example.invalid>', references: ['<older@example.invalid>'],
};

test('回复草稿：to 优先 Reply-To，主题不重复 Re:，references 接上原线程', () => {
  const draft = buildReplyDraft(incoming, { mode: 'reply', mailbox });
  assert.deepEqual(draft.to, ['reply-to@example.invalid']);
  assert.deepEqual(draft.cc, []);
  assert.equal(draft.subject, 'Re: 合成会议邀请');
  assert.equal(draft.body, '');
  assert.equal(draft.inReplyTo, '<original@example.invalid>');
  assert.deepEqual(draft.references, ['<older@example.invalid>', '<original@example.invalid>']);
  assert.equal(draft.recipientsKnown, true);
  assert.equal(draft.warning, undefined);
  assert.equal(replySubject('Re: 已经回复过'), 'Re: 已经回复过');
  assert.equal(replySubject('回复：中文前缀'), '回复：中文前缀');
  assert.equal(replySubject('RE:大写'), 'RE:大写');
  assert.equal(replySubject(''), 'Re: （无主题）');
  assert.equal(replySubject('新主题'), 'Re: 新主题');
  // Reply-To 缺失时退回 senderAddress，再退回 sender。
  assert.deepEqual(buildReplyDraft({ ...incoming, replyTo: '' }, { mailbox }).to, ['sender@example.invalid']);
  assert.deepEqual(buildReplyDraft({ sender: '旧来信者 <legacy@example.invalid>' }, { mailbox }).to, ['legacy@example.invalid']);
});

test('回复全部：去掉自己、去掉重复、保持顺序；旧邮件只能回复发件人并如实告知', () => {
  const all = buildReplyDraft(incoming, { mode: 'reply-all', mailbox });
  assert.equal(all.mode, 'reply-all');
  assert.deepEqual(all.to, ['reply-to@example.invalid']);
  assert.deepEqual(all.cc, ['colleague@example.invalid', 'observer@example.invalid'], '排除自己与已在 to 里的地址，保序去重');

  // 自己就是发件人时，也不把发件人重复放进 to。
  const selfSent = buildReplyDraft({ ...incoming, replyTo: '', to: ['sender@example.invalid'] }, { mode: 'reply-all', mailbox });
  assert.deepEqual(selfSent.to, ['sender@example.invalid']);
  assert.deepEqual(selfSent.cc, ['observer@example.invalid'], 'to 里只剩下的自己不再进 cc，其余原 cc 保序保留');

  // 旧数据：邮件记录里根本没有 to/cc。
  const legacy = buildReplyDraft({ id: 'qq:a:1:2', subject: '旧邮件', senderAddress: 'legacy@example.invalid', messageId: '<old@example.invalid>' },
    { mode: 'reply-all', mailbox });
  assert.deepEqual(legacy.to, ['legacy@example.invalid']);
  assert.deepEqual(legacy.cc, []);
  assert.equal(legacy.recipientsKnown, false);
  assert.match(legacy.warning, /旧数据/);
  assert.deepEqual(legacy.references, ['<old@example.invalid>']);

  // 连发件人都没有：如实返回空 to 并提示，不能假装能回复。
  const anonymous = buildReplyDraft({ subject: '无发件人' }, { mode: 'reply', mailbox });
  assert.deepEqual(anonymous.to, []);
  assert.equal(anonymous.recipientsKnown, false);
  assert.match(anonymous.warning, /没有可回复的发件人/);
});

test('publicOutbound 只暴露对外字段', async () => {
  reset();
  const { outbound } = await composeOutbound('default', { to: 'a@x.invalid', body: '正文' });
  assert.deepEqual(Object.keys(outbound).sort(), [
    'attemptedAt', 'bcc', 'body', 'cc', 'createdAt', 'delivery', 'error', 'from', 'fromName', 'id', 'inReplyTo',
    'mailboxId', 'messageId', 'references', 'retryable', 'sendAt', 'sentAt', 'sentFolderAppended', 'sentFolderError',
    'signature', 'source', 'status', 'subject', 'threadKey', 'to', 'updatedAt',
  ]);
  assert.equal(publicOutbound({ ...(await one()), operationKey: 'secret', idempotencyKey: 'secret' }).operationKey, undefined);
});

test('邮箱模型的新字段：归一与对外白名单', () => {
  const normalized = normalizeMailbox({ id: 'default', email: 'a@example.invalid', fromName: '  名字  ', signature: `  ${'长'.repeat(3000)}  ` });
  assert.equal(normalized.fromName, '名字');
  assert.equal(normalized.signature.length, 2000);
  assert.equal(normalizeMailbox({ id: 'default' }).fromName, '');
  assert.equal(normalizeMailbox({ id: 'default', fromName: 42 }).fromName, '');
});

// ── HTTP 路由集成：真实 Express + JSON 存储，只有 SMTP / IMAP / 模型是本地替身 ──────
//
// 和 reply.test.js / mailboxes.test.js 一样单开一个子进程，避开原生模块在线程里的收尾问题。
// 子进程里跑真实的 Express 路由和真实的 JSON 存储；SMTP 用 mock 的 nodemailer、
// IMAP 用假的 ImapFlow 原型方法，地址一律 example.invalid，绝不碰真邮箱。

const integrationMailboxes = [
  { id: 'default', provider: 'custom', email: 'sender@example.invalid', authorizationCode: 'invented-outbound-integration-code',
    imapHost: 'imap.example.invalid', imapPort: 993, imapSecure: true, smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpSecure: true,
    fromName: '合成发件人', signature: '合成签名\n产品团队' },
  { id: 'secondary', provider: 'custom', email: 'second@example.invalid', authorizationCode: 'invented-outbound-second-code',
    imapHost: 'imap.example.invalid', imapPort: 993, imapSecure: true, smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpSecure: true },
];
const integrationEmail = {
  id: 'imap-v2:user-1:sender%40example.invalid:INBOX:42:7', trace_id: 'outbound-integration-trace', mode: 'qq', status: 'skipped',
  subject: '合成会议邀请', sender: '合成来信者 <sender@example.invalid>', senderAddress: 'sender@example.invalid',
  replyTo: '合成回复联系人 <reply-to@example.invalid>', to: ['sender@example.invalid', 'colleague@example.invalid'],
  cc: ['observer@example.invalid', 'sender@example.invalid'], messageId: '<original@example.invalid>',
  references: ['<older@example.invalid>'], receivedAt: '2026-10-13T08:00:00+08:00', body: '供本地集成验证的合成邮件。',
};

async function serveOutboundFixture(fixtureData) {
  const { mock } = await import('node:test');
  const { default: express } = await import('express');
  const { default: dns } = await import('node:dns/promises');
  const { default: nodemailer } = await import('nodemailer');
  const { ImapFlow } = await import('imapflow');
  const outgoing = [];
  const appended = [];
  let modelCalls = 0;
  let httpServer;
  mock.timers.enable({ apis: ['setInterval'] });
  const realCreateTransport = nodemailer.createTransport.bind(nodemailer);
  mock.method(dns, 'lookup', async () => ({ address: '192.0.2.7', family: 4 }));
  mock.method(nodemailer, 'createTransport', (options) => {
    // compileOutboundRaw 用 streamTransport 把同一封信编译成原始 MIME（不连网），必须放行。
    if (options?.streamTransport) return realCreateTransport(options);
    return { async sendMail(mail) {
      outgoing.push({ options, mail });
      const accepted = [].concat(mail.to || []).filter(Boolean);
      return { accepted, rejected: [], messageId: `<outbound-integration-${outgoing.length}@example.invalid>` };
    } };
  });
  mock.method(ImapFlow.prototype, 'connect', async function () { this.mailbox = { exists: 1, uidValidity: 10 }; });
  mock.method(ImapFlow.prototype, 'getMailboxLock', async () => ({ release() {} }));
  mock.method(ImapFlow.prototype, 'logout', async () => {});
  mock.method(ImapFlow.prototype, 'list', async function* () {
    yield { path: 'INBOX' };
    yield { path: '已发送', flags: ['\\Sent'] };
  });
  mock.method(ImapFlow.prototype, 'append', async function (folder, raw) { appended.push({ folder, bytes: Buffer.from(raw).length }); return { uid: 1 }; });
  mock.method(globalThis, 'fetch', async () => {
    modelCalls++;
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{}' } }] }) };
  });
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
    process.send({ outgoing, appended, modelCalls });
  });
  // 跳过 Vite dev server（它会留下文件监听句柄让子进程无法退出）；DAYLIGHT_RUNTIME 仍是 local，
  // 所以业务行为按本地运行（不带生产派发字段、保留本地派发节拍）。
  process.argv.push('--production');
  await import(fixtureData.indexUrl);
}

async function outboundFixture(t) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'work', 'outbound-http-'));
  fs.writeFileSync(path.join(directory, 'calendar.json'), JSON.stringify({ events: [], tasks: [], emails: [integrationEmail], lastSync: null }));
  fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
    activeMailboxId: 'default', mailboxes: integrationMailboxes, baseUrl: '', apiKey: '', model: '', fetchLimit: 15,
  }, null, 2));
  fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({
    postgres: { enabled: false },
    mq: { enabled: false }, // 与宿主机上可能运行的 RabbitMQ 隔离开。
    auth: { requireAuth: false, allowLocalDemoLogin: true, sessionDays: 14, jwtSecret: 'test', adminEmails: [] },
  }, null, 2));
  const fixtureData = { indexUrl: new URL('./index.js', import.meta.url).href };
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `(${serveOutboundFixture.toString()})(${JSON.stringify(fixtureData)}).catch(error => {
      console.error(error); process.exitCode = 1; if (process.connected) process.disconnect();
    })`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, PORT: '0', DAYLIGHT_RUNTIME: 'local', DAYLIGHT_DATA_DIR: directory, DAYLIGHT_REQUIRE_AUTH: '0' } });
  let output = '', exitResult, stopping;
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => { output = (output + chunk).slice(-16384); });
  }
  const exited = new Promise((resolve) => {
    child.once('error', (error) => { exitResult = { error }; resolve(exitResult); });
    child.once('exit', (code, signal) => { exitResult = { code, signal }; resolve(exitResult); });
  });
  const failure = (message, result = exitResult) => new Error(
    `${message}; exitCode=${result?.code ?? 'pending'}, signal=${result?.signal ?? 'none'}\n${result?.error?.message || ''}\n${output}`);
  const nextMessage = () => new Promise((resolve, reject) => {
    if (exitResult) { reject(failure('Outbound API fixture already exited')); return; }
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onMessage = (value) => { cleanup(); resolve(value); };
    const onExit = (code, signal) => { cleanup(); reject(failure('Outbound API fixture exited before replying', { code, signal })); };
    const onError = (error) => { cleanup(); reject(failure('Outbound API fixture process failed', { error })); };
    const timer = setTimeout(() => { cleanup(); reject(failure('Outbound API fixture did not reply within 15 seconds')); }, 15000);
    child.once('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
  const send = (value) => new Promise((resolve, reject) => child.send(value, (error) => error ? reject(error) : resolve()));
  const stop = () => stopping ||= (async () => {
    let timer;
    try {
      if (!exitResult) await send({ type: 'shutdown' });
      const result = await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(failure('Outbound API fixture did not shut down within 5 seconds')), 5000);
      })]);
      if (result.error || result.code !== 0 || result.signal) throw failure('Outbound API fixture exited unsuccessfully', result);
    } catch (error) {
      if (!exitResult) { child.kill(); await exited; }
      throw error;
    } finally { clearTimeout(timer); }
  })();
  t.after(stop);
  const { port } = await nextMessage();
  assert.ok(Number.isInteger(port) && port > 0, failure('Outbound API fixture returned an invalid port'));
  const request = async (route, method = 'GET', body, mailboxId) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(mailboxId ? { 'X-Mailbox-Id': mailboxId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const command = async (message) => {
    const [response] = await Promise.all([nextMessage(), send(message)]);
    return response;
  };
  return {
    directory, request, command, stop,
    compose: (body, mailboxId) => request('/api/mail/compose', 'POST', body, mailboxId),
    outbound: (mailboxId, query = '') => request(`/api/mail/outbound${query}`, 'GET', undefined, mailboxId),
    cancel: (id, mailboxId) => request(`/api/mail/outbound/${id}/cancel`, 'POST', undefined, mailboxId),
    sendNow: (id, mailboxId) => request(`/api/mail/outbound/${id}/send-now`, 'POST', undefined, mailboxId),
    replyDraft: (id, mode) => request(`/api/emails/${encodeURIComponent(id)}/reply-draft`, 'POST', { mode }, 'default'),
  };
}

test('HTTP：写邮件只落库不连 SMTP；X-Mailbox-Id 白名单按邮箱隔离队列', async (t) => {
  const app = await outboundFixture(t);
  // 非活跃但属于自己的邮箱：中间件必须放行，不能 409「当前邮箱已切换」。
  const secondary = await app.compose({ to: 'a@x.invalid', body: '第二邮箱正文' }, 'secondary');
  assert.equal(secondary.status, 201);
  assert.equal(secondary.body.outbound.mailboxId, 'secondary');
  assert.equal(secondary.body.outbound.status, 'scheduled');
  assert.equal('dispatch' in secondary.body, false, '本地运行不带生产派发字段');

  const composed = await app.compose({ to: 'someone@example.invalid', subject: '合成主题', body: '合成正文', undoSeconds: 60 });
  assert.equal(composed.status, 201);
  assert.equal(composed.body.outbound.mailboxId, 'default');
  assert.equal(composed.body.outbound.from, 'sender@example.invalid');
  assert.equal(composed.body.outbound.fromName, '合成发件人');
  assert.match(composed.body.outbound.body, /合成正文\n\n合成签名\n产品团队/);

  // 不属于自己的邮箱：写 403、列表也 403，且不泄露「是否存在」。
  const foreign = await app.compose({ to: 'a@x.invalid', body: '正文' }, 'someone-elses');
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.code, 'MAILBOX_FORBIDDEN');
  assert.equal((await app.outbound('someone-elses')).status, 403);

  // 队列按邮箱隔离，counts 只覆盖本邮箱。
  const defaultList = await app.outbound();
  assert.equal(defaultList.status, 200);
  assert.equal(defaultList.body.outbound.length, 1);
  assert.equal(defaultList.body.outbound[0].mailboxId, 'default');
  assert.deepEqual(defaultList.body.counts, { scheduled: 1, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 });
  const secondaryList = await app.outbound('secondary');
  assert.equal(secondaryList.body.outbound.length, 1);
  assert.equal(secondaryList.body.outbound[0].mailboxId, 'secondary');

  // 只写邮件不发信：SMTP / IMAP / 模型都没有被碰过。
  const counts = await app.command({ type: 'counts' });
  assert.equal(counts.outgoing.length, 0);
  assert.equal(counts.appended.length, 0);
  assert.equal(counts.modelCalls, 0);
});

test('HTTP：立即发送真的发出一封（显示名 + 签名），并 best-effort 留档到已发送', async (t) => {
  const app = await outboundFixture(t);
  const composed = await app.compose({ to: ['one@x.invalid', 'two@x.invalid'], cc: 'observer@x.invalid',
    subject: '合成主题', body: '合成正文', undoSeconds: 120 });
  const id = composed.body.outbound.id;
  assert.ok(Date.parse(composed.body.outbound.sendAt) - Date.now() > 100_000, '默认还在撤销窗口里');
  assert.equal((await app.command({ type: 'counts' })).outgoing.length, 0, '窗口内不发');

  const sent = await app.sendNow(id);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.outbound.status, 'sent');
  assert.equal(sent.body.outbound.sentFolderAppended, true);
  assert.equal(sent.body.outbound.sentFolderError, '');
  assert.equal(sent.body.outbound.retryable, false);
  assert.equal(sent.body.outbound.messageId, '<outbound-integration-1@example.invalid>');

  const counts = await app.command({ type: 'counts' });
  assert.equal(counts.outgoing.length, 1);
  assert.equal(counts.outgoing[0].mail.from, '合成发件人 <sender@example.invalid>');
  assert.deepEqual(counts.outgoing[0].mail.to, ['one@x.invalid', 'two@x.invalid']);
  assert.deepEqual(counts.outgoing[0].mail.cc, ['observer@x.invalid']);
  assert.equal(counts.outgoing[0].options.host, '192.0.2.7');
  assert.deepEqual(counts.outgoing[0].options.tls, { servername: 'smtp.example.invalid' });
  assert.match(counts.outgoing[0].mail.text, /合成正文\n\n合成签名\n产品团队/);
  assert.deepEqual(counts.appended.map((item) => item.folder), ['已发送']);
  assert.ok(counts.appended[0].bytes > 0, '追加的是编译出来的原始 MIME');
  assert.equal(counts.modelCalls, 0);

  // 已发送再点立即发送：409，且不会再连一次 SMTP。
  const again = await app.sendNow(id);
  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'OUTBOUND_NOT_CANCELLABLE');
  assert.equal((await app.command({ type: 'counts' })).outgoing.length, 1);
});

test('HTTP：撤销只对窗口内的 scheduled 生效；回复草稿预填完整 to/cc 与线程头', async (t) => {
  const app = await outboundFixture(t);
  const composed = await app.compose({ to: 'a@x.invalid', body: '正文', undoSeconds: 120 });
  const cancelled = await app.cancel(composed.body.outbound.id);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.outbound.status, 'cancelled');
  assert.equal((await app.outbound()).body.counts.cancelled, 1);

  const doomed = await app.compose({ to: 'b@x.invalid', body: '正文' });
  const sentNow = await app.sendNow(doomed.body.outbound.id);
  assert.equal(sentNow.status, 200);
  const late = await app.cancel(doomed.body.outbound.id);
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'OUTBOUND_NOT_CANCELLABLE');
  assert.match(late.body.error, /无法收回/);
  assert.equal((await app.cancel('missing-id')).status, 404);

  const draft = await app.replyDraft(integrationEmail.id, 'reply');
  assert.equal(draft.status, 200);
  assert.deepEqual(draft.body.to, ['reply-to@example.invalid']);
  assert.equal(draft.body.subject, 'Re: 合成会议邀请');
  assert.equal(draft.body.inReplyTo, '<original@example.invalid>');
  assert.deepEqual(draft.body.references, ['<older@example.invalid>', '<original@example.invalid>']);
  const all = await app.replyDraft(integrationEmail.id, 'reply-all');
  assert.deepEqual(all.body.to, ['reply-to@example.invalid']);
  assert.deepEqual(all.body.cc, ['colleague@example.invalid', 'observer@example.invalid']);
  assert.equal((await app.replyDraft('missing-mail', 'reply')).status, 404);
});

test('草稿留在草稿箱，HTML 正文同时带纯文本', async () => {
  const { outbound } = await composeOutbound('default', { draft: true, subject: '草稿', body: '<p>你好</p>' });
  assert.equal(outbound.status, 'draft');
  assert.equal(outbound.sendAt, null);
  const listed = await listOutbound('default', { limit: 200 });
  assert.equal(listed.outbound.some((item) => item.id === outbound.id && item.status === 'draft'), true);
  const built = buildOutboundMessage(outbound, { mailbox });
  assert.match(built.html, /<p>你好<\/p>/);
  assert.equal(built.text.includes('<p>'), false);
  assert.match(built.html, /合成签名/);
});
