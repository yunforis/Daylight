/**
 * 出站邮件：手写回复 / 回复全部、发件身份与签名、定时发送、撤销发送（发送前窗口）。
 *
 * 记录存在 assistant-state 的 `outbound` 命名空间（本地 JSON 或 PostgreSQL 权威），
 * 每个邮箱一份。核心纪律：
 *  - 连 SMTP 之前先把记录原子置成 `sending`（屏障）。写屏障成功才允许发信，
 *    这样重试、并发和重复请求都不会重复投递（与 assistant-actions 的既有做法一致）。
 *  - SMTP 返回后回执写失败 → `unknown`，绝不重发；SMTP 抛错 → `failed`（可重试）。
 *  - `cancel` 只对还没到点的 `scheduled` 生效。已经发出去的邮件无法撤回，也不是
 *    「邮件召回」——API 会如实返回 409 + OUTBOUND_NOT_CANCELLABLE。
 *  - 发信成功后 best-effort 追加到真邮箱「已发送」文件夹，失败只记 sentFolderError，
 *    绝不影响已发出的 sent 状态。
 *
 * 时间一律用 ISO 字符串 / epoch 毫秒，不存本地时区字符串。
 */
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import addressparser from 'nodemailer/lib/addressparser';
import { appendMailboxMessage, listMailboxFolders, resolveMailFolder, sendMailboxMessage } from './agent.js';
import { readSettings } from './store.js';
import { mutateAssistantState, readAssistantState } from './assistant-state.js';
import { sanitizeSnapshot } from './traces.js';
import { createReceipt, MAX_AWAIT_REPLY_DAYS } from './receipts.js';

const NAMESPACE = 'outbound';
export const DEFAULT_UNDO_SECONDS = 10;
export const MAX_UNDO_SECONDS = 120;
export const MAX_BODY_LENGTH = 200_000;
export const MAX_SUBJECT_LENGTH = 500;
export const MAX_RECIPIENTS = 50;
/** 超过这个时间仍然停在 `sending` 的记录视为不可核验，收敛成 unknown，绝不重发。 */
const STALE_SENDING_MS = 5 * 60_000;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const iso = (value) => new Date(value).toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));

/** 一个「像地址」的判断：必须有且只有一段 @、两边非空、不含空白与分隔符。 */
export function isMailAddress(value) {
  const address = String(value || '').trim();
  return address.length > 0 && address.length <= 254 && /^[^\s@,;<>]+@[^\s@,;<>]+$/.test(address);
}

/**
 * 收件人解析：接受字符串或数组，逗号 / 分号 / 换行分隔，并支持 `姓名 <地址>`。
 * 解析不出地址的片段一律 400 MAIL_RECIPIENT_INVALID，不静默丢掉用户写的第 4 个收件人。
 */
export function parseMailRecipients(value, { limit = MAX_RECIPIENTS } = {}) {
  const parts = Array.isArray(value) ? value : [value];
  const addresses = [];
  for (const part of parts) {
    if (part === undefined || part === null || part === '') continue;
    if (typeof part !== 'string') throw fail('收件人必须是明确的邮箱地址。', 400, 'MAIL_RECIPIENT_INVALID');
    for (const line of part.split(/\r?\n/)) {
      if (!line.trim()) continue;
      for (const item of addressparser(line)) {
        const address = String(item.address || '').trim().toLowerCase();
        if (!isMailAddress(address)) {
          throw fail(`「${line.trim()}」不是有效的邮箱地址。`, 400, 'MAIL_RECIPIENT_INVALID');
        }
        if (!addresses.includes(address)) addresses.push(address);
      }
    }
  }
  if (addresses.length > limit) throw fail(`收件人最多 ${limit} 个。`, 400, 'MAIL_RECIPIENT_INVALID');
  return addresses;
}

function looksLikeHtml(value) {
  return /<\/?[a-z][\s\S]*>/i.test(String(value || ''));
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

export function storeMailBody(body, signature) {
  const sign = typeof signature === 'string' ? signature.trim() : '';
  if (looksLikeHtml(body)) {
    if (!sign || String(body).includes(sign)) return String(body);
    return `${body}<p>${escapeHtml(sign).replace(/\n/g, '<br>')}</p>`;
  }
  return appendSignatureText(body, sign);
}

export function htmlToText(value) {
  return String(value || '').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 签名追加：正文已经以签名结尾就不再重复追加。纯函数，便于单测。 */
export function appendSignatureText(body, signature) {
  const text = String(body ?? '');
  const sign = typeof signature === 'string' ? signature.trim() : '';
  if (!sign) return text;
  if (text.trimEnd().endsWith(sign)) return text;
  const trimmed = text.replace(/\s+$/, '');
  return trimmed ? `${trimmed}\n\n${sign}\n` : `${sign}\n`;
}

/** 对外形态：不泄露 operationKey / idempotencyKey / outgoingMessageId 这类内部字段。 */
export function publicOutbound(record) {
  const {
    id, mailboxId, from, fromName, to, cc, bcc, subject, body, signature, status,
    sendAt, createdAt, updatedAt, attemptedAt, sentAt, messageId, delivery, error, retryable,
    threadKey, inReplyTo, references, sentFolderAppended, sentFolderError, source,
  } = record;
  return {
    id, mailboxId, from, fromName, to, cc, bcc, subject, body, signature, status,
    sendAt, createdAt, updatedAt, attemptedAt: attemptedAt || null, sentAt: sentAt || null,
    messageId: messageId || null, delivery: delivery || null, error: error || null,
    retryable: retryable === true, threadKey: threadKey || null, inReplyTo: inReplyTo || null,
    references: references || [], sentFolderAppended: sentFolderAppended === true,
    sentFolderError: sentFolderError || '', source,
  };
}

/**
 * 组装 sendMailboxMessage 需要的那封信。`from` 规则：
 * fromName 非空 → `显示名 <邮箱地址>`，否则只用邮箱地址。
 * 正文里的签名由 appendSignatureText 保证只追加一次（记录里 body 已含签名时不会重复）。
 */
export function buildOutboundMessage(record, { mailbox = {} } = {}) {
  const address = String(mailbox.email || record.from || '').trim();
  const fromName = String(mailbox.fromName || record.fromName || '').trim();
  const from = fromName && address ? `${fromName} <${address}>` : address;
  const cc = Array.isArray(record.cc) ? record.cc.filter(Boolean) : [];
  const bcc = Array.isArray(record.bcc) ? record.bcc.filter(Boolean) : [];
  const references = Array.isArray(record.references) ? record.references.filter(Boolean) : [];
  return {
    to: Array.isArray(record.to) ? [...record.to] : [],
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    subject: String(record.subject || '') || '（无主题）',
    ...(looksLikeHtml(record.body)
      ? { text: htmlToText(record.body) || '（无正文）', html: String(record.body) }
      : { text: appendSignatureText(record.body, record.signature) }),
    ...(from ? { from } : {}),
    ...(record.outgoingMessageId ? { messageId: record.outgoingMessageId } : {}),
    ...(record.inReplyTo ? { inReplyTo: record.inReplyTo } : {}),
    ...(references.length ? { references } : {}),
  };
}

/** 用 nodemailer 的 streamTransport 把同一封信编译成原始 MIME（不连网），供 IMAP APPEND。 */
export async function compileOutboundRaw(message) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  try {
    const info = await transport.sendMail(message);
    return Buffer.isBuffer(info.message) ? info.message : Buffer.from(info.message || '');
  } finally {
    try { transport.close?.(); } catch { /* ignore */ }
  }
}

function singleLine(value, max, code, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (/[\r\n\0]/.test(text)) throw fail(`${label}不能包含换行或控制字符。`, 400, code);
  if (text.length > max) throw fail(`${label}不能超过 ${max} 个字符。`, 400, code);
  return text;
}

function normalizeReferences(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/) : [];
  const references = [];
  for (const item of list) {
    const text = singleLine(item, 998, 'MAIL_REFERENCES_INVALID', 'References');
    if (text && !references.includes(text)) references.push(text);
    if (references.length >= MAX_RECIPIENTS) break;
  }
  return references;
}

function parseSendAt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string') return NaN;
  const text = value.trim();
  if (!text) return NaN;
  if (/^\d{10,}$/.test(text)) return Number(text);
  return Date.parse(text);
}

function mailboxFor(settings, mailboxId) {
  const mailbox = (settings.mailboxes || []).find((item) => item.id === mailboxId);
  // 不是自己的邮箱一律 403：不区分「不存在」和「别人的」，避免泄露归属。
  if (!mailbox) throw fail('邮箱不存在或不属于当前用户。', 403, 'MAILBOX_FORBIDDEN');
  return mailbox;
}

function outgoingMessageIdFor(id, email) {
  const domain = String(email || '').split('@')[1] || 'daylight.invalid';
  return `<daylight-outbound-${id}@${domain}>`;
}

function safeError(error, settings) {
  const secrets = [settings?.authorizationCode, settings?.apiKey, settings?.feishu?.appSecret,
    ...(settings?.mailboxes || []).map((mailbox) => mailbox.authorizationCode)].filter(Boolean);
  return sanitizeSnapshot(String(error?.message || '发送失败'), secrets);
}

/**
 * 创建一条出站记录。不做任何网络调用，只落库（scheduled）。
 * 422/400 类输入错误都带 code，调用方直接透出即可。
 */
export async function composeOutbound(mailboxId, input = {}, { settings = readSettings(), now = Date.now() } = {}) {
  const mailbox = mailboxFor(settings, mailboxId);
  const email = String(mailbox.email || '').trim().toLowerCase();
  if (!email) throw fail('请先在设置中保存这个邮箱的地址，再写邮件。', 400, 'MAILBOX_SETUP_REQUIRED');

  const asDraft = input.draft === true;
  const to = parseMailRecipients(input.to);
  if (!asDraft && !to.length) throw fail('请至少填写一个收件人。', 400, 'MAIL_RECIPIENT_REQUIRED');
  const cc = parseMailRecipients(input.cc);
  const bcc = parseMailRecipients(input.bcc);
  const body = typeof input.body === 'string' ? input.body : '';
  if (!asDraft && !body.trim()) throw fail('邮件正文不能为空。', 400, 'MAIL_BODY_REQUIRED');
  if (body.length > MAX_BODY_LENGTH) throw fail(`邮件正文不能超过 ${MAX_BODY_LENGTH} 个字符。`, 400, 'MAIL_BODY_TOO_LONG');
  const subject = singleLine(input.subject, MAX_SUBJECT_LENGTH, 'MAIL_SUBJECT_INVALID', '邮件主题');

  const atMs = Number(now);
  let sendAtMs = null;
  if (asDraft) {
    sendAtMs = null;
  } else if (input.sendAt === undefined || input.sendAt === null || input.sendAt === '') {
    const seconds = input.undoSeconds === undefined || input.undoSeconds === null ? DEFAULT_UNDO_SECONDS : Number(input.undoSeconds);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_UNDO_SECONDS) {
      throw fail(`撤销窗口请填 0–${MAX_UNDO_SECONDS} 秒。`, 400, 'MAIL_UNDO_WINDOW_INVALID');
    }
    sendAtMs = atMs + Math.round(seconds * 1000);
  } else {
    sendAtMs = parseSendAt(input.sendAt);
    if (!Number.isFinite(sendAtMs)) throw fail('定时发送时间无法识别，请用 ISO 时间或毫秒时间戳。', 400, 'MAIL_SEND_AT_INVALID');
    if (sendAtMs <= atMs) throw fail('定时发送时间必须晚于当前时间。', 400, 'MAIL_SEND_AT_INVALID');
  }

  const idempotencyKey = input.idempotencyKey === undefined || input.idempotencyKey === null || input.idempotencyKey === ''
    ? null
    : singleLine(input.idempotencyKey, 200, 'MAIL_IDEMPOTENCY_INVALID', '幂等键');
  // 等回执：0（缺省）表示不跟踪。只存进记录，广播时由派发钩子 createReceipt 使用；
  // 不在 publicOutbound 里外泄，避免把内部字段混进对外形态。
  const awaitReplyDays = input.awaitReplyDays === undefined || input.awaitReplyDays === null || input.awaitReplyDays === ''
    ? 0
    : Number(input.awaitReplyDays);
  if (!Number.isInteger(awaitReplyDays) || awaitReplyDays < 0 || awaitReplyDays > MAX_AWAIT_REPLY_DAYS) {
    throw fail(`等回信天数请填 0–${MAX_AWAIT_REPLY_DAYS} 的整数（0 表示不跟踪）。`, 400, 'MAIL_AWAIT_REPLY_DAYS_INVALID');
  }
  const inReplyTo = singleLine(input.inReplyTo, 998, 'MAIL_REFERENCES_INVALID', 'In-Reply-To') || null;
  const references = normalizeReferences(input.references);
  const signature = typeof mailbox.signature === 'string' ? mailbox.signature.trim() : '';
  const fromName = typeof mailbox.fromName === 'string' ? mailbox.fromName.trim() : '';
  const usedSignature = input.useSignature === false ? '' : signature;
  const storedBody = storeMailBody(body, usedSignature);

  const outcome = await mutateAssistantState(mailboxId, NAMESPACE, (data) => {
    if (idempotencyKey) {
      const existing = (data.items || []).find((item) => item.idempotencyKey === idempotencyKey);
      if (existing) return { record: clone(existing), reused: true };
    }
    const id = randomUUID();
    const createdAt = iso(atMs);
    const record = {
      id, mailboxId, from: email, fromName,
      to, cc, bcc, subject,
      body: storedBody,
      signature: usedSignature,
      status: asDraft ? 'draft' : 'scheduled',
      sendAt: sendAtMs == null ? null : iso(sendAtMs), createdAt, updatedAt: createdAt,
      attemptedAt: null, sentAt: null, messageId: null, delivery: null,
      error: null, retryable: false,
      operationKey: `outbound:${id}`,
      idempotencyKey,
      awaitReplyDays,
      threadKey: inReplyTo || references.at(-1) || null,
      inReplyTo, references,
      outgoingMessageId: outgoingMessageIdFor(id, email),
      source: inReplyTo ? 'reply' : 'compose',
    };
    data.items.push(record);
    return { record: clone(record), reused: false };
  });
  return { outbound: publicOutbound(outcome.record), reused: outcome.reused };
}

/** 改一封还没发出的草稿。send 为 true 时转入撤销窗口，由既有派发发送。 */
export async function updateOutboundDraft(mailboxId, id, input = {}, { settings = readSettings(), now = Date.now() } = {}) {
  const mailbox = mailboxFor(settings, mailboxId);
  const signature = typeof mailbox.signature === 'string' ? mailbox.signature.trim() : '';
  const usedSignature = input.useSignature === false ? '' : signature;
  const atMs = Number(now);
  const outcome = await mutateAssistantState(mailboxId, NAMESPACE, (data) => {
    const item = (data.items || []).find((entry) => entry.id === id);
    if (!item || item.status !== 'draft') throw fail('这封草稿已经不在草稿箱。', 409, 'MAIL_DRAFT_GONE');
    if (input.to !== undefined) item.to = parseMailRecipients(input.to);
    if (input.cc !== undefined) item.cc = parseMailRecipients(input.cc);
    if (input.bcc !== undefined) item.bcc = parseMailRecipients(input.bcc);
    if (input.subject !== undefined) item.subject = singleLine(input.subject, MAX_SUBJECT_LENGTH, 'MAIL_SUBJECT_INVALID', '邮件主题');
    if (input.body !== undefined) item.body = storeMailBody(String(input.body), usedSignature);
    item.signature = usedSignature;
    item.updatedAt = iso(atMs);
    if (input.send === true) {
      if (!item.to?.length) throw fail('请至少填写一个收件人。', 400, 'MAIL_RECIPIENT_REQUIRED');
      if (!String(item.body || '').trim()) throw fail('邮件正文不能为空。', 400, 'MAIL_BODY_REQUIRED');
      item.status = 'scheduled';
      item.sendAt = iso(atMs + DEFAULT_UNDO_SECONDS * 1000);
    }
    return clone(item);
  });
  return { outbound: publicOutbound(outcome) };
}

/** 列表：最新在前；counts 覆盖该邮箱全部记录，不只是本页。 */
export async function listOutbound(mailboxId, { limit = 50 } = {}) {
  const size = Math.max(1, Math.min(200, Number(limit) || 50));
  const data = await readAssistantState(mailboxId, NAMESPACE);
  const items = data.items || [];
  const counts = { scheduled: 0, sending: 0, sent: 0, failed: 0, unknown: 0, cancelled: 0 };
  for (const item of items) if (counts[item.status] !== undefined) counts[item.status] += 1;
  const outbound = [...items]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || String(b.id).localeCompare(String(a.id)))
    .slice(0, size)
    .map(publicOutbound);
  return { outbound, counts };
}

export async function readOutbound(mailboxId, id) {
  const data = await readAssistantState(mailboxId, NAMESPACE);
  const record = (data.items || []).find((item) => item.id === id);
  if (!record) throw fail('这条待发邮件不存在或不属于当前邮箱。', 404, 'OUTBOUND_NOT_FOUND');
  return { outbound: publicOutbound(record) };
}

const NOT_CANCELLABLE = '邮件已经在投递或已发出，不能撤回。已经发出去的邮件无法收回，请到发件邮箱核对。';

/** 撤销发送（只对还在撤销窗口里的 scheduled 生效）。 */
export async function cancelOutbound(mailboxId, id, { now = Date.now() } = {}) {
  const record = await mutateAssistantState(mailboxId, NAMESPACE, (data) => {
    const item = (data.items || []).find((entry) => entry.id === id);
    if (!item) throw fail('这条待发邮件不存在或不属于当前邮箱。', 404, 'OUTBOUND_NOT_FOUND');
    if (item.status !== 'scheduled') {
      throw fail(NOT_CANCELLABLE, 409, 'OUTBOUND_NOT_CANCELLABLE');
    }
    Object.assign(item, { status: 'cancelled', updatedAt: iso(now), retryable: false });
    return clone(item);
  });
  return { outbound: publicOutbound(record) };
}

/** 立即发送：把 sendAt 提前到现在（状态保持 scheduled），真正的投递交给 dispatchDueOutbound。 */
export async function markOutboundSentNow(mailboxId, id, { now = Date.now() } = {}) {
  const record = await mutateAssistantState(mailboxId, NAMESPACE, (data) => {
    const item = (data.items || []).find((entry) => entry.id === id);
    if (!item) throw fail('这条待发邮件不存在或不属于当前邮箱。', 404, 'OUTBOUND_NOT_FOUND');
    if (item.status !== 'scheduled') throw fail('只有还没到发送时间的邮件可以「立即发送」。', 409, 'OUTBOUND_NOT_CANCELLABLE');
    Object.assign(item, { sendAt: iso(now), updatedAt: iso(now) });
    return clone(item);
  });
  return { outbound: publicOutbound(record) };
}

function isStaleSending(record, atMs) {
  if (record?.status !== 'sending') return false;
  const attempted = Date.parse(record.attemptedAt || '');
  return !Number.isFinite(attempted) || atMs - attempted >= STALE_SENDING_MS;
}

/**
 * 把已发出的邮件 best-effort 追加到真邮箱「已发送」文件夹。
 * 任何失败都只返回 sentFolderError，不影响 sent 状态。
 */
async function appendToSentFolder(settings, message, { appendSent, listFolders, compileRaw, sanitize }) {
  try {
    let folder = null;
    try {
      folder = resolveMailFolder(await listFolders(settings), 'sent');
    } catch (error) {
      return { sentFolderAppended: false, sentFolderError: `读取真邮箱文件夹失败：${sanitize(error)}` };
    }
    if (!folder) return { sentFolderAppended: false, sentFolderError: '真邮箱里没找到「已发送」文件夹，这封邮件没有留档。' };
    const raw = await compileRaw(message);
    await appendSent(settings, { folder, raw });
    return { sentFolderAppended: true, sentFolderError: '' };
  } catch (error) {
    return { sentFolderAppended: false, sentFolderError: sanitize(error) };
  }
}

/**
 * 派发到点的出站邮件。找出 `scheduled` 且 `sendAt <= now` 的记录，按 sendAt 升序最多 limit 条。
 * 依赖全部可注入，便于单测；不依赖真实 SMTP / IMAP。
 * 单条失败不中断整批；返回 { attempted, sent, failed, unknown, reaped }。
 */
export async function dispatchDueOutbound({
  now = Date.now(),
  limit = 5,
  settings = readSettings(),
  mailboxIds = null,
  ids = null,
  readState = readAssistantState,
  mutateState = mutateAssistantState,
  sendMail = sendMailboxMessage,
  appendSent = appendMailboxMessage,
  listFolders = listMailboxFolders,
  compileRaw = compileOutboundRaw,
  sanitize = (error) => String(error?.message || error || '发送失败'),
  receiptHook = createReceipt,
} = {}) {
  const atMs = Number(now);
  let remaining = Math.max(1, Number(limit) || 5);
  const summary = { attempted: 0, sent: 0, failed: 0, unknown: 0, reaped: 0 };
  const boxes = (settings.mailboxes || []).filter((box) => box?.email && (!mailboxIds || mailboxIds.includes(box.id)));

  for (const box of boxes) {
    if (remaining <= 0) break;
    let data = await readState(box.id, NAMESPACE);
    // 崩溃/超时留下的 sending 屏障不能永远卡住：超过 5 分钟收敛成 unknown（绝不重发）。
    const stale = (data.items || []).filter((item) => isStaleSending(item, atMs));
    if (stale.length) {
      await mutateState(box.id, NAMESPACE, (state) => {
        for (const item of state.items || []) {
          if (!isStaleSending(item, atMs)) continue;
          Object.assign(item, { status: 'unknown', retryable: false, updatedAt: iso(atMs),
            error: '发送请求超过 5 分钟没有留下可核验的回执；为避免重复发信不再重试，请到发件邮箱核对。' });
          summary.reaped += 1;
        }
        return null;
      });
      data = await readState(box.id, NAMESPACE);
    }

    const due = (data.items || [])
      .filter((item) => item.status === 'scheduled' && Number.isFinite(Date.parse(item.sendAt)) && Date.parse(item.sendAt) <= atMs)
      .filter((item) => !ids || ids.includes(item.id))
      .sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt) || Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(0, remaining);

    for (const candidate of due) {
      if (remaining <= 0) break;
      const outcome = await dispatchOne(candidate.id, box, settings, atMs, {
        mutateState, sendMail, appendSent, listFolders, compileRaw, sanitize, receiptHook,
      });
      // null = 别人已经抢先派发 / 状态或时间已经变了，这一条不计入本次尝试。
      if (!outcome) continue;
      remaining -= 1;
      summary.attempted += 1;
      summary[outcome] += 1;
    }
  }
  return summary;
}

async function dispatchOne(id, box, settings, atMs, { mutateState, sendMail, appendSent, listFolders, compileRaw, sanitize, receiptHook }) {
  // 1) 先写 sending 屏障。写不进去就什么都不做（宁可下一拍再来，也不能重复发）。
  const claimed = await mutateState(box.id, NAMESPACE, (data) => {
    const item = (data.items || []).find((entry) => entry.id === id);
    if (!item || item.status !== 'scheduled') return null;
    if (!Number.isFinite(Date.parse(item.sendAt)) || Date.parse(item.sendAt) > atMs) return null;
    Object.assign(item, { status: 'sending', attemptedAt: iso(atMs), updatedAt: iso(atMs), error: null });
    return clone(item);
  });
  if (!claimed) return null;

  const mailboxSettings = { ...settings, ...box, mailboxes: [box], activeMailboxId: box.id };
  const message = buildOutboundMessage(claimed, { mailbox: box });
  const stamp = () => new Date().toISOString();
  let info;
  try {
    info = await sendMail(mailboxSettings, message);
  } catch (error) {
    const redacted = sanitize(error);
    // SMTP 抛错但回执里已经出现被接受的收件人 → 不敢重发；其余按「未发出」处理，可重试。
    const delivered = Array.isArray(error?.accepted) && error.accepted.length > 0;
    const receipt = delivered
      ? { status: 'unknown', retryable: false, updatedAt: stamp(),
        error: `${redacted}；SMTP 已接受部分收件人，请在发件邮箱核对，不能重发。` }
      : { status: 'failed', retryable: true, updatedAt: stamp(),
        error: `${redacted}；邮件尚未被服务接受，可以核对后重试。` };
    await saveReceipt(box.id, id, receipt, mutateState, stamp());
    return receipt.status;
  }

  const accepted = (info?.accepted || []).map((value) => String(typeof value === 'string' ? value : value?.address || '').toLowerCase()).filter(Boolean);
  const rejected = (info?.rejected || []).map((value) => String(typeof value === 'string' ? value : value?.address || '').toLowerCase()).filter(Boolean);
  const sentAt = stamp();
  const appended = await appendToSentFolder(mailboxSettings, message, { appendSent, listFolders, compileRaw, sanitize });
  const receipt = {
    status: 'sent', retryable: false, updatedAt: sentAt,
    sentAt, messageId: info?.messageId || claimed.outgoingMessageId || null,
    delivery: { accepted, rejected },
    error: null,
    ...appended,
  };
  const saved = await saveReceipt(box.id, id, receipt, mutateState, sentAt);
  // 邮件已经出去了；回执没落盘也不能重发。用户看到的是 unknown，不是 sent。
  // 「建等回执」只在真的发出去并且回执照常落盘后执行，钩子失败也绝不能改回 sent 状态。
  if (saved) {
    try {
      await receiptHook(box.id, { ...claimed, ...receipt }, { now: atMs });
    } catch (error) {
      console.warn(JSON.stringify({ event: 'outbound_receipt_hook_failed', mailboxId: box.id, outboundId: id,
        reason: sanitize(error) }));
    }
  }
  return saved ? 'sent' : 'unknown';
}

/** 回执写入失败时，尽力把状态收敛成 unknown，让界面不再显示「发送中」。 */
async function saveReceipt(mailboxId, id, receipt, mutateState, atIso) {
  try {
    await mutateState(mailboxId, NAMESPACE, (data) => {
      const item = (data.items || []).find((entry) => entry.id === id);
      if (!item) return null;
      Object.assign(item, receipt);
      return clone(item);
    });
    return true;
  } catch {
    try {
      await mutateState(mailboxId, NAMESPACE, (data) => {
        const item = (data.items || []).find((entry) => entry.id === id);
        if (!item) return null;
        Object.assign(item, { status: 'unknown', retryable: false, updatedAt: atIso,
          error: 'SMTP 调用已经结束，但回执没能保存；为避免重复发信不再重试，请到发件邮箱核对。' });
        return clone(item);
      });
    } catch { /* 存储仍不可用：记录留在 sending，5 分钟后由派发收敛成 unknown。 */ }
    return false;
  }
}

/** 从 replyTo → senderAddress → sender 里找第一个可用地址。 */
function firstReplyAddress(email) {
  for (const source of [email?.replyTo, email?.senderAddress, email?.sender]) {
    if (!source) continue;
    for (const line of String(source).split(/\r?\n/)) {
      for (const item of addressparser(line)) {
        const address = String(item.address || '').trim().toLowerCase();
        if (isMailAddress(address)) return address;
      }
    }
  }
  return '';
}

/** 主题前缀判断：已经以 Re: / 回复： 开头就不再叠加。 */
export function replySubject(subject) {
  const text = String(subject || '').trim() || '（无主题）';
  return /^\s*(?:re|回复)\s*[:：]/i.test(text) ? text : `Re: ${text}`;
}

/**
 * 「回复 / 回复全部」的预填字段。纯函数、无副作用、不落库。
 * 旧邮件没有记录 to/cc（字段缺失）时，reply-all 只能回复发件人：如实返回 recipientsKnown:false + warning，
 * 不假装收件人齐全。
 */
export function buildReplyDraft(email = {}, { mode = 'reply', mailbox = {} } = {}) {
  const own = String(mailbox.email || '').trim().toLowerCase();
  const address = firstReplyAddress(email);
  const to = address ? [address] : [];
  const all = mode === 'reply-all';
  const recipientsKnown = all ? (Array.isArray(email.to) || Array.isArray(email.cc)) : true;
  const cc = [];
  if (all && recipientsKnown) {
    for (const candidate of [...(email.to || []), ...(email.cc || [])]) {
      const value = String(candidate || '').trim().toLowerCase();
      if (!isMailAddress(value) || value === own || to.includes(value) || cc.includes(value)) continue;
      cc.push(value);
      if (cc.length >= MAX_RECIPIENTS) break;
    }
  }
  const messageId = String(email.messageId || '').trim();
  const references = [];
  for (const item of [...(Array.isArray(email.references) ? email.references : String(email.references || '').split(/\s+/)), messageId]) {
    const text = String(item || '').trim();
    if (text && !references.includes(text)) references.push(text);
    if (references.length >= MAX_RECIPIENTS) break;
  }
  let warning;
  if (!to.length) warning = '这封邮件没有可回复的发件人地址，请手动填写收件人。';
  else if (all && !recipientsKnown) warning = '这封邮件是旧数据、没有记录收件人，只能回复发件人。';
  return {
    mode: all ? 'reply-all' : 'reply',
    to,
    cc,
    subject: replySubject(email.subject),
    body: '',
    inReplyTo: messageId,
    references,
    recipientsKnown: to.length > 0 && recipientsKnown,
    ...(warning ? { warning } : {}),
  };
}
