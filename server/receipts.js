/**
 * 等回执：发出邮件之后跟踪对方有没有回，超时就落成一条真实待办。
 *
 * 存储落在 assistant-state 的 `receipts` 命名空间（本地 JSON 或 PostgreSQL 权威），每个邮箱一份：
 *   { schemaVersion: 1, items: [...] }
 *
 * 纪律：
 *  - 只在「真的发出去了」（outbound.status === 'sent' 且有 messageId）之后建记录，绝不预判；
 *  - `awaitReplyDays` 缺省 0 表示不跟踪，范围 0–60，越界直接 400，不猜用户的意思；
 *  - 「已回」的判断分三档，从强到弱：In-Reply-To 完全等于我们发出的 Message-ID（in-reply-to）、
 *    References 里出现过它（reference）、主题归一化后相同且至少一个参与地址有交集（subject）。
 *    第三档是兜底，可能误判，所以记录里必须写明 matchedBy='subject'，界面要能看到依据；
 *  - 超时建待办是幂等的：待办 id 就是 receipt.taskId，跑多少次都只有一条，也不动无关记录；
 *  - 检查只扫 receivedAt 晚于 sentAt 的本地邮件，不发 IMAP、不调模型。
 *
 * 时间一律存 ISO；北京时间的格式化只用于给人看的字段（description）。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readAssistantState, mutateAssistantState } from './assistant-state.js';
import { readStore, saveStore } from './store.js';

export const NAMESPACE = 'receipts';
export const SCHEMA_VERSION = 1;
export const MAX_AWAIT_REPLY_DAYS = 60;
export const RECEIPT_STATUSES = ['waiting', 'answered', 'overdue', 'cancelled'];
/** 超时待办的来源标记：任务列表 / 提醒模块据此知道这条是「等回信」自动建的。 */
export const RECEIPT_TASK_SOURCE = 'mail-receipt';

const DAY_MS = 86_400_000;
const BEIJING_OFFSET = 8 * 3_600_000;
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const clone = (value) => JSON.parse(JSON.stringify(value));
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const addressList = (value) => list(value).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);

/** 给用户看的北京时间字符串（只用于描述文案，不参与任何比较）。 */
export function beijingIso(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms + BEIJING_OFFSET).toISOString().replace(/\.\d{3}Z$/, '+08:00') : null;
}

/** 去掉 `Re:` / `Fwd:` / `回复：` / `转发：` 前缀，去掉全部空白并小写。纯函数。 */
const SUBJECT_PREFIX = /^\s*(?:re|fw|fwd|回复|答复|转发|回)\s*[:：]\s*/i;
export function normalizeSubject(value) {
  let subject = String(value ?? '');
  for (;;) {
    const next = subject.replace(SUBJECT_PREFIX, '');
    if (next === subject) break;
    subject = next;
  }
  return subject.replace(/\s+/g, '').toLowerCase();
}

/** 参与地址集合的稳定哈希：去重、小写、排序后再哈希，顺序变化不影响结果。 */
export function participantsHash(addresses) {
  const unique = [...new Set(addressList(addresses))].sort();
  return createHash('sha256').update(unique.join('\0')).digest('hex').slice(0, 16);
}

/** 归一化主题 + 参与地址集合的稳定哈希。纯函数，可单测。 */
export function threadKeyFor(subject, addresses) {
  return `${normalizeSubject(subject)}#${participantsHash(addresses)}`;
}

/**
 * 判断一封来信是不是这条回执的回信。纯函数：返回 null 或 { matchedBy }。
 * 三档依据按优先级短路，兜底档必须显式标出 matchedBy='subject'。
 */
export function matchReceipt(receipt, email) {
  if (!receipt || !email) return null;
  const messageId = String(receipt.messageId || '').trim();
  if (messageId) {
    if (String(email.inReplyTo || '').trim() === messageId) return { matchedBy: 'in-reply-to' };
    const references = Array.isArray(email.references)
      ? email.references
      : String(email.references || '').split(/\s+/);
    if (references.map((item) => String(item || '').trim()).includes(messageId)) return { matchedBy: 'reference' };
  }
  const subject = normalizeSubject(receipt.subject);
  if (!subject) return null;
  if (normalizeSubject(email.subject) !== subject) return null;
  const participants = new Set([...addressList(receipt.to), ...addressList(receipt.cc)]);
  const incoming = [email.senderAddress, ...list(email.to), ...list(email.cc)]
    .map((item) => String(item || '').trim().toLowerCase());
  return incoming.some((address) => address && participants.has(address)) ? { matchedBy: 'subject' } : null;
}

/** 对外形态：字段固定，避免把内部字段漏给界面。 */
export function publicReceipt(item = {}) {
  return {
    id: item.id,
    mailboxId: item.mailboxId || null,
    outboundId: item.outboundId || null,
    messageId: item.messageId || null,
    to: addressList(item.to),
    cc: addressList(item.cc),
    subject: item.subject || '',
    threadKey: item.threadKey || null,
    sentAt: item.sentAt || null,
    dueAt: item.dueAt || null,
    awaitReplyDays: Number(item.awaitReplyDays) || 0,
    status: item.status,
    answeredAt: item.answeredAt || null,
    answerEmailId: item.answerEmailId || null,
    matchedBy: item.matchedBy || null,
    taskId: item.taskId || null,
    createdAt: item.createdAt || null,
    updatedAt: item.updatedAt || null,
  };
}

/** ISO 化 sentAt：容错接受 epoch 毫秒 / ISO 字符串。 */
function sentAtIso(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * 派发成功后建一条回执记录。
 * 只有「已发出」才有意义，其余情况一律返回 null（不报错，因为派发链路上不该被回执拖住）。
 * `awaitReplyDays <= 0` 表示用户没有要求跟踪，同样返回 null。
 */
export async function createReceipt(mailboxId, outbound = {}, {
  awaitReplyDays,
  now = Date.now(),
  mutateState = mutateAssistantState,
} = {}) {
  if (!outbound || outbound.status !== 'sent' || !outbound.messageId) return null;
  const days = awaitReplyDays === undefined || awaitReplyDays === null
    ? Number(outbound.awaitReplyDays) || 0
    : Number(awaitReplyDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  if (!Number.isInteger(days) || days > MAX_AWAIT_REPLY_DAYS) {
    throw fail(`等回信天数请填 0–${MAX_AWAIT_REPLY_DAYS} 的整数。`, 400, 'RECEIPT_AWAIT_DAYS_INVALID');
  }
  const sentAt = sentAtIso(outbound.sentAt || now);
  if (!sentAt) throw fail('这条出站记录没有可用的发出时间，不能跟踪回信。', 400, 'RECEIPT_SENT_AT_INVALID');
  const to = addressList(outbound.to);
  const cc = addressList(outbound.cc);
  const subject = text(outbound.subject, 500);
  const dueAt = new Date(Date.parse(sentAt) + days * DAY_MS).toISOString();
  const stamp = new Date(Number(now)).toISOString();
  const outcome = await mutateState(mailboxId, NAMESPACE, (data) => {
    data.schemaVersion = SCHEMA_VERSION;
    if (!Array.isArray(data.items)) data.items = [];
    if (outbound.id && data.items.some((item) => item.outboundId === outbound.id)) {
      return { created: false, item: null };
    }
    const item = {
      id: randomUUID(), mailboxId, outboundId: outbound.id || null, messageId: outbound.messageId,
      to, cc, subject, threadKey: threadKeyFor(subject, [...to, ...cc]),
      sentAt, dueAt, awaitReplyDays: days, status: 'waiting',
      answeredAt: null, answerEmailId: null, matchedBy: null, taskId: null,
      createdAt: stamp, updatedAt: stamp,
    };
    data.items.push(item);
    return { created: true, item: clone(item) };
  });
  return outcome?.created ? publicReceipt(outcome.item) : null;
}

/** 列表：最新在前；counts 覆盖该邮箱全部记录，不只是本页。 */
export async function listReceipts(mailboxId, {
  status = '',
  limit = 100,
  readState = readAssistantState,
} = {}) {
  const wanted = String(status || '').trim();
  if (wanted && !RECEIPT_STATUSES.includes(wanted)) {
    throw fail(`回执状态只能是 ${RECEIPT_STATUSES.join(' / ')}。`, 400, 'RECEIPT_STATUS_INVALID');
  }
  const data = await readState(mailboxId, NAMESPACE);
  const items = list(data.items);
  const counts = { waiting: 0, answered: 0, overdue: 0, cancelled: 0 };
  for (const item of items) if (counts[item.status] !== undefined) counts[item.status] += 1;
  const size = Math.max(1, Math.min(200, Number(limit) || 100));
  const receipts = [...items]
    .filter((item) => !wanted || item.status === wanted)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || String(b.id).localeCompare(String(a.id)))
    .slice(0, size)
    .map(publicReceipt);
  return { receipts, counts };
}

/** 简报要的「还在等 / 已超时」两档。waiting 但已过 dueAt 也按 overdue 呈现，不假装还在等。 */
export async function receiptSummary(mailboxId, { now = Date.now(), state = null } = {}) {
  const data = state || await readAssistantState(mailboxId, NAMESPACE);
  const waiting = [];
  const overdue = [];
  for (const item of list(data.items)) {
    if (!['waiting', 'overdue'].includes(item.status)) continue;
    const dueMs = Date.parse(item.dueAt || '');
    const late = item.status === 'overdue' || (Number.isFinite(dueMs) && now > dueMs);
    const entry = { id: item.id, subject: item.subject || '', to: addressList(item.to), sentAt: item.sentAt || null, dueAt: item.dueAt || null };
    if (late) overdue.push({ ...entry, daysLate: Number.isFinite(dueMs) ? Math.max(0, Math.floor((now - dueMs) / DAY_MS)) : 0 });
    else waiting.push({ ...entry, daysLeft: Number.isFinite(dueMs) ? Math.max(0, Math.ceil((dueMs - now) / DAY_MS)) : 0 });
  }
  return { waiting, overdue };
}

function eligibleEmails(emails, sentMs) {
  if (!Number.isFinite(sentMs)) return [];
  return emails
    .map((email) => ({ email, at: Date.parse(email?.receivedAt) }))
    .filter((entry) => Number.isFinite(entry.at) && entry.at > sentMs)
    .sort((a, b) => a.at - b.at)
    .map((entry) => entry.email);
}

function taskTitle(receipt) {
  return `等回信：${text(receipt.subject, 200) || '（无主题）'}`;
}

function taskDescription(receipt, now) {
  const to = addressList(receipt.to);
  const sentMs = Date.parse(receipt.sentAt || '');
  const waited = Number.isFinite(sentMs) ? Math.max(0, Math.floor((Number(now) - sentMs) / DAY_MS)) : 0;
  return `收件人：${to.join('、') || '（未记录）'}；发出时间：${beijingIso(receipt.sentAt) || receipt.sentAt || '未知'}；已等 ${waited} 天。如果对方已回但这里是旧的，请手动完成。`;
}

/**
 * 纯逻辑：改写传入的 receipt items（就地），并给出待办计划。
 * 待办 id 复用 receipt.taskId（首次生成），所以重复跑不会多建一条。
 */
export function planReceiptChecks(items, emails, now) {
  const atMs = Number(now);
  const tasks = [];
  let answered = 0;
  let newlyOverdue = 0;
  for (const item of list(items)) {
    if (!['waiting', 'overdue'].includes(item.status)) continue;
    const sentMs = Date.parse(item.sentAt || '');
    const hit = eligibleEmails(emails, sentMs)
      .map((email) => ({ email, match: matchReceipt(item, email) }))
      .find((entry) => entry.match);
    if (hit) {
      const replyMs = Date.parse(hit.email.receivedAt);
      item.status = 'answered';
      item.answeredAt = new Date(Number.isFinite(replyMs) ? replyMs : atMs).toISOString();
      item.answerEmailId = hit.email.id || null;
      item.matchedBy = hit.match.matchedBy;
      item.updatedAt = new Date(atMs).toISOString();
      answered += 1;
      if (item.taskId) tasks.push({ taskId: item.taskId, status: 'done', completedAt: item.answeredAt });
      continue;
    }
    const dueMs = Date.parse(item.dueAt || '');
    if (item.status === 'waiting' && Number.isFinite(dueMs) && atMs > dueMs) {
      item.status = 'overdue';
      item.updatedAt = new Date(atMs).toISOString();
      newlyOverdue += 1;
    }
    if (item.status === 'overdue') {
      const taskId = item.taskId || randomUUID();
      item.taskId = taskId;
      tasks.push({ taskId, status: 'pending', title: taskTitle(item), dueAt: item.dueAt || null,
        description: taskDescription(item, atMs) });
    }
  }
  return { answered, newlyOverdue, tasks };
}

/**
 * 把待办计划落到邮箱的 tasks。待办 id 就是 taskId，所以重复执行只更新同一条。
 * 返回是否真的改动了数据，避免无谓写盘。
 */
export function applyTaskPlan(store, plans, { now = Date.now() } = {}) {
  if (!plans?.length) return { changed: false, applied: 0 };
  if (!Array.isArray(store.tasks)) store.tasks = [];
  let changed = false;
  for (const plan of plans) {
    const existing = store.tasks.find((task) => task.id === plan.taskId);
    if (!existing) {
      // 只有「建/刷新超时待办」才能新建；单纯把待办标完成时缺标题，说明它已被删除，
      // 不能凭空造一条没有标题的记录。
      if (!plan.title) continue;
      store.tasks.push({
        id: plan.taskId, title: plan.title, dueAt: plan.dueAt, priority: 'normal', assignee: '',
        description: plan.description, status: plan.status, completedAt: plan.status === 'done' ? (plan.completedAt || new Date(now).toISOString()) : null,
        source: RECEIPT_TASK_SOURCE, createdAt: new Date(now).toISOString(), sources: [],
      });
      changed = true;
      continue;
    }
    const completedAt = plan.status === 'done' ? (plan.completedAt || existing.completedAt || new Date(now).toISOString()) : null;
    const next = {
      title: plan.title || existing.title,
      dueAt: plan.dueAt === undefined ? existing.dueAt : plan.dueAt,
      description: plan.description === undefined ? existing.description : plan.description,
      status: plan.status || existing.status,
      completedAt,
    };
    if (next.title !== existing.title || next.dueAt !== existing.dueAt || next.description !== existing.description
      || next.status !== existing.status || next.completedAt !== existing.completedAt) {
      Object.assign(existing, next);
      changed = true;
    }
  }
  return { changed, applied: plans.length };
}

/**
 * 立即检查一个邮箱里所有未结的回执。
 * 依赖可注入，便于单测：readState / mutateState / load / save 全部可以替换。
 */
export async function checkReceipts(mailboxId, {
  now = Date.now(),
  store = null,
  readState = readAssistantState,
  mutateState = mutateAssistantState,
  load = readStore,
  save = saveStore,
  notifyOverdue = null,
} = {}) {
  const data = await readState(mailboxId, NAMESPACE);
  const open = list(data.items).filter((item) => ['waiting', 'overdue'].includes(item.status));
  if (!open.length) return { checked: 0, answered: 0, overdue: 0 };
  const mailboxStore = store || load(mailboxId);
  const emails = list(mailboxStore.emails);
  const outcome = await mutateState(mailboxId, NAMESPACE, (state) => {
    state.schemaVersion = SCHEMA_VERSION;
    if (!Array.isArray(state.items)) state.items = [];
    return planReceiptChecks(state.items, emails, now);
  });
  const applied = applyTaskPlan(mailboxStore, outcome.tasks, { now });
  if (applied.changed) save(mailboxStore, mailboxId);
  // 可选推送钩子：只观察「刚才有没有新的超时」，绝不改回执 / 待办本身的结论；
  // 钩子抛错也只是一条日志，不能影响回执与待办的既有行为。
  if (notifyOverdue) {
    try { await notifyOverdue(mailboxId, { now }); }
    catch (error) {
      console.warn(JSON.stringify({ event: 'receipts_notify_hook_failed', mailboxId, reason: error?.message || String(error) }));
    }
  }
  return { checked: open.length, answered: outcome.answered, overdue: outcome.newlyOverdue };
}

/** 取消跟踪：只对还在等 / 已超时生效；取消时把已建的待办标完成。 */
export async function cancelReceipt(mailboxId, id, {
  now = Date.now(),
  readState = readAssistantState,
  mutateState = mutateAssistantState,
  load = readStore,
  save = saveStore,
} = {}) {
  const outcome = await mutateState(mailboxId, NAMESPACE, (data) => {
    const item = list(data.items).find((entry) => entry.id === id);
    if (!item) throw fail('这条回执记录不存在或不属于当前邮箱。', 404, 'RECEIPT_NOT_FOUND');
    if (!['waiting', 'overdue'].includes(item.status)) {
      throw fail('只有还在等回信的记录可以取消。', 409, 'RECEIPT_NOT_CANCELLABLE');
    }
    item.status = 'cancelled';
    item.updatedAt = new Date(Number(now)).toISOString();
    return { receipt: publicReceipt(clone(item)), taskId: item.taskId || null };
  });
  let taskCompleted = false;
  if (outcome.taskId) {
    const store = load(mailboxId);
    const applied = applyTaskPlan(store, [{ taskId: outcome.taskId, status: 'done', completedAt: new Date(Number(now)).toISOString() }], { now });
    if (applied.changed) { save(store, mailboxId); taskCompleted = true; }
  }
  return { receipt: outcome.receipt, taskCompleted };
}
