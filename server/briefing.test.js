/**
 * 早间简报的后端测试：只读本地数据，不连邮箱、不调模型。
 * 邮件地址、日程标题一律合成；store 直接注入内存对象，不写真实业务数据。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-briefing-'));
process.env.DAYLIGHT_DATA_DIR = directory;
fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
  activeMailboxId: 'default',
  mailboxes: [
    { id: 'default', email: 'briefing@example.invalid' },
    { id: 'secondary', email: 'second@example.invalid' },
  ],
  baseUrl: '', apiKey: '', model: '',
}, null, 2));
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false }, mq: { enabled: false } }, null, 2));

const {
  buildBriefing, buildBriefingText, collectDueTasks, collectTodayEvents,
  beijingDate, beijingLabel, resolveBriefingMailbox, MAX_BRIEFING_TEXT,
} = await import('./briefing.js');
const { createReceipt } = await import('./receipts.js');
const { readSettings } = await import('./store.js');

// 2026-10-17（周六）北京时间 09:00。
const NOW = Date.parse('2026-10-17T09:00:00+08:00');
const settings = () => readSettings();

function storeWith(overrides = {}) {
  return { events: [], tasks: [], emails: [], lastSync: null, ...overrides };
}

const TODAY_STORE = storeWith({
  events: [
    { id: 'e-late', title: '下午评审', start: '2026-10-17T14:00:00+08:00', end: '2026-10-17T15:00:00+08:00', allDay: false },
    { id: 'e-early', title: '早会', start: '2026-10-17T08:00:00+08:00', end: '2026-10-17T08:30:00+08:00' },
    { id: 'e-yesterday', title: '昨天的会', start: '2026-10-16T14:00:00+08:00' },
    { id: 'e-tomorrow', title: '明天的会', start: '2026-10-18T09:00:00+08:00' },
    { id: 'e-allday', title: '全天活动', start: '2026-10-17T00:00:00+08:00', allDay: true },
    { id: 'e-broken', title: '坏事件', start: '没有时间' },
    { id: 'e-missing', title: '缺开始时间' },
  ],
  tasks: [
    { id: 't-today', title: '今天交材料', dueAt: '2026-10-17T18:00:00+08:00', status: 'pending' },
    { id: 't-overdue', title: '上周的作业', dueAt: '2026-10-10T18:00:00+08:00', status: 'pending' },
    { id: 't-done', title: '已完成', dueAt: '2026-10-17T10:00:00+08:00', status: 'done' },
    { id: 't-future', title: '下周的事', dueAt: '2026-10-20T18:00:00+08:00', status: 'pending' },
    { id: 't-bad-due', title: '脏 dueAt', dueAt: '下周吧', status: 'pending' },
    { id: 't-no-due', title: '没有截止', status: 'pending' },
  ],
  emails: [
    { id: 'm1', seen: false }, { id: 'm2', seen: false }, { id: 'm3', seen: true }, { id: 'm4' },
  ],
});

test('北京时间的日期与星期标签', () => {
  assert.equal(beijingDate(NOW), '2026-10-17');
  assert.equal(beijingLabel(NOW), '10月17日 周六');
  // 北京时间凌晨 0 点前后不能串日子。
  assert.equal(beijingDate(Date.parse('2026-10-17T23:59:00+08:00')), '2026-10-17');
  assert.equal(beijingDate(Date.parse('2026-10-17T00:30:00+08:00')), '2026-10-17');
  assert.equal(beijingDate(Date.parse('2026-10-16T23:30:00+08:00')), '2026-10-16');
});

test('只收今天的日程：按开始时间升序，缺 start / 脏 start 直接跳过', () => {
  const todayStart = Date.parse('2026-10-17T00:00:00+08:00');
  const events = collectTodayEvents(TODAY_STORE.events, todayStart, todayStart + 86_400_000);
  assert.deepEqual(events.map((event) => event.id), ['e-allday', 'e-early', 'e-late']);
  assert.deepEqual(events.map((event) => event.startAt), [
    '2026-10-17T00:00:00+08:00', '2026-10-17T08:00:00+08:00', '2026-10-17T14:00:00+08:00',
  ]);
  assert.equal(events[0].allDay, true);
  assert.equal(events[1].allDay, false);
  assert.equal(events[2].endAt, '2026-10-17T15:00:00+08:00');
  // 对外形态只有约定字段。
  assert.deepEqual(Object.keys(events[0]).sort(), ['allDay', 'endAt', 'id', 'startAt', 'title']);
  // 脏数据不炸。
  assert.deepEqual(collectTodayEvents([null, 'x', { id: 'y' }], todayStart, todayStart + 86_400_000), []);
});

test('待办只收今天到期或已过期的未完成项：done 与未来项排除，非法 dueAt 不炸', () => {
  const todayEnd = Date.parse('2026-10-18T00:00:00+08:00');
  const tasks = collectDueTasks(TODAY_STORE.tasks, todayEnd);
  assert.deepEqual(tasks.map((task) => task.id), ['t-overdue', 't-today']);
  assert.deepEqual(tasks.map((task) => task.dueAt), ['2026-10-10T18:00:00+08:00', '2026-10-17T18:00:00+08:00']);
  assert.deepEqual(Object.keys(tasks[0]).sort(), ['dueAt', 'id', 'title']);
  assert.deepEqual(collectDueTasks([{ id: 'z', dueAt: '???' }, { id: 'w' }], todayEnd), []);
});

test('有安排时的简报正文：日程 / 待办 / 未读各按数量列出', async () => {
  const briefing = await buildBriefing(undefined, { now: NOW, settings: settings(), store: TODAY_STORE, receipts: { waiting: [], overdue: [] } });
  assert.equal(briefing.mailboxId, 'default');
  assert.equal(briefing.date, '2026-10-17');
  assert.equal(briefing.generatedAt, '2026-10-17T09:00:00+08:00');
  assert.equal(briefing.unread, 2, '只数 seen === false 的邮件');
  assert.equal(briefing.events.length, 3);
  assert.equal(briefing.tasksDue.length, 2);
  assert.equal(briefing.empty, false);
  assert.equal(briefing.text, '10月17日 周六 · 今天 3 个日程、2 件待办到期、2 封邮件没看');
});

test('全部为空时：text 是一句实话，empty 为 true，绝不编造内容', async () => {
  const briefing = await buildBriefing('default', { now: NOW, settings: settings(), store: storeWith(), receipts: { waiting: [], overdue: [] } });
  assert.equal(briefing.empty, true);
  assert.equal(briefing.text, '今天没有安排，也没有待办到期，邮件都看完了。');
  assert.equal(briefing.unread, 0);
  assert.deepEqual(briefing.receipts, { waiting: [], overdue: [] });
});

test('超时回执出现在正文里；只有还在等的回执也不算「全空」', async () => {
  const overdueOnly = await buildBriefing('default', { now: NOW, settings: settings(), store: storeWith(),
    receipts: { waiting: [], overdue: [{ id: 'r1', subject: '合成主题', to: [], sentAt: null, dueAt: null, daysLate: 3 }] } });
  assert.equal(overdueOnly.empty, false);
  assert.equal(overdueOnly.text, '10月17日 周六 · 今天没有安排，也没有待办到期，邮件都看完了；等回信 1 件超时（合成主题）');

  const waitingOnly = await buildBriefing('default', { now: NOW, settings: settings(), store: storeWith(),
    receipts: { waiting: [{ id: 'r2', subject: '另一个主题', to: [], sentAt: null, dueAt: null, daysLeft: 2 }], overdue: [] } });
  assert.equal(waitingOnly.empty, false);
  assert.match(waitingOnly.text, /等回信 1 件（另一个主题）/);

  const both = await buildBriefing('default', { now: NOW, settings: settings(), store: TODAY_STORE,
    receipts: { waiting: [{ id: 'r2', subject: '等待中', to: [], sentAt: null, dueAt: null, daysLeft: 1 }],
      overdue: [{ id: 'r3', subject: '超时了', to: [], sentAt: null, dueAt: null, daysLate: 2 }] } });
  assert.match(both.text, /3 个日程/);
  assert.match(both.text, /等回信 1 件超时（超时了）/);
  assert.match(both.text, /等回信 1 件（等待中）/);
});

test('正文有长度上限：极端输入也 ≤ 400 字，主题只截前 30 字', () => {
  const long = '很长的主题'.repeat(80);
  const { text, empty } = buildBriefingText({
    dateLabel: '10月17日 周六',
    events: Array.from({ length: 30 }, (_, index) => ({ id: `e${index}` })),
    tasksDue: Array.from({ length: 30 }, (_, index) => ({ id: `t${index}` })),
    unread: 999,
    receipts: { waiting: [{ subject: long }], overdue: [{ subject: long }] },
  });
  assert.equal(empty, false);
  assert.ok(text.length <= MAX_BRIEFING_TEXT, `实际 ${text.length} 字`);
  assert.equal(text.includes(long), false, '主题被截断，不会把整段塞进通知');
});

test('回执默认从存储读：已超时的记录会进简报（回执模块与简报串起来）', async () => {
  const file = path.join(directory, 'assistant-receipts.json');
  for (const candidate of [file, `${file}.lock`, `${file}.postgres`]) if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  const sentMs = NOW - 5 * 86_400_000;
  await createReceipt('default', { id: 'o-briefing', status: 'sent', messageId: '<x@example.invalid>',
    to: ['someone@example.invalid'], cc: [], subject: '面试确认', sentAt: new Date(sentMs).toISOString() },
  { awaitReplyDays: 1, now: sentMs });
  const briefing = await buildBriefing('default', { now: NOW, settings: settings(), store: storeWith() });
  assert.equal(briefing.receipts.overdue.length, 1);
  assert.equal(briefing.receipts.overdue[0].subject, '面试确认');
  assert.equal(briefing.receipts.overdue[0].daysLate, 4);
  assert.equal(briefing.empty, false);
  assert.match(briefing.text, /等回信 1 件超时（面试确认）/);
  // 简报本身绝不改业务数据。
  assert.deepEqual(storeWith().tasks, []);
});

test('mailboxId 缺省用活跃邮箱；显式指定别人/不存在的邮箱一律 403', async () => {
  assert.equal(resolveBriefingMailbox('', settings()), 'default');
  assert.equal(resolveBriefingMailbox('secondary', settings()), 'secondary');
  assert.throws(() => resolveBriefingMailbox('someone-elses', settings()),
    (error) => error.status === 403 && error.code === 'MAILBOX_FORBIDDEN');
  await assert.rejects(buildBriefing('someone-elses', { now: NOW, settings: settings(), store: storeWith() }),
    (error) => error.status === 403 && error.code === 'MAILBOX_FORBIDDEN');
});
