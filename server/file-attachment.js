/**
 * 附件一键归位：把邮件附件按用途登记成
 *   ① 活动材料（挂到某个日程的 materials，走 event-aftermath.addMaterial）
 *   ② 候选人简历（走 resumes.extractResumeAttachment，写进招聘数据）
 * 发票不走这里：`target='invoice'` 直接 400 + MAIL_ATTACHMENT_TARGET_UNSUPPORTED，
 * 让客户端去调既有的 `/api/emails/:id/extract-invoices`（它会调模型识别票面信息）。
 *
 * 字节来源：优先 `resolveLocalAttachment(key)`（本地目录），否则 `getAttachmentObject(key)`（对象存储）。
 * 读不到就 502，绝不建一条空材料——「已归位」必须是真有文件。
 * 所有外部依赖都能注入，便于在没有真实 OSS / 本地文件的测试里跑。
 */
import fs from 'node:fs';
import { getAttachmentObject, resolveLocalAttachment } from './infra/oss.js';
import { addMaterial } from './event-aftermath.js';
import { extractResumeAttachment, mergeRecruitmentAttachments, resumeRecord } from './resumes.js';
import { readRecruitment } from './recruitment-store.js';
import { readSettings, readStore, saveStore, publicSettings } from './store.js';

export const ATTACHMENT_TARGETS = ['material', 'candidate'];
/** 与 event-aftermath 的 addMaterial 上限保持一致：8MB。 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const list = (value) => (Array.isArray(value) ? value : []);

/**
 * 归位目标校验。发票是刻意不支持的：它会调模型识别票面，和「原样搬文件」不是一回事。
 */
export function normalizeTarget(target) {
  const value = String(target || '').trim();
  if (value === 'invoice') {
    throw fail('发票请用「提取发票」入口，它会调模型识别票面信息，不走附件归位。', 400, 'MAIL_ATTACHMENT_TARGET_UNSUPPORTED');
  }
  if (!ATTACHMENT_TARGETS.includes(value)) {
    throw fail('附件归位目标只能是 material（活动材料）或 candidate（候选人简历）。', 400, 'MAIL_ATTACHMENT_TARGET_UNSUPPORTED');
  }
  return value;
}

/** 在该邮箱的邮件里定位附件；邮件找不到 404，附件不属于这封邮件 400。 */
export function findEmailAttachment(store, emailId, attachmentId) {
  const email = list(store?.emails).find((item) => item.id === emailId);
  if (!email) throw fail('没有找到这封邮件或它的附件，请先同步邮箱。', 404, 'MAIL_ATTACHMENT_NOT_FOUND');
  const attachment = list(email.attachments).find((item) => item.id === attachmentId);
  if (!attachment) throw fail('这封邮件里没有这个附件。', 400, 'MAIL_ATTACHMENT_NOT_IN_EMAIL');
  return { email, attachment };
}

/** 默认取字节：本地优先，再对象存储；取不到返回 null。 */
export async function readAttachmentBytes(attachment, {
  resolveLocal = resolveLocalAttachment,
  getObject = getAttachmentObject,
  readFile = (file) => fs.readFileSync(file),
} = {}) {
  const key = String(attachment?.key || '').trim();
  if (!key) return null;
  const local = resolveLocal(key);
  if (local) {
    const buffer = readFile(local);
    return buffer?.length ? buffer : null;
  }
  const object = await getObject(key);
  return object?.buffer?.length ? object.buffer : null;
}

function clampNote(note) {
  return String(note ?? '').trim().slice(0, 2000);
}

/**
 * 主入口。返回 `{ status, body }`，由路由决定 HTTP 状态码；
 * 期望中的失败（400/403/404/409/502）都抛带 status/code 的 Error。
 */
export async function fileAttachment(mailboxId, emailId, input = {}, {
  settings = readSettings(),
  store = readStore(mailboxId),
  readBytes = readAttachmentBytes,
  addEventMaterial = addMaterial,
  readRecruitmentData = readRecruitment,
  extractResume = extractResumeAttachment,
  resumeRecordFor = resumeRecord,
  mergeAttachments = mergeRecruitmentAttachments,
  save = saveStore,
  context = null,
  user = {},
  now = Date.now(),
} = {}) {
  const target = normalizeTarget(input.target);
  const { email, attachment } = findEmailAttachment(store, emailId, input.attachmentId);
  if (target === 'material') {
    return fileAsMaterial(mailboxId, email, attachment, input, { store, readBytes, addEventMaterial, user, now });
  }
  return fileAsCandidate(mailboxId, email, attachment, input, {
    settings, readRecruitmentData, extractResume, resumeRecordFor, mergeAttachments, save, context, now,
  });
}

async function fileAsMaterial(mailboxId, email, attachment, input, { store, readBytes, addEventMaterial, user, now }) {
  const eventId = String(input.eventId || '').trim();
  if (!eventId) throw fail('把附件归成活动材料需要指定一个日程。', 400, 'MAIL_ATTACHMENT_EVENT_REQUIRED');
  const event = list(store?.events).find((item) => item.id === eventId);
  if (!event) throw fail('日程不存在。', 404, 'MAIL_EVENT_NOT_FOUND');

  let bytes = null;
  try {
    bytes = await readBytes(attachment);
  } catch (error) {
    throw fail(`附件内容读取失败：${error?.message || '对象存储暂时不可用'}`, 502, 'MAIL_ATTACHMENT_UNREADABLE');
  }
  if (!bytes?.length) {
    throw fail('附件内容读不到（文件缺失或对象存储不可用），没有创建材料。', 502, 'MAIL_ATTACHMENT_UNREADABLE');
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw fail(`附件超过 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB，不能归位成活动材料。`, 400, 'MAIL_ATTACHMENT_TOO_LARGE');
  }

  const material = await addEventMaterial(eventId, {
    filename: attachment.filename || 'file',
    mimeType: attachment.contentType || 'application/octet-stream',
    kind: input.kind,
    note: clampNote(input.note),
    contentBase64: bytes.toString('base64'),
  }, { userId: user.id, username: user.username, mailboxId });
  return {
    status: 201,
    body: { target: 'material', attachmentId: attachment.id, material, eventId },
  };
}

async function fileAsCandidate(mailboxId, email, attachment, input, {
  settings, readRecruitmentData, extractResume, resumeRecordFor, mergeAttachments, save, context, now,
}) {
  const registered = list(readRecruitmentData(mailboxId)?.attachments).find((item) => item.id === attachment.id);
  if (!registered || (registered.emailId && registered.emailId !== email.id)) {
    throw fail('这封邮件同步时没有把该附件识别成简历，不能一键归到候选人。请先同步邮箱，或在招聘页用「重试提取」。',
      409, 'MAIL_ATTACHMENT_NOT_RESUME');
  }
  if (!publicSettings(settings).modelReady) {
    throw fail('请先在设置中填写模型接口。', 400, 'MAIL_MODEL_NOT_CONFIGURED');
  }

  const result = await extractResume(mailboxId, email, registered, settings, context);
  if (result?.status === 'not_resume') {
    return {
      status: 200,
      body: { target: 'candidate', attachmentId: attachment.id, skipped: true,
        reason: result.summary || '这个附件不是个人简历，没有加入人才库。' },
    };
  }
  if (result?.status !== 'success') {
    throw fail(result?.error || '简历识别没有完成，稍后可以重试。', 502, 'MAIL_ATTACHMENT_EXTRACT_FAILED');
  }

  const attachments = list(readRecruitmentData(mailboxId)?.attachments).filter((item) => item.emailId === email.id);
  const record = attachments.some((item) => item.status === 'success') || email.category === 'resume'
    ? resumeRecordFor(email, attachments)
    : { ...email, attachments: mergeAttachments(email, attachments) };
  record.trace_id = context?.trace?.trace_id || email.trace_id || null;
  const current = readStore(mailboxId);
  const index = list(current.emails).findIndex((item) => item.id === email.id);
  if (index >= 0) {
    current.emails[index] = record;
    save(current, mailboxId);
  }
  return {
    status: 201,
    body: { target: 'candidate', attachmentId: attachment.id, record, candidateIds: record.candidateIds || [] },
  };
}
