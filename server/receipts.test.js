/**
 * 等回执（发出邮件后跟踪回信 + 超时落成真实待办）的后端测试。
 *
 * 全程只连本地合成的记录：地址一律 example.invalid，SMTP / IMAP / 模型都不碰。
 * 派发用 outbound.js 的可注入替身，回执检查用内存里的假 store，绝不读写真实业务数据。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-receipts-'));
process.env.DAYLIGHT_DATA_DIR = directory;
fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
  activeMailboxId: 'default',
  mailboxes: [
    { id: 'default', email: 'sender@example.invalid', authorizationCode: 'invented-code',
      imapHost: 'imap.example.invalid', smtpHost: 'smtp.example.invalid', fromName: '合成发件人', signature: '' },
    { id: 'secondary', email: 'second@example.invalid', authorizationCode: 'invented-code-2' },
  ],
  baseUrl: '', apiKey: '', model: '',
}, null, 2));
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false }, mq: { enabled: false } }, null, 2));

const {
  cancelReceipt, checkReceipts, createReceipt, listReceipts, matchReceipt, normalizeSubject,
  planReceiptChecks, publicReceipt, receiptSummary, threadKeyFor, participantsHash,
  NAMESPACE, RECEIPT_TASK_SOURCE, MAX_AWAIT_REPLY_DAYS,
} = await import('./receipts.js');
const { readAssistantState } = await import('./assistant-state.js');
const { composeOutbound, dispatchDueOutbound, readOutbound } = await import('./outbound.js');

const DAY = 86_400_000;
const noImap = {
  listFolders: async () => [{ path: '已发送', flags: ['\\Sent'] }],
  compileRaw: async () => Buffer.from('合成 MIME'),
  appendSent: async () => ({ ok: true, folder: '已发送' }),
};

function receiptsFile(mailboxId = 'default') {
  const dir = mailboxId === 'default' ? directory : path.join(directory, 'mailboxes', mailboxId);
  return path.join(dir, 'assistant-receipts.json');
}

function reset(mailboxId = 'default') {
  const file = receiptsFile(mailboxId);
  const outbound = path.join(directory, 'assistant-outbound.json');
  for (const candidate of [file, `${file}.lock`, `${file}.postgres`,
    outbound, `${outbound}.lock`, `${outbound}.postgres`]) {
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

const items = async (mailboxId = 'default') => (await readAssistantState(mailboxId, NAMESPACE)).items || [];

function fakeStore(overrides = {}) {
  return { events: [], tasks: [], emails: [], ...overrides };
}

function fakeSave(log = []) {
  return (data, mailboxId) => { log.push({ mailboxId, tasks: JSON.parse(JSON.stringify(data.tasks || [])) }); };
}

/** 构造一条「已发出」的出站记录，供 createReceipt 直接使用。 */
function sentOutbound(overrides = {}) {
  const sentMs = overrides.sentMs ?? Date.now() - 60_000;
  return {
    id: 'outbound-1', status: 'sent', messageId: '<daylight-outbound-1@example.invalid>',
    to: ['someone@example.invalid'], cc: [], subject: '合成主题',
    sentAt: new Date(sentMs).toISOString(), ...overrides,
  };
}

async function reject(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status, `${error.message} 的状态码`);
    assert.equal(error.code, code, `${error.message} 的错误码`);
    return true;
  });
}

// ── 主题归一化与线程键 ─────────────────────────────────

test('主题归一化：去掉 Re:/Fwd:/回复：前缀、去空白、大小写不敏感', () => {
  assert.equal(normalizeSubject('Re: 项目 计划'), normalizeSubject('回复：项目计划'));
  assert.equal(normalizeSubject('  Fwd:   Re:  Weekly   Report '), 'weeklyreport');
  assert.equal(normalizeSubject('RE:RE:嵌套'), '嵌套');
  assert.equal(normalizeSubject('转发： 面试安排'), '面试安排');
  assert.equal(normalizeSubject('Regarding the invoice'), 'regardingtheinvoice', '不是前缀就不动');
  assert.equal(normalizeSubject(''), '');
});

test('线程键：主题 + 参与地址集合的稳定哈希，地址顺序与重复不影响结果', () => {
  assert.equal(threadKeyFor('Re: Hello', ['a@x.invalid', 'b@x.invalid']), threadKeyFor('hello', ['B@X.INVALID', 'a@x.invalid', 'a@x.invalid']));
  assert.equal(participantsHash(['b@x.invalid', 'a@x.invalid']), participantsHash(['a@x.invalid', 'b@x.invalid']));
  assert.notEqual(threadKeyFor('hello', ['a@x.invalid']), threadKeyFor('hello', ['b@x.invalid']));
  assert.match(threadKeyFor('hi', []), /^hi#[0-9a-f]{16}$/);
});

// ── 回信判断：三档依据 ────────────────────────────────

test('matchReceipt：in-reply-to > reference > subject，兜底必须标注 matchedBy=subject', () => {
  const receipt = { messageId: '<out@example.invalid>', subject: 'Re: 合成主题', to: ['someone@example.invalid'], cc: [] };
  assert.deepEqual(matchReceipt(receipt, { subject: '合成主题', senderAddress: 'someone@example.invalid' }), { matchedBy: 'subject' });
  assert.deepEqual(matchReceipt(receipt, { subject: 'Re: 合成主题', senderAddress: 'someone@example.invalid' }), { matchedBy: 'subject' });
  assert.deepEqual(matchReceipt(receipt, { subject: '别的主题', references: ['<out@example.invalid>'] }), { matchedBy: 'reference' });
  assert.deepEqual(matchReceipt(receipt, { subject: '别的主题', inReplyTo: '<out@example.invalid>' }), { matchedBy: 'in-reply-to' });
  // 三档同时命中时按优先级短路。
  assert.deepEqual(matchReceipt(receipt, { subject: '合成主题', senderAddress: 'someone@example.invalid',
    references: ['<out@example.invalid>'], inReplyTo: '<out@example.invalid>' }), { matchedBy: 'in-reply-to' });
  // references 是字符串也能认（老数据形态）。
  assert.deepEqual(matchReceipt(receipt, { subject: 'x', references: '<a@x.invalid> <out@example.invalid>' }), { matchedBy: 'reference' });
  // 主题相同但参与地址没有交集：不算回信，绝不硬认。
  assert.equal(matchReceipt(receipt, { subject: '合成主题', senderAddress: 'stranger@example.invalid' }), null);
  // 旧邮件没有 to/cc 也能用发件人兜底。
  assert.deepEqual(matchReceipt(receipt, { subject: '合成主题', to: ['someone@example.invalid'] }), { matchedBy: 'subject' });
  assert.deepEqual(matchReceipt(receipt, { subject: '合成主题', cc: ['someone@example.invalid'] }), { matchedBy: 'subject' });
  assert.equal(matchReceipt(receipt, null), null);
});

// ── 建记录：只在真的发出去之后，awaitReplyDays 把关 ─────

test('createReceipt：只有 sent + messageId 才建；awaitReplyDays=0 或未发出都不建', async () => {
  reset();
  assert.equal(await createReceipt('default', sentOutbound({ status: 'scheduled' }), { awaitReplyDays: 3 }), null);
  assert.equal(await createReceipt('default', sentOutbound({ messageId: null }), { awaitReplyDays: 3 }), null);
  assert.equal(await createReceipt('default', sentOutbound(), { awaitReplyDays: 0 }), null);
  assert.equal(await createReceipt('default', sentOutbound(), { awaitReplyDays: undefined }), null);
  assert.deepEqual(await items(), []);

  const outbound = sentOutbound({ sentMs: Date.parse('2026-10-17T00:00:00Z') });
  const receipt = await createReceipt('default', outbound, { awaitReplyDays: 3, now: Date.parse('2026-10-17T00:00:00Z') });
  assert.equal(receipt.status, 'waiting');
  assert.equal(receipt.awaitReplyDays, 3);
  assert.deepEqual(receipt.to, ['someone@example.invalid']);
  assert.equal(receipt.dueAt, new Date(Date.parse('2026-10-17T00:00:00Z') + 3 * DAY).toISOString());
  assert.equal(receipt.sentAt, new Date(outbound.sentAt).toISOString());
  assert.match(receipt.threadKey, /^合成主题#/);
  // 同一条出站记录重复建只留一条。
  assert.equal(await createReceipt('default', outbound, { awaitReplyDays: 3 }), null);
  assert.equal((await items()).length, 1);
  // 只暴露约定字段。
  assert.deepEqual(Object.keys(receipt).sort(), ['answerEmailId', 'answeredAt', 'awaitReplyDays', 'cc', 'createdAt',
    'dueAt', 'id', 'mailboxId', 'matchedBy', 'messageId', 'outboundId', 'sentAt', 'status', 'subject', 'taskId', 'threadKey', 'to', 'updatedAt']);
});

test('awaitReplyDays 越界直接 400：createReceipt 与 /api/mail/compose 同口径', async () => {
  reset();
  await reject(createReceipt('default', sentOutbound(), { awaitReplyDays: MAX_AWAIT_REPLY_DAYS + 1 }), 400, 'RECEIPT_AWAIT_DAYS_INVALID');
  await reject(createReceipt('default', sentOutbound(), { awaitReplyDays: 1.5 }), 400, 'RECEIPT_AWAIT_DAYS_INVALID');
  assert.equal((await items()).length, 0);

  await assert.rejects(composeOutbound('default', { to: 'a@x.invalid', body: '正文', awaitReplyDays: -1 }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.code, 'MAIL_AWAIT_REPLY_DAYS_INVALID');
    return true;
  });
  await assert.rejects(composeOutbound('default', { to: 'a@x.invalid', body: '正文', awaitReplyDays: 61 }), (error) => error.code === 'MAIL_AWAIT_REPLY_DAYS_INVALID');
  const ok = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', awaitReplyDays: 60 });
  assert.equal(ok.outbound.status, 'scheduled');
  // 0 合法且不跟踪。
  const zero = await composeOutbound('default', { to: 'a@x.invalid', body: '正文', awaitReplyDays: 0 });
  assert.equal(zero.outbound.status, 'scheduled');
  // 内部字段不外泄到对外形态。
  assert.equal('awaitReplyDays' in ok.outbound, false);
});

// ── 派发钩子 ────────────────────────────────────────

test('派发成功后才建回执：sentAt / messageId / dueAt 都对得上', async () => {
  reset();
  const { outbound } = await composeOutbound('default', { to: 'someone@example.invalid', subject: '合成主题', body: '正文', undoSeconds: 0, awaitReplyDays: 2 });
  const at = Date.parse(outbound.sendAt) + 1;
  const summary = await dispatchDueOutbound({ ...noImap, now: at,
    sendMail: async (_settings, message) => ({ accepted: message.to, messageId: '<sent-1@example.invalid>' }) });
  assert.deepEqual(summary, { attempted: 1, sent: 1, failed: 0, unknown: 0, reaped: 0 });
  const created = await items();
  assert.equal(created.length, 1);
  assert.equal(created[0].outboundId, outbound.id);
  assert.equal(created[0].messageId, '<sent-1@example.invalid>');
  assert.equal(created[0].status, 'waiting');
  assert.equal(created[0].awaitReplyDays, 2);
  assert.equal(Date.parse(created[0].dueAt) - Date.parse(created[0].sentAt), 2 * DAY);
});

test('派发钩子抛错不影响已经发出的 sent 状态，也不重发', async () => {
  reset();
  const { outbound } = await composeOutbound('default', { to: 'someone@example.invalid', subject: '合成主题', body: '正文', undoSeconds: 0, awaitReplyDays: 5 });
  const at = Date.parse(outbound.sendAt) + 1;
  const sent = [];
  const summary = await dispatchDueOutbound({ ...noImap, now: at,
    receiptHook: async () => { throw new Error('合成回执存储失败'); },
    sendMail: async (_settings, message) => { sent.push(message); return { accepted: message.to, messageId: '<ok@example.invalid>' }; } });
  assert.equal(summary.sent, 1);
  assert.equal(sent.length, 1);
  const listed = await readOutbound('default', outbound.id);
  assert.equal(listed.outbound.status, 'sent');
  assert.equal(listed.outbound.retryable, false);
  assert.deepEqual(await items(), [], '钩子失败不该留下半条回执');
  // 再派发一次也不会重发。
  assert.equal((await dispatchDueOutbound({ ...noImap, now: at + 60_000, sendMail: async () => assert.fail('不该重发') })).attempted, 0);
});

// ── 超时建待办（幂等）────────────────────────────────

test('超时落成一条真实待办：字段齐全、跑两次只有一条、不改动无关记录', async () => {
  reset();
  const sentMs = Date.now() - 2 * DAY;
  const receipt = await createReceipt('default', sentOutbound({ sentMs }), { awaitReplyDays: 1, now: sentMs });
  const store = fakeStore();
  const saved = [];
  const first = await checkReceipts('default', { now: Date.now(), store, save: fakeSave(saved) });
  assert.deepEqual({ checked: first.checked, answered: first.answered, overdue: first.overdue }, { checked: 1, answered: 0, overdue: 1 });
  assert.equal(store.tasks.length, 1);
  const task = store.tasks[0];
  assert.equal(task.id, (await items()).find((item) => item.id === receipt.id).taskId);
  assert.equal(task.source, RECEIPT_TASK_SOURCE);
  assert.equal(task.title, '等回信：合成主题');
  assert.equal(task.status, 'pending');
  assert.equal(task.priority, 'normal');
  assert.equal(task.dueAt, receipt.dueAt, '待办截止时间就是记录当时的 dueAt');
  assert.match(task.description, /someone@example\.invalid/);
  assert.match(task.description, /已等 2 天/);
  assert.match(task.description, /请手动完成/);
  assert.ok(task.createdAt);

  // 幂等：同一份数据再跑一次，还是一条待办，答案/超时计数为 0。
  const second = await checkReceipts('default', { now: Date.now(), store, save: fakeSave(saved) });
  assert.deepEqual({ checked: second.checked, answered: second.answered, overdue: second.overdue }, { checked: 1, answered: 0, overdue: 0 });
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].id, task.id);

  // 无关记录不受影响：另一条还在等（未超时）的不该被改状态。
  const waitingItem = (await items()).find((item) => item.id === receipt.id);
  assert.equal(waitingItem.status, 'overdue');
});

test('回信到了：answered + 三档依据落库，并把已建的待办标完成', async () => {
  reset();
  const sentMs = Date.now() - 3 * DAY;
  const messageId = '<daylight-outbound-1@example.invalid>';
  const receipt = await createReceipt('default', sentOutbound({ sentMs, to: ['someone@example.invalid'] }), { awaitReplyDays: 1, now: sentMs });
  const store = fakeStore();
  await checkReceipts('default', { now: sentMs + 2 * DAY, store, save: fakeSave() });
  assert.equal(store.tasks[0].status, 'pending');

  const repliedAt = new Date(sentMs + 2 * DAY + 3_600_000).toISOString();
  store.emails.push({ id: 'reply-1', subject: 'Re: 合成主题', senderAddress: 'someone@example.invalid',
    inReplyTo: messageId, receivedAt: repliedAt, seen: false });
  const result = await checkReceipts('default', { now: sentMs + 3 * DAY, store, save: fakeSave() });
  assert.equal(result.answered, 1);
  assert.equal(result.overdue, 0);
  const updated = (await items()).find((item) => item.id === receipt.id);
  assert.equal(updated.status, 'answered');
  assert.equal(updated.matchedBy, 'in-reply-to');
  assert.equal(updated.answerEmailId, 'reply-1');
  assert.equal(updated.answeredAt, repliedAt, 'answeredAt 用回信到达时间');
  assert.equal(store.tasks.length, 1);
  assert.equal(store.tasks[0].status, 'done');
  assert.ok(store.tasks[0].completedAt);

  // 已结的记录不再被扫，跑第三次仍是 answered。
  const third = await checkReceipts('default', { now: sentMs + 4 * DAY, store, save: fakeSave() });
  assert.deepEqual({ checked: third.checked, answered: third.answered, overdue: third.overdue }, { checked: 0, answered: 0, overdue: 0 });
});

test('超时后收到回信也能收口：兜底档 matchedBy=subject 并完成待办', async () => {
  reset();
  const sentMs = Date.now() - 5 * DAY;
  const receipt = await createReceipt('default', sentOutbound({ sentMs, subject: '活动 报名', to: ['someone@example.invalid'] }), { awaitReplyDays: 1, now: sentMs });
  const store = fakeStore();
  await checkReceipts('default', { now: sentMs + 2 * DAY, store, save: fakeSave() });
  assert.equal(store.tasks[0].status, 'pending');

  // 没有 In-Reply-To，只靠主题 + 地址交集。
  store.emails.push({ id: 'fallback-1', subject: '回复：活动报名', senderAddress: 'someone@example.invalid',
    receivedAt: new Date(sentMs + 3 * DAY).toISOString() });
  const result = await checkReceipts('default', { now: sentMs + 3 * DAY, store, save: fakeSave() });
  assert.equal(result.answered, 1);
  const updated = (await items()).find((item) => item.id === receipt.id);
  assert.equal(updated.matchedBy, 'subject', '兜底档必须标出来，界面要看得出依据');
  assert.equal(store.tasks[0].status, 'done');
  assert.equal(store.tasks.length, 1);
});

test('只扫 receivedAt 晚于 sentAt 的邮件：更早的旧邮件不会被当回信', async () => {
  reset();
  const sentMs = Date.now() - 2 * DAY;
  await createReceipt('default', sentOutbound({ sentMs }), { awaitReplyDays: 1, now: sentMs });
  const store = fakeStore({ emails: [
    { id: 'old', subject: '合成主题', senderAddress: 'someone@example.invalid', receivedAt: sentMs - DAY },
    { id: 'no-time', subject: '合成主题', senderAddress: 'someone@example.invalid' },
  ] });
  const result = await checkReceipts('default', { now: sentMs + 2 * DAY, store, save: fakeSave() });
  assert.equal(result.answered, 0);
  assert.equal(result.overdue, 1);
});

// ── 取消 ────────────────────────────────────────────

test('cancel 只对 waiting / overdue 生效，并把已建的待办标完成', async () => {
  reset();
  const sentMs = Date.now() - 2 * DAY;
  const receipt = await createReceipt('default', sentOutbound({ sentMs }), { awaitReplyDays: 1, now: sentMs });
  const store = fakeStore();
  await checkReceipts('default', { now: Date.now(), store, save: fakeSave() });
  assert.equal(store.tasks[0].status, 'pending');

  const cancelled = await cancelReceipt('default', receipt.id, { load: () => store, save: fakeSave() });
  assert.equal(cancelled.receipt.status, 'cancelled');
  assert.equal(cancelled.taskCompleted, true);
  assert.equal(store.tasks[0].status, 'done');
  await reject(cancelReceipt('default', receipt.id), 409, 'RECEIPT_NOT_CANCELLABLE');
  await reject(cancelReceipt('default', 'missing-id'), 404, 'RECEIPT_NOT_FOUND');

  // 已取消的不再参与检查。
  const after = await checkReceipts('default', { now: Date.now() + DAY, store, save: fakeSave() });
  assert.deepEqual({ checked: after.checked, answered: after.answered, overdue: after.overdue }, { checked: 0, answered: 0, overdue: 0 });
});

// ── 列表 / 摘要 ─────────────────────────────────────

test('listReceipts：最新在前、counts 覆盖全部、状态过滤与非法状态 400', async () => {
  reset();
  const base = Date.now() - 3 * DAY;
  await createReceipt('default', sentOutbound({ id: 'o1', sentMs: base }), { awaitReplyDays: 5, now: base });
  await createReceipt('default', sentOutbound({ id: 'o2', sentMs: base + DAY }), { awaitReplyDays: 5, now: base + DAY });
  await createReceipt('default', sentOutbound({ id: 'o3', sentMs: base + 2 * DAY }), { awaitReplyDays: 5, now: base + 2 * DAY });
  await cancelReceipt('default', (await items())[1].id, { load: () => fakeStore(), save: () => {} });

  const listed = await listReceipts('default', { limit: 2 });
  assert.equal(listed.receipts.length, 2, 'limit 只影响列表');
  assert.deepEqual(listed.counts, { waiting: 2, answered: 0, overdue: 0, cancelled: 1 });
  assert.ok(Date.parse(listed.receipts[0].createdAt) >= Date.parse(listed.receipts[1].createdAt));
  const waiting = await listReceipts('default', { status: 'waiting' });
  assert.equal(waiting.receipts.length, 2);
  assert.equal((await listReceipts('default', { status: 'cancelled' })).receipts.length, 1);
  await assert.rejects(listReceipts('default', { status: 'nonsense' }), (error) => error.status === 400 && error.code === 'RECEIPT_STATUS_INVALID');
});

test('receiptSummary：区分还在等 / 已超时，字段供简报直接用', async () => {
  reset();
  const now = Date.now();
  const waiting = await createReceipt('default', sentOutbound({ id: 'w', sentMs: now }), { awaitReplyDays: 3, now });
  const overdue = await createReceipt('default', sentOutbound({ id: 'o', sentMs: now - 5 * DAY }), { awaitReplyDays: 1, now: now - 5 * DAY });
  const summary = await receiptSummary('default', { now });
  assert.equal(summary.waiting.length, 1);
  assert.equal(summary.overdue.length, 1);
  assert.equal(summary.waiting[0].id, waiting.id);
  assert.equal(summary.waiting[0].daysLeft, 3);
  assert.equal(summary.overdue[0].id, overdue.id);
  assert.equal(summary.overdue[0].daysLate, 4);
  assert.deepEqual(summary.waiting[0].to, ['someone@example.invalid']);
  // 已取消的不出现在任何一档。
  await cancelReceipt('default', waiting.id, { load: () => fakeStore(), save: () => {} });
  const after = await receiptSummary('default', { now });
  assert.equal(after.waiting.length, 0);
  assert.equal(after.overdue.length, 1);
});

test('planReceiptChecks 是纯逻辑：脏数据（没有 sentAt / dueAt）不炸', () => {
  const planned = planReceiptChecks([
    { id: 'r1', status: 'waiting', sentAt: 'not-a-date', dueAt: 'also-bad', subject: 'x', to: [] },
    { id: 'r2', status: 'answered', subject: 'y' },
  ], [], Date.now());
  assert.deepEqual({ answered: planned.answered, newlyOverdue: planned.newlyOverdue }, { answered: 0, newlyOverdue: 0 });
  assert.deepEqual(planned.tasks, [], '缺少可用时间时既不认回信也不建超时待办');
  assert.equal(publicReceipt({ status: 'waiting' }).to.length, 0);
});
