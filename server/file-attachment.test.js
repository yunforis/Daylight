/**
 * 附件一键归位（活动材料 / 候选人简历）的后端测试。
 *
 * 单元部分把字节读取、材料登记、简历提取全部换成内存替身，不碰真实 OSS、模型与业务数据；
 * 集成部分单开一个子进程跑真实 Express + JSON 存储，只有模型 fetch 是本地替身，
 * 地址一律 example.invalid，绝不连真邮箱、真 OSS、真模型。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'daylight-file-attachment-'));
process.env.DAYLIGHT_DATA_DIR = directory;
fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
  activeMailboxId: 'default',
  mailboxes: [
    { id: 'default', email: 'sender@example.invalid', authorizationCode: 'invented-code' },
    { id: 'secondary', email: 'second@example.invalid', authorizationCode: 'invented-code-2' },
  ],
  baseUrl: '', apiKey: '', model: '',
}, null, 2));
fs.writeFileSync(path.join(directory, 'infra.json'), JSON.stringify({ postgres: { enabled: false }, mq: { enabled: false } }, null, 2));

const {
  ATTACHMENT_TARGETS, MAX_ATTACHMENT_BYTES, fileAttachment, findEmailAttachment, normalizeTarget, readAttachmentBytes,
} = await import('./file-attachment.js');
const { resumeRecord, mergeRecruitmentAttachments } = await import('./resumes.js');
const { readSettings, saveStore } = await import('./store.js');

const EMAIL_ID = 'mail-1';
const settings = () => readSettings();
const withModel = () => ({ ...readSettings(), baseUrl: 'https://model.example.invalid/v1', apiKey: 'invented-key', model: 'fixture-model', ragEnabled: false });
const registered = (overrides = {}) => ({ id: 'att-1', emailId: EMAIL_ID, filename: '简历.pdf', status: 'pending', ...overrides });
const attachment = (overrides = {}) => ({ id: 'att-1', filename: '材料.pdf', contentType: 'application/pdf', key: 'synthetic/material.pdf', ...overrides });
const email = (overrides = {}) => ({ id: EMAIL_ID, subject: '合成邮件', attachments: [attachment()], ...overrides });
const storeWith = (overrides = {}) => ({ events: [], tasks: [], emails: [email()], ...overrides });

async function reject(promise, status, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.status, status, `${error.message} 的状态码`);
    assert.equal(error.code, code, `${error.message} 的错误码`);
    return true;
  });
}

// ── 目标与定位 ────────────────────────────────────────

test('归位目标只认 material / candidate；invoice 明确拒绝并让客户端走提取发票入口', async () => {
  assert.deepEqual(ATTACHMENT_TARGETS, ['material', 'candidate']);
  assert.equal(normalizeTarget('material'), 'material');
  assert.equal(normalizeTarget(' candidate '), 'candidate');
  assert.throws(() => normalizeTarget('invoice'),
    (error) => error.status === 400 && error.code === 'MAIL_ATTACHMENT_TARGET_UNSUPPORTED');
  assert.throws(() => normalizeTarget(''),
    (error) => error.status === 400 && error.code === 'MAIL_ATTACHMENT_TARGET_UNSUPPORTED');
  // 走到主入口也是同一个错误码。
  await reject(fileAttachment('default', EMAIL_ID, { target: 'invoice', attachmentId: 'att-1' },
    { settings: settings(), store: storeWith() }), 400, 'MAIL_ATTACHMENT_TARGET_UNSUPPORTED');
});

test('邮件与附件定位：邮件找不到 404，附件不属于这封邮件 400', async () => {
  const store = storeWith();
  assert.equal(findEmailAttachment(store, EMAIL_ID, 'att-1').attachment.id, 'att-1');
  await reject(fileAttachment('default', 'missing-mail', { target: 'material', attachmentId: 'att-1' },
    { settings: settings(), store }), 404, 'MAIL_ATTACHMENT_NOT_FOUND');
  await reject(fileAttachment('default', EMAIL_ID, { target: 'material', attachmentId: 'nope' },
    { settings: settings(), store }), 400, 'MAIL_ATTACHMENT_NOT_IN_EMAIL');
});

// ── 字节读取 ─────────────────────────────────────────

test('字节读取：本地优先、对象存储兜底，读不到一律 null 而不是空缓冲', async () => {
  const calls = [];
  const local = await readAttachmentBytes({ key: 'a/b.pdf' }, {
    resolveLocal: (key) => { calls.push(['local', key]); return '/synthetic/a/b.pdf'; },
    getObject: async () => { calls.push(['oss']); return { buffer: Buffer.from('oss') }; },
    readFile: (file) => { calls.push(['read', file]); return Buffer.from('local-bytes'); },
  });
  assert.equal(local.toString(), 'local-bytes');
  assert.deepEqual(calls, [['local', 'a/b.pdf'], ['read', '/synthetic/a/b.pdf']]);

  const remote = await readAttachmentBytes({ key: 'a/b.pdf' }, {
    resolveLocal: () => null, getObject: async () => ({ buffer: Buffer.from('from-oss') }),
  });
  assert.equal(remote.toString(), 'from-oss');

  assert.equal(await readAttachmentBytes({ key: '' }, {}), null);
  assert.equal(await readAttachmentBytes({}, {}), null);
  // 本地命中但文件空 / 对象存储没有 buffer：都不能当成「已归位」。
  assert.equal(await readAttachmentBytes({ key: 'x.pdf' }, { resolveLocal: () => '/f', readFile: () => Buffer.alloc(0) }), null);
  assert.equal(await readAttachmentBytes({ key: 'x.pdf' }, { resolveLocal: () => null, getObject: async () => null }), null);
});

// ── 活动材料 ─────────────────────────────────────────

test('活动材料归位：把字节、文件名、类型交回 addMaterial，并带上邮箱归属', async () => {
  const captured = [];
  const result = await fileAttachment('default', EMAIL_ID,
    { target: 'material', attachmentId: 'att-1', eventId: 'evt-1', kind: 'ppt', note: '  现场讲稿  ' }, {
      settings: settings(),
      store: storeWith({ events: [{ id: 'evt-1', title: '评审会' }] }),
      readBytes: async () => Buffer.from('合成材料字节'),
      addEventMaterial: async (eventId, body, ctx) => {
        captured.push({ eventId, body, ctx });
        return { id: 'mat-1', filename: body.filename, hasFile: true };
      },
      user: { id: 'u1', username: 'demo' },
    });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body, {
    target: 'material', attachmentId: 'att-1', eventId: 'evt-1',
    material: { id: 'mat-1', filename: '材料.pdf', hasFile: true },
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].eventId, 'evt-1');
  assert.equal(captured[0].body.filename, '材料.pdf');
  assert.equal(captured[0].body.mimeType, 'application/pdf');
  assert.equal(captured[0].body.kind, 'ppt');
  assert.equal(captured[0].body.note, '现场讲稿', '备注去掉首尾空白');
  assert.equal(captured[0].body.contentBase64, Buffer.from('合成材料字节').toString('base64'));
  assert.deepEqual(captured[0].ctx, { userId: 'u1', username: 'demo', mailboxId: 'default' });
});

test('活动材料归位的前置校验：缺日程 / 日程不在本邮箱 / 读不到 / 超 8MB，都显式报错且不建材料', async () => {
  const base = {
    settings: settings(),
    store: storeWith({ events: [{ id: 'evt-1', title: '评审会' }] }),
    addEventMaterial: async () => assert.fail('这些情况都不该创建材料'),
    user: {},
  };
  await reject(fileAttachment('default', EMAIL_ID, { target: 'material', attachmentId: 'att-1' }, base),
    400, 'MAIL_ATTACHMENT_EVENT_REQUIRED');
  await reject(fileAttachment('default', EMAIL_ID, { target: 'material', attachmentId: 'att-1', eventId: 'nope' }, base),
    404, 'MAIL_EVENT_NOT_FOUND');
  await reject(fileAttachment('default', EMAIL_ID, { target: 'material', attachmentId: 'att-1', eventId: 'evt-1' },
    { ...base, readBytes: async () => null }), 502, 'MAIL_ATTACHMENT_UNREADABLE');
  await reject(fileAttachment('default', EMAIL_ID, { target: 'material', attachmentId: 'att-1', eventId: 'evt-1' },
    { ...base, readBytes: async () => { throw new Error('合成对象存储不可用'); } }), 502, 'MAIL_ATTACHMENT_UNREADABLE');
  await reject(fileAttachment('default', EMAIL_ID, { target: 'material', attachmentId: 'att-1', eventId: 'evt-1' },
    { ...base, readBytes: async () => Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }), 400, 'MAIL_ATTACHMENT_TOO_LARGE');
});

// ── 候选人简历 ───────────────────────────────────────

test('候选人归位只认招聘同步登记过的简历：没登记或属于别的邮件一律 409', async () => {
  const base = {
    settings: withModel(),
    store: storeWith(),
    extractResume: async () => assert.fail('未通过登记校验时不该调用简历提取'),
  };
  await reject(fileAttachment('default', EMAIL_ID, { target: 'candidate', attachmentId: 'att-1' },
    { ...base, readRecruitmentData: () => ({ attachments: [] }) }), 409, 'MAIL_ATTACHMENT_NOT_RESUME');
  await reject(fileAttachment('default', EMAIL_ID, { target: 'candidate', attachmentId: 'att-1' },
    { ...base, readRecruitmentData: () => ({ attachments: [registered({ emailId: 'other-mail' })] }) }), 409, 'MAIL_ATTACHMENT_NOT_RESUME');
});

test('候选人归位要先配好模型：未配置时 400 且不调用模型', async () => {
  await reject(fileAttachment('default', EMAIL_ID, { target: 'candidate', attachmentId: 'att-1' }, {
    settings: settings(), // 没有 baseUrl / apiKey / model
    store: storeWith(),
    readRecruitmentData: () => ({ attachments: [registered()] }),
    extractResume: async () => assert.fail('未配置模型不该调用提取'),
  }), 400, 'MAIL_MODEL_NOT_CONFIGURED');
});

test('候选人归位成功：写回招聘数据与邮件记录，candidateIds 供界面直接跳转', async () => {
  const saved = [];
  // 成功路径会重新读一遍磁盘上的最新 store 再写回（避免覆盖并发改动），所以这里先落一份真实数据。
  saveStore({ events: [], tasks: [], emails: [email()], lastSync: null }, 'default');
  const attachments = [registered({ status: 'success', candidateId: 'cand-1', pages: [{ text: '合成页文本' }] })];
  const result = await fileAttachment('default', EMAIL_ID, { target: 'candidate', attachmentId: 'att-1' }, {
    settings: withModel(),
    store: storeWith(),
    readRecruitmentData: () => ({ attachments }),
    extractResume: async () => ({ status: 'success', candidateId: 'cand-1' }),
    resumeRecordFor: resumeRecord,
    mergeAttachments: mergeRecruitmentAttachments,
    save: (data, mailboxId) => saved.push({ mailboxId, record: data.emails[0] }),
    context: { trace: { trace_id: 'trace-1' } },
  });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body.candidateIds, ['cand-1']);
  assert.equal(result.body.record.category, 'resume');
  assert.equal(result.body.record.recruitmentStatus, 'completed');
  assert.equal(result.body.record.trace_id, 'trace-1');
  assert.equal(result.body.record.attachments.length, 1);
  assert.equal(result.body.record.attachments[0].pageCount, 1, 'pages 不落进对外附件、只留页数');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mailboxId, 'default');
  assert.equal(saved[0].record.id, EMAIL_ID);
});

test('候选人归位遇到「不是简历」：200 明确 skipped，不建候选人也不改邮件记录', async () => {
  const saved = [];
  const result = await fileAttachment('default', EMAIL_ID, { target: 'candidate', attachmentId: 'att-1' }, {
    settings: withModel(),
    store: storeWith(),
    readRecruitmentData: () => ({ attachments: [registered()] }),
    extractResume: async () => ({ status: 'not_resume', summary: '这是发票不是简历。' }),
    save: (...args) => saved.push(args),
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.skipped, true);
  assert.equal(result.body.reason, '这是发票不是简历。');
  assert.equal(result.body.target, 'candidate');
  assert.equal(saved.length, 0, '跳过时不该改写邮件记录');
});

test('候选人归位提取失败：502 带错误码与原因，保留原记录供重试', async () => {
  await reject(fileAttachment('default', EMAIL_ID, { target: 'candidate', attachmentId: 'att-1' }, {
    settings: withModel(),
    store: storeWith(),
    readRecruitmentData: () => ({ attachments: [registered()] }),
    extractResume: async () => ({ status: 'failed', error: '合成解析失败' }),
    save: () => assert.fail('失败时不该改写邮件记录'),
  }), 502, 'MAIL_ATTACHMENT_EXTRACT_FAILED');
  // 没有可读错误时给一句人话，不能空着。
  await assert.rejects(fileAttachment('default', EMAIL_ID, { target: 'candidate', attachmentId: 'att-1' }, {
    settings: withModel(),
    store: storeWith(),
    readRecruitmentData: () => ({ attachments: [registered()] }),
    extractResume: async () => ({ status: 'failed' }),
    save: () => {},
  }), (error) => error.status === 502 && error.code === 'MAIL_ATTACHMENT_EXTRACT_FAILED' && /重试/.test(error.message));
});

// ── HTTP 路由集成：真实 Express + JSON 存储，只有模型是本地替身 ────────────────

const HTTP_EVENT_ID = 'evt-attachment-1';
const HTTP_EMAIL_ID = 'imap-v2:user-1:sender%40example.invalid:INBOX:7:1';
const HTTP_MATERIAL_ATTACHMENT = 'attachment-material-1';
const HTTP_RESUME_ATTACHMENT = 'attachment-resume-1';

/** 合成一份结构完整的最小 PDF，交给真实的 extractPdf 解析（与 resumes.test.js 同款）。 */
function syntheticPdf(text = 'Synthetic Applicant resume. Cloud computing project.') {
  const stream = `BT /F1 12 Tf 40 700 Td (${text}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let data = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(data)); data += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(data);
  data += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(data);
}

/**
 * 子进程里跑真实的 index.js：只 mock 模型 fetch 与 express.application.listen。
 * IMAP / SMTP 全程不会被触发（不发起同步、syncStrategy 不是 idle），
 * 定时器只冻结 setInterval，避免后台节拍在测试中途插话。
 */
async function serveAttachmentFixture(fixtureData) {
  const { mock } = await import('node:test');
  const { default: express } = await import('express');
  const modelUrls = [];
  let httpServer;
  mock.timers.enable({ apis: ['setInterval'] });
  mock.method(globalThis, 'fetch', async (url, options) => {
    modelUrls.push(String(url));
    const request = JSON.parse(options?.body || '{}');
    const resumeCall = JSON.stringify(request.messages || []).includes('简历结构化助手');
    const payload = resumeCall
      ? { isResume: true, summary: '合成简历', profile: { personal: { name: '合成候选人', email: 'candidate@example.invalid' }, skills: ['Kubernetes'] } }
      : { isResume: false };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
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
    process.send({ modelUrls });
  });
  // 跳过 Vite dev server（它会留下文件监听句柄让子进程无法退出）；DAYLIGHT_RUNTIME 仍是 local。
  process.argv.push('--production');
  await import(fixtureData.indexUrl);
}

async function attachmentFixture(t) {
  fs.mkdirSync(path.join(root, 'work'), { recursive: true });
  const data = fs.mkdtempSync(path.join(root, 'work', 'file-attachment-http-'));
  const resumePdf = syntheticPdf();
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({
    activeMailboxId: 'default',
    mailboxes: [
      { id: 'default', provider: 'custom', email: 'sender@example.invalid', authorizationCode: 'invented-attachment-code',
        imapHost: 'imap.example.invalid', imapPort: 993, imapSecure: true, smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpSecure: true },
      { id: 'secondary', provider: 'custom', email: 'second@example.invalid', authorizationCode: 'invented-attachment-code-2',
        imapHost: 'imap.example.invalid', imapPort: 993, imapSecure: true, smtpHost: 'smtp.example.invalid', smtpPort: 465, smtpSecure: true },
    ],
    baseUrl: 'https://model.example.invalid/v1', apiKey: 'invented-attachment-key', model: 'fixture-model',
    ragEnabled: false, ragEmbeddings: false, fetchLimit: 15,
  }, null, 2));
  fs.writeFileSync(path.join(data, 'infra.json'), JSON.stringify({
    postgres: { enabled: false },
    mq: { enabled: false }, // 与宿主机上可能运行的 RabbitMQ 隔离开。
    auth: { requireAuth: false, allowLocalDemoLogin: true, sessionDays: 14, jwtSecret: 'test', adminEmails: [] },
  }, null, 2));
  fs.writeFileSync(path.join(data, 'calendar.json'), JSON.stringify({
    lastSync: null, tasks: [],
    events: [{ id: HTTP_EVENT_ID, title: '合成评审会', start: '2026-10-17T14:00:00+08:00', end: '2026-10-17T15:00:00+08:00', allDay: false }],
    emails: [{
      id: HTTP_EMAIL_ID, subject: '合成材料与简历', sender: '合成来信者 <sender@example.invalid>', senderAddress: 'sender@example.invalid',
      receivedAt: '2026-10-17T08:00:00+08:00', body: '供本地集成验证的合成邮件。', status: 'skipped',
      attachments: [
        { id: HTTP_MATERIAL_ATTACHMENT, filename: '活动讲稿.pdf', contentType: 'application/pdf', key: 'synthetic/material.pdf' },
        { id: HTTP_RESUME_ATTACHMENT, filename: 'resume.pdf', contentType: 'application/pdf' },
      ],
    }],
  }, null, 2));
  fs.writeFileSync(path.join(data, 'recruitment.json'), JSON.stringify({
    candidates: [], messages: [], interviews: [], traces: [],
    attachments: [{ id: HTTP_RESUME_ATTACHMENT, emailId: HTTP_EMAIL_ID, filename: 'resume.pdf', contentType: 'application/pdf',
      size: resumePdf.length, status: 'pending', pages: [], error: null, candidateId: null, createdAt: '2026-10-17T08:00:00+08:00' }],
  }, null, 2));
  // OSS 本地根目录就是 <data>/attachments：材料附件用 key 直接定位到这里。
  fs.mkdirSync(path.join(data, 'attachments', 'synthetic'), { recursive: true });
  fs.writeFileSync(path.join(data, 'attachments', 'synthetic', 'material.pdf'), Buffer.from('%PDF-1.4 synthetic material attachment'));
  // 招聘附件的本地回退路径是 <mailboxDirectory>/attachments/<id>.pdf。
  fs.writeFileSync(path.join(data, 'attachments', `${HTTP_RESUME_ATTACHMENT}.pdf`), resumePdf);

  const env = { ...process.env, PORT: '0', DAYLIGHT_RUNTIME: 'local', DAYLIGHT_DATA_DIR: data,
    DAYLIGHT_REQUIRE_AUTH: '0', DAYLIGHT_AUTO_PROXY: '0' };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete env[key];
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `(${serveAttachmentFixture.toString()})(${JSON.stringify({ indexUrl: new URL('./index.js', import.meta.url).href })}).catch(error => {
      console.error(error); process.exitCode = 1; if (process.connected) process.disconnect();
    })`], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env });
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
    if (exitResult) { reject(failure('Attachments API fixture already exited')); return; }
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onMessage = (value) => { cleanup(); resolve(value); };
    const onExit = (code, signal) => { cleanup(); reject(failure('Attachments API fixture exited before replying', { code, signal })); };
    const onError = (error) => { cleanup(); reject(failure('Attachments API fixture process failed', { error })); };
    const timer = setTimeout(() => { cleanup(); reject(failure('Attachments API fixture did not reply within 15 seconds')); }, 15000);
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
        timer = setTimeout(() => reject(failure('Attachments API fixture did not shut down within 5 seconds')), 5000);
      })]);
      if (result.error || result.code !== 0 || result.signal) throw failure('Attachments API fixture exited unsuccessfully', result);
    } catch (error) {
      if (!exitResult) { child.kill(); await exited; }
      throw error;
    } finally { clearTimeout(timer); }
  })();
  t.after(stop);
  const { port } = await nextMessage();
  assert.ok(Number.isInteger(port) && port > 0, failure('Attachments API fixture returned an invalid port'));
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
    data, output: () => output, command, stop,
    briefing: (mailboxId) => request('/api/briefing', 'GET', undefined, mailboxId),
    receipts: (mailboxId) => request('/api/receipts', 'GET', undefined, mailboxId),
    check: (mailboxId) => request('/api/receipts/check', 'POST', {}, mailboxId),
    file: (emailId, body, mailboxId) => request(`/api/emails/${encodeURIComponent(emailId)}/file-attachment`, 'POST', body, mailboxId),
  };
}

test('HTTP：简报 / 回执 / 立即检查都能按邮箱读写，X-Mailbox-Id: secondary 不被 409 拒绝', async (t) => {
  const app = await attachmentFixture(t);

  const briefing = await app.briefing();
  assert.equal(briefing.status, 200);
  assert.equal(briefing.body.mailboxId, 'default');
  assert.equal(typeof briefing.body.text, 'string');
  assert.ok(briefing.body.text.length > 0, '简报正文不能是空字符串');
  assert.match(briefing.body.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(briefing.body.receipts, { waiting: [], overdue: [] });

  const secondaryBriefing = await app.briefing('secondary');
  assert.equal(secondaryBriefing.status, 200, '非活跃但属于自己的邮箱必须放行');
  assert.equal(secondaryBriefing.body.mailboxId, 'secondary');

  const receipts = await app.receipts();
  assert.equal(receipts.status, 200);
  assert.deepEqual(receipts.body, { receipts: [], counts: { waiting: 0, answered: 0, overdue: 0, cancelled: 0 } });
  assert.equal((await app.receipts('secondary')).status, 200);

  const checked = await app.check();
  assert.equal(checked.status, 200);
  assert.deepEqual(checked.body, { checked: 0, answered: 0, overdue: 0 });
  assert.equal((await app.check('secondary')).status, 200);

  // 不属于自己的邮箱一律 403，不泄露「是否存在」。
  const foreign = await app.receipts('someone-elses');
  assert.equal(foreign.status, 403);
  assert.equal(foreign.body.code, 'MAILBOX_FORBIDDEN');
  assert.equal((await app.check('someone-elses')).status, 403);
});

test('HTTP：附件归位把材料挂到日程、把简历写进人才库，发票入口明确拒绝', async (t) => {
  const app = await attachmentFixture(t);

  const material = await app.file(HTTP_EMAIL_ID, { target: 'material', attachmentId: HTTP_MATERIAL_ATTACHMENT, eventId: HTTP_EVENT_ID, kind: 'ppt', note: '现场讲稿' });
  assert.equal(material.status, 201);
  assert.equal(material.body.target, 'material');
  assert.equal(material.body.eventId, HTTP_EVENT_ID);
  assert.equal(material.body.material.filename, '活动讲稿.pdf');
  assert.equal(material.body.material.kind, 'ppt');
  assert.equal(material.body.material.hasFile, true);
  assert.ok(material.body.material.size > 0, '材料必须真有文件字节');
  const afterMaterial = JSON.parse(fs.readFileSync(path.join(app.data, 'calendar.json'), 'utf8'));
  assert.equal(afterMaterial.events[0].materials.length, 1);
  assert.equal(afterMaterial.events[0].materials[0].filename, '活动讲稿.pdf');

  const invoice = await app.file(HTTP_EMAIL_ID, { target: 'invoice', attachmentId: HTTP_MATERIAL_ATTACHMENT });
  assert.equal(invoice.status, 400);
  assert.equal(invoice.body.code, 'MAIL_ATTACHMENT_TARGET_UNSUPPORTED');

  const candidate = await app.file(HTTP_EMAIL_ID, { target: 'candidate', attachmentId: HTTP_RESUME_ATTACHMENT });
  assert.equal(candidate.status, 201);
  assert.equal(candidate.body.target, 'candidate');
  assert.equal(candidate.body.candidateIds.length, 1);
  assert.equal(candidate.body.record.category, 'resume');
  const recruitment = JSON.parse(fs.readFileSync(path.join(app.data, 'recruitment.json'), 'utf8'));
  assert.equal(recruitment.candidates.length, 1);
  assert.equal(recruitment.attachments[0].status, 'success');
  assert.equal(recruitment.attachments[0].candidateId, recruitment.candidates[0].id);
  const afterCandidate = JSON.parse(fs.readFileSync(path.join(app.data, 'calendar.json'), 'utf8'));
  assert.equal(afterCandidate.emails[0].category, 'resume');

  // 归位只调模型识别简历一次，没有多余的旁路请求。
  const { modelUrls } = await app.command({ type: 'counts' });
  assert.equal(modelUrls.length, 1);
  // 清单里的附件 id 都不变：没有凭空造出东西。
  assert.equal(afterMaterial.emails[0].attachments.length, 2);
});
