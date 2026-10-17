/**
 * 早间简报：服务端算出一段可以直接当通知正文的中文纯文本。
 *
 * 只读本地已保存的数据（日程 / 待办 / 邮件标记）+ 回执记录，不连邮箱、不调模型、不改任何业务数据。
 * 全部按北京时间当天：日程取「今天开始」的，待办取「今天到期或已经过期且未完成」的。
 *
 * 脏数据（dueAt 非法、事件缺 start、邮件缺 receivedAt）一律跳过而不是抛 500——
 * 简报的价值在于「哪怕有条目坏了，早上的通知照样发得出去」。
 * 「全部为空」时绝不编造内容：text 固定成一句实话，并给出 empty: true。
 */
import { readSettings, readStore } from './store.js';
import { receiptSummary } from './receipts.js';

const DAY_MS = 86_400_000;
const BEIJING_OFFSET = 8 * 3_600_000;
const WEEKDAYS = '日一二三四五六';
export const MAX_BRIEFING_TEXT = 400;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** 北京时间当天零点对应的 epoch 毫秒。 */
export function beijingDayStart(value) {
  const ms = Number(value);
  return Math.floor((ms + BEIJING_OFFSET) / DAY_MS) * DAY_MS - BEIJING_OFFSET;
}

/** 统一把 epoch 毫秒 / ISO 字符串 / Date 收敛成毫秒。 */
function toMs(value) {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'number' ? value : Date.parse(value);
}

/** 北京时间 ISO（带 +08:00），用于给人看的时间字段。 */
export function beijingIso(value) {
  const ms = toMs(value);
  return Number.isFinite(ms) ? new Date(ms + BEIJING_OFFSET).toISOString().replace(/\.\d{3}Z$/, '+08:00') : null;
}

/** `10月17日 周六`。 */
export function beijingLabel(value) {
  const ms = Number(value);
  const date = new Date(ms + BEIJING_OFFSET);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 周${WEEKDAYS[date.getUTCDay()]}`;
}

/** 把 `2026-10-17T09:00:00+08:00` 之类的值收敛成北京日期 `YYYY-MM-DD`。 */
export function beijingDate(value) {
  const ms = toMs(value);
  return Number.isFinite(ms) ? new Date(ms + BEIJING_OFFSET).toISOString().slice(0, 10) : null;
}

/**
 * 邮箱解析：显式给的要属于当前用户（否则 403，不区分「不存在」和「别人的」）；
 * 没给就用活跃邮箱。这样客户端传错邮箱 id 时是明确的拒绝，而不是看空数据。
 */
export function resolveBriefingMailbox(mailboxId, settings = readSettings()) {
  const owned = (settings.mailboxes || []).map((mailbox) => mailbox.id);
  const requested = String(mailboxId || '').trim();
  if (requested) {
    if (!owned.includes(requested)) throw fail('邮箱不存在或不属于当前用户。', 403, 'MAILBOX_FORBIDDEN');
    return requested;
  }
  return settings.activeMailboxId || owned[0] || 'default';
}

/** 今天开始的日程，按开始时间升序；start 解析不出来的直接跳过。 */
export function collectTodayEvents(events, todayStart, todayEnd) {
  const prepared = [];
  for (const event of list(events)) {
    if (!event || typeof event !== 'object') continue;
    const startMs = Date.parse(event.start);
    if (!Number.isFinite(startMs)) continue;
    if (startMs < todayStart || startMs >= todayEnd) continue;
    prepared.push({
      id: event.id, title: text(event.title, 160) || '（无标题）',
      startAt: event.start, endAt: event.end || null, allDay: Boolean(event.allDay), _sort: startMs,
    });
  }
  return prepared.sort((a, b) => a._sort - b._sort)
    .map(({ _sort, ...visible }) => visible);
}

/** 今天到期或已过期、且未完成的待办，按截止时间升序；dueAt 非法的一律跳过。 */
export function collectDueTasks(tasks, todayEnd) {
  const prepared = [];
  for (const task of list(tasks)) {
    if (!task || typeof task !== 'object') continue;
    if (task.status === 'done') continue;
    if (!task.dueAt) continue;
    const dueMs = Date.parse(task.dueAt);
    if (!Number.isFinite(dueMs)) continue;
    if (dueMs >= todayEnd) continue;
    prepared.push({ id: task.id, title: text(task.title, 160) || '（无标题）', dueAt: task.dueAt, _sort: dueMs });
  }
  return prepared.sort((a, b) => a._sort - b._sort)
    .map(({ _sort, ...visible }) => visible);
}

function shortSubject(subject) {
  return text(subject, 30) || '（无主题）';
}

function clamp(value) {
  return value.length > MAX_BRIEFING_TEXT ? `${value.slice(0, MAX_BRIEFING_TEXT - 1)}…` : value;
}

/**
 * 纯函数：把当天的四块事实拼成一句人读得懂的通知正文。
 * parts 只列非零项；四块全空时给固定的一句实话 + empty: true。
 */
export function buildBriefingText({ dateLabel, events = [], tasksDue = [], unread = 0, receipts = {} } = {}) {
  const waiting = list(receipts.waiting);
  const overdue = list(receipts.overdue);
  const parts = [];
  if (events.length) parts.push(`${events.length} 个日程`);
  if (tasksDue.length) parts.push(`${tasksDue.length} 件待办到期`);
  if (unread) parts.push(`${unread} 封邮件没看`);
  if (!parts.length && !waiting.length && !overdue.length) {
    return { text: '今天没有安排，也没有待办到期，邮件都看完了。', empty: true };
  }
  const head = parts.length
    ? `${dateLabel} · 今天 ${parts.join('、')}`
    : `${dateLabel} · 今天没有安排，也没有待办到期，邮件都看完了`;
  const suffix = [];
  if (overdue.length) suffix.push(`等回信 ${overdue.length} 件超时（${shortSubject(overdue[0].subject)}）`);
  if (waiting.length) suffix.push(`等回信 ${waiting.length} 件（${shortSubject(waiting[0].subject)}）`);
  return { text: clamp(`${head}${suffix.length ? `；${suffix.join('；')}` : ''}`), empty: false };
}

/**
 * 组装简报。依赖可注入（settings / store / receipts），便于单测。
 * receipts 传 undefined 时才去读真存储；传 null 或对象都能直接用于测试。
 */
export async function buildBriefing(mailboxId, {
  now = Date.now(),
  settings = readSettings(),
  store = null,
  receipts = undefined,
} = {}) {
  const atMs = Number(now);
  const resolved = resolveBriefingMailbox(mailboxId, settings);
  const mailboxStore = store || readStore(resolved);
  const todayStart = beijingDayStart(atMs);
  const todayEnd = todayStart + DAY_MS;
  const events = collectTodayEvents(mailboxStore.events, todayStart, todayEnd);
  const tasksDue = collectDueTasks(mailboxStore.tasks, todayEnd);
  const unread = list(mailboxStore.emails).filter((email) => email?.seen === false).length;
  const summary = receipts === undefined ? await receiptSummary(resolved, { now: atMs }) : receipts;
  const { text: body, empty } = buildBriefingText({
    dateLabel: beijingLabel(atMs), events, tasksDue, unread, receipts: summary,
  });
  return {
    mailboxId: resolved,
    generatedAt: beijingIso(atMs),
    date: beijingDate(atMs),
    events,
    tasksDue,
    unread,
    receipts: { waiting: list(summary?.waiting), overdue: list(summary?.overdue) },
    text: body,
    empty,
  };
}
