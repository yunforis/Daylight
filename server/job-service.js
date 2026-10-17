import { createHash, randomUUID } from 'node:crypto';
import { JobRepository, mailboxBackoffMs, failureStreak } from './jobs/repository.js';
import { getPostgresPool, findUserById } from './infra/postgres.js';
import { withStorageSnapshot, storageContext, commitStorage, readSnapshotDocument, settingsKey } from './storage/index.js';
import { readSettings, publicSettings } from './store.js';
import { readTraces, saveTraces, createTraceRecorder } from './traces.js';
import { runMailJob } from './mail-job.js';
import { createMailJobStorage } from './storage/mail-job.js';
import { readScenarioData } from './scenarios/repository.js';
import { findWorkbench, proposeItemPlan } from './scenarios/service.js';
import { queueExternalSync } from './external-calendar.js';
import { dispatchDueOutbound } from './outbound.js';
import { checkReceipts } from './receipts.js';
import { dispatchPush, notifyOverdueReceipts } from './push.js';
import { beijingDate } from './briefing.js';

/** Stage only; storageHttpMiddleware commits the intent before delivering HTTP 202. */
export function queueCalendarExport(store, events, connections) {
  const result = queueExternalSync(store, events, 'update', { force: true });
  if (!result?.durable) throw Object.assign(new Error('Durable calendar intent was not staged'), { status: 503 });
  return { ...result, total: events.length, connections: connections.length,
    status: 'queued', message: '外部日历同步已持久排队，尚未完成远端推送。' };
}

let repository;
export function jobRepository() {
  const pool = getPostgresPool();
  if (!pool) throw Object.assign(new Error('任务数据库不可用'), { status: 503 });
  if (!repository || repository.pool !== pool) repository = new JobRepository(pool);
  return repository;
}
export function requestJobKey(value, prefix) {
  if (value && (typeof value !== 'string' || value.length > 200)) throw Object.assign(new Error('Idempotency-Key 无效'), { status: 400 });
  return `${prefix}:${createHash('sha256').update(value || randomUUID()).digest('hex')}`;
}
export function enqueueMail({ tenantId, ownerId, mailboxId, idempotencyKey, trigger = 'manual' }, jobs = jobRepository()) {
  if (!ownerId || tenantId !== ownerId) throw Object.assign(new Error('任务身份无效'), { status: 403 });
  const mailbox = readSettings().mailboxes.find(item => item.id === mailboxId && (item.ownerUserId || item.userId) === ownerId);
  if (!mailbox) throw Object.assign(new Error('邮箱不存在'), { status: 404 });
  if (mailbox.pendingSetup === true) throw Object.assign(new Error('请先在设置中保存并配置自己的邮箱，再同步邮件。'),
    { status: 400, code: 'MAILBOX_SETUP_REQUIRED' });
  return jobs.enqueue({ tenantId, ownerId, mailboxId, kind: 'mailbox.sync', idempotencyKey, payload: { trigger } });
}
/**
 * 生产：把「派发到点的出站邮件」排成任务。availableAt 可以排到具体时间（默认撤销窗口 10 秒内），
 * 更远的定时发送由 scheduleOutbound 每分钟兜底入队。幂等键让重复调用只入一条任务。
 */
export async function enqueueOutbound({ tenantId, ownerId, mailboxId, idempotencyKey, availableAt = new Date(), limit = 5 },
  jobs = jobRepository()) {
  if (!ownerId || tenantId !== ownerId) throw Object.assign(new Error('任务身份无效'), { status: 403 });
  const mailbox = readSettings().mailboxes.find(item => item.id === mailboxId && (item.ownerUserId || item.userId) === ownerId);
  if (!mailbox) throw Object.assign(new Error('邮箱不存在'), { status: 404 });
  return jobs.enqueue({ tenantId, ownerId, mailboxId, kind: 'outbound.dispatch', idempotencyKey,
    payload: { limit }, availableAt });
}
export async function enqueuePlan({ ownerId, workbenchId, itemId, useModel, idempotencyKey }, jobs = jobRepository()) {
  const data = await readScenarioData();
  const workbench = findWorkbench(data, workbenchId);
  if (!data.items.some(item => item.id === itemId && item.workbenchId === workbenchId)) throw Object.assign(new Error('事项不存在'), { status: 404 });
  const mailboxId = workbench.mailboxIds?.[0];
  const mailbox = readSettings().mailboxes.find(box => box.id === mailboxId && (box.ownerUserId || box.userId) === ownerId);
  if (!mailbox) throw Object.assign(new Error('工作台邮箱不存在'), { status: 403 });
  if (mailbox.pendingSetup === true) throw Object.assign(new Error('请先在设置中保存并配置自己的邮箱，再分析工作台事项。'),
    { status: 400, code: 'MAILBOX_SETUP_REQUIRED' });
  return jobs.enqueue({ tenantId: ownerId, ownerId, mailboxId, kind: 'scenario.plan', idempotencyKey,
    payload: { workbenchId, itemId, useModel: Boolean(useModel) } });
}

function assertJobScope(job) {
  if (!job || ['id', 'lease_token', 'tenant_id', 'owner_id', 'mailbox_id'].some(key => typeof job[key] !== 'string' || !job[key].trim())
    || job.tenant_id !== job.owner_id) throw Object.assign(new Error('Invalid task scope'), { retryable: false });
}
function assertLeaseScope(current, job) {
  if (!current || ['tenant_id', 'owner_id', 'mailbox_id'].some(key => current[key] !== job[key])) {
    throw Object.assign(new Error('Task lease scope changed'), { retryable: false });
  }
}

export function createPlanHandler(jobs, { findUser = findUserById, snapshot = withStorageSnapshot, propose = proposeItemPlan, commit = commitStorage } = {}) {
  return async (job, context) => {
    assertJobScope(job);
    if (!job.payload || ['workbenchId', 'itemId'].some(key => typeof job.payload[key] !== 'string' || !job.payload[key].trim())) {
      throw Object.assign(new Error('Invalid plan task input'), { retryable: false });
    }
    const user = await findUser(job.owner_id);
    if (!user || user.disabled || user.status === 'disabled') throw Object.assign(new Error('Task owner unavailable'), { retryable: false });
    context.signal.throwIfAborted();
    return snapshot({ userId: user.id, user, mailboxId: job.mailbox_id }, async () => {
      if (!readSettings().mailboxes.some(box => box.id === job.mailbox_id && (box.ownerUserId || box.userId) === user.id)) throw Object.assign(new Error('Task mailbox unavailable'), { retryable: false });
      const saved = (await context.steps()).find(step => step.name === 'plan.persist');
      if (saved) return saved.result;
      const data = await readScenarioData();
      const workbench = findWorkbench(data, job.payload.workbenchId);
      if (!workbench.mailboxIds?.includes(job.mailbox_id)) throw Object.assign(new Error('Task workbench scope changed'), { retryable: false });
      if (!data.items.some(item => item.id === job.payload.itemId && item.workbenchId === workbench.id)) throw Object.assign(new Error('Task item unavailable'), { retryable: false });
      if (job.payload.useModel && !publicSettings(readSettings()).modelReady) throw Object.assign(new Error('Task model settings unavailable'), { code: 'MODEL_NOT_CONFIGURED' });
      await propose(job.payload.workbenchId, job.payload.itemId, { useModel: Boolean(job.payload.useModel) });
      context.signal.throwIfAborted();
      const result = { workbenchId: job.payload.workbenchId, itemId: job.payload.itemId, completed: true };
      await commit({ beforeCommit: async client => {
        context.signal.throwIfAborted();
        const current = await jobs.lockLease(client, job.id, job.lease_token);
        assertLeaseScope(current, job);
        await client.query('INSERT INTO daylight_job_steps (job_id,name,result,generation) VALUES ($1,$2,$3::jsonb,$4)',
          [job.id, 'plan.persist', JSON.stringify(result), current.generation]);
      }, afterWrite: async client => {
        context.signal.throwIfAborted();
        assertLeaseScope(await jobs.lockLease(client, job.id, job.lease_token), job);
      } });
      return result;
    });
  };
}

export function createMailHandler(jobs, { findUser = findUserById, snapshot = withStorageSnapshot,
  storageFactory = createMailJobStorage, run = runMailJob } = {}) {
  return async (job, context) => {
    assertJobScope(job);
    const user = await findUser(job.owner_id);
    if (!user || user.disabled || user.status === 'disabled') throw Object.assign(new Error('Task owner unavailable'), { retryable: false });
    const options = { userId: user.id, user, mailboxId: job.mailbox_id };
    const settings = await snapshot(options, () => readSettings());
    if (!settings.mailboxes.some(box => box.id === job.mailbox_id && (box.ownerUserId || box.userId) === user.id)) {
      throw Object.assign(new Error('Task mailbox unavailable'), { retryable: false });
    }
    const ready = publicSettings(settings);
    if (!ready.mailboxReady || !ready.modelReady) throw Object.assign(new Error('Task mail/model settings unavailable'), { code: 'MAIL_NOT_CONFIGURED' });
    context.signal.throwIfAborted();
    // Traces back the processing log, token/cost accounting and the reply drafts the user
    // reviews. Production syncs run in this worker, so the recorder must be bound to the
    // mailbox trace document here; without it real syncs silently lose every trace.
    const recorder = await snapshot(options, () => createTraceRecorder({ settings,
      traces: readTraces(job.mailbox_id),
      // The IMAP read phase runs before any snapshot is open: keep those traces in the
      // recorder's array and stage them on the first write that happens inside a snapshot.
      persist: (next) => { if (storageContext()) saveTraces(next, job.mailbox_id); } }));
    return run({ job, repository: jobs, settings, storage: storageFactory(options), signal: context.signal, recorder });
  };
}

/** Enumerate authoritative settings, never the process's active mailbox. */
export async function scheduleMailboxes(jobs, now = new Date(), { snapshot = withStorageSnapshot,
  baseBackoffMs = Number(process.env.DAYLIGHT_MAIL_BACKOFF_BASE_MS) || 300000,
  maxBackoffMs = Number(process.env.DAYLIGHT_MAIL_BACKOFF_MAX_MS) || 3600000 } = {}) {
  return snapshot({ system: true, mailboxIds: [] }, async () => {
    const raw = readSnapshotDocument(settingsKey('default'));
    const minute = Math.floor(now.getTime() / 60000);
    let scheduled = 0;
    let deferred = 0;
    for (const mailbox of raw.mailboxes || []) {
      const ownerId = mailbox.ownerUserId || mailbox.userId;
      if (!ownerId || mailbox.disabled || mailbox.autoSync === false) continue;
      if (mailbox.syncStrategy === 'idle' && minute % 5) continue;
      const prefs = raw.userPrefs?.[ownerId] || {};
      const settings = { ...raw, ...prefs, ...mailbox, mailboxes: [mailbox], activeMailboxId: mailbox.id };
      if (!publicSettings(settings).mailboxReady || !publicSettings(settings).modelReady) continue;
      // A mailbox that keeps failing is backed off instead of dialled every minute. Manual
      // syncs bypass this (they go through enqueueMail), so a user fix takes effect at once.
      const history = await jobs.mailboxSyncOutcomes({ tenantId: ownerId, ownerId, mailboxId: mailbox.id, limit: 8 });
      const streak = failureStreak(history);
      if (streak) {
        const readyAt = new Date(history[0].finished_at).getTime() + mailboxBackoffMs(streak, { baseMs: baseBackoffMs, maxMs: maxBackoffMs });
        if (now.getTime() < readyAt) { deferred += 1; continue; }
      }
      // One in-flight sync per mailbox. A sync that outlives the minute cadence must not
      // queue a duplicate every minute; the next free minute schedules the following run.
      if (await jobs.hasPendingSync({ tenantId: ownerId, ownerId, mailboxId: mailbox.id })) { deferred += 1; continue; }
      await jobs.enqueue({ tenantId: ownerId, ownerId, mailboxId: mailbox.id, kind: 'mailbox.sync',
        idempotencyKey: `scheduled:${minute}`, payload: { trigger: 'scheduled' } });
      scheduled += 1;
    }
    return { scheduled, deferred };
  });
}

/**
 * 生产 worker 的 outbound.dispatch handler：在一个邮箱的存储快照内派发到点的出站邮件。
 * 快照只用来读设置；出站记录由 assistant-state 自己按用户命名空间读写（PG 权威）。
 * 派发本身自带 sending 屏障，所以重复/并发任务不会重复发信。
 * 注意：这条路径需要真实 PostgreSQL + worker 集群，本机没有验证过。
 */
export function createOutboundHandler(jobs, { findUser = findUserById, snapshot = withStorageSnapshot,
  dispatch = dispatchDueOutbound } = {}) {
  return async (job, context) => {
    assertJobScope(job);
    const user = await findUser(job.owner_id);
    if (!user || user.disabled || user.status === 'disabled') throw Object.assign(new Error('Task owner unavailable'), { retryable: false });
    context.signal.throwIfAborted();
    return snapshot({ userId: user.id, user, mailboxId: job.mailbox_id }, async () => {
      if (!readSettings().mailboxes.some(box => box.id === job.mailbox_id && (box.ownerUserId || box.userId) === user.id)) {
        throw Object.assign(new Error('Task mailbox unavailable'), { retryable: false });
      }
      context.signal.throwIfAborted();
      const result = await dispatch({ settings: readSettings(), mailboxIds: [job.mailbox_id],
        limit: Number(job.payload?.limit) > 0 ? Number(job.payload.limit) : 5 });
      return { mailboxId: job.mailbox_id, ...result };
    });
  };
}

/**
 * 生产 worker 的 receipts.check handler：在一个邮箱的存储快照内检查等回执。
 * 回执记录走 assistant-state（PG 权威），超时待办写回邮箱的日历快照，所以必须在快照里执行。
 * 检查本身幂等（待办 id 就是 receipt.taskId），重复任务不会多建待办、也不会重复完成。
 * 本机没有真实 PostgreSQL + worker 集群，这条路径是「代码已实现、未在真实集群验证」。
 */
export function createReceiptsHandler(jobs, { findUser = findUserById, snapshot = withStorageSnapshot,
  check = checkReceipts, notifyOverdue = notifyOverdueReceipts } = {}) {
  return async (job, context) => {
    assertJobScope(job);
    const user = await findUser(job.owner_id);
    if (!user || user.disabled || user.status === 'disabled') throw Object.assign(new Error('Task owner unavailable'), { retryable: false });
    context.signal.throwIfAborted();
    return snapshot({ userId: user.id, user, mailboxId: job.mailbox_id }, async () => {
      if (!readSettings().mailboxes.some(box => box.id === job.mailbox_id && (box.ownerUserId || box.userId) === user.id)) {
        throw Object.assign(new Error('Task mailbox unavailable'), { retryable: false });
      }
      context.signal.throwIfAborted();
      const result = await check(job.mailbox_id, { now: Date.now(), notifyOverdue });
      return { mailboxId: job.mailbox_id, ...result };
    });
  };
}

/**
 * 生产兜底：每分钟看一遍各邮箱的出站记录，凡是「已经到点或一分钟后到点」的就入队派发。
 * 重启后补发、以及比 120 秒更远的定时发送都靠它。同一邮箱已有 queued/running 的派发任务就跳过，
 * worker 长时间不可用时也不会堆积。这里和 scheduleExternalCalendars 一样用原生 SQL：
 * repository.enqueue 自己会开一个事务，不能在事务里再调用。
 */
export async function scheduleOutbound(jobs, now = new Date(), { limit = 50 } = {}) {
  const minute = Math.floor(now.getTime() / 60000);
  const dueBefore = now.getTime() + 60_000;
  return jobs.transaction(async client => {
    const { rows: settingsRows } = await client.query('SELECT payload FROM app_settings WHERE id=$1', [settingsKey('default')]);
    let scheduled = 0;
    let deferred = 0;
    for (const mailbox of settingsRows[0]?.payload?.mailboxes || []) {
      if (scheduled >= limit) break;
      const ownerId = mailbox.ownerUserId || mailbox.userId;
      if (!ownerId || mailbox.disabled) continue;
      const identity = createHash('sha256').update(`${ownerId}\0${mailbox.id}`).digest('hex');
      const { rows } = await client.query('SELECT payload FROM app_settings WHERE id=$1', [`assistant:outbound:${identity}`]);
      const items = rows[0]?.payload?.items || [];
      if (!items.some(item => item.status === 'scheduled' && Number.isFinite(Date.parse(item.sendAt)) && Date.parse(item.sendAt) <= dueBefore)) continue;
      const pending = await client.query(`SELECT 1 FROM daylight_jobs WHERE tenant_id=$1 AND owner_id=$2 AND mailbox_id=$3
        AND kind='outbound.dispatch' AND status IN ('queued','running') LIMIT 1`, [ownerId, mailbox.id]);
      if (pending.rows.length) { deferred += 1; continue; }
      await client.query('INSERT INTO daylight_job_mailboxes VALUES ($1,$2) ON CONFLICT DO NOTHING', [ownerId, mailbox.id]);
      await client.query('SELECT 1 FROM daylight_job_mailboxes WHERE tenant_id=$1 AND mailbox_id=$2 FOR UPDATE', [ownerId, mailbox.id]);
      const { rows: inserted } = await client.query(`INSERT INTO daylight_jobs
        (id,tenant_id,owner_id,mailbox_id,kind,idempotency_key,payload,max_attempts)
        VALUES ($1,$2,$2,$3,'outbound.dispatch',$4,$5::jsonb,5) ON CONFLICT DO NOTHING RETURNING *`,
      [randomUUID(), ownerId, mailbox.id, `outbound:scheduled:${minute}`, JSON.stringify({ trigger: 'scheduled' })]);
      if (inserted[0]) await jobs.notify(client, inserted[0]);
      scheduled += 1;
    }
    return { scheduled, deferred };
  });
}

/**
 * 生产兜底：每分钟看一遍各邮箱的回执记录，只要还有 waiting / overdue 就入队 receipts.check。
 * 本地 tick（server/index.js）负责单进程场景；这里负责集群里「谁在跑都行」的每分钟兜底。
 * 同一邮箱已有 queued/running 的检查任务就跳过，不会堆积。
 */
export async function scheduleReceipts(jobs, now = new Date(), { limit = 50 } = {}) {
  const minute = Math.floor(now.getTime() / 60000);
  return jobs.transaction(async client => {
    const { rows: settingsRows } = await client.query('SELECT payload FROM app_settings WHERE id=$1', [settingsKey('default')]);
    let scheduled = 0;
    let deferred = 0;
    for (const mailbox of settingsRows[0]?.payload?.mailboxes || []) {
      if (scheduled >= limit) break;
      const ownerId = mailbox.ownerUserId || mailbox.userId;
      if (!ownerId || mailbox.disabled) continue;
      const identity = createHash('sha256').update(`${ownerId}\0${mailbox.id}`).digest('hex');
      const { rows } = await client.query('SELECT payload FROM app_settings WHERE id=$1', [`assistant:receipts:${identity}`]);
      const items = rows[0]?.payload?.items || [];
      // 没有任何在等的回执就不入队，避免每分钟空跑任务。
      if (!items.some(item => item.status === 'waiting' || item.status === 'overdue')) continue;
      const pending = await client.query(`SELECT 1 FROM daylight_jobs WHERE tenant_id=$1 AND owner_id=$2 AND mailbox_id=$3
        AND kind='receipts.check' AND status IN ('queued','running') LIMIT 1`, [ownerId, mailbox.id]);
      if (pending.rows.length) { deferred += 1; continue; }
      await client.query('INSERT INTO daylight_job_mailboxes VALUES ($1,$2) ON CONFLICT DO NOTHING', [ownerId, mailbox.id]);
      await client.query('SELECT 1 FROM daylight_job_mailboxes WHERE tenant_id=$1 AND mailbox_id=$2 FOR UPDATE', [ownerId, mailbox.id]);
      const { rows: inserted } = await client.query(`INSERT INTO daylight_jobs
        (id,tenant_id,owner_id,mailbox_id,kind,idempotency_key,payload,max_attempts)
        VALUES ($1,$2,$2,$3,'receipts.check',$4,$5::jsonb,5) ON CONFLICT DO NOTHING RETURNING *`,
      [randomUUID(), ownerId, mailbox.id, `receipts:scheduled:${minute}`, JSON.stringify({ trigger: 'scheduled' })]);
      if (inserted[0]) await jobs.notify(client, inserted[0]);
      scheduled += 1;
    }
    return { scheduled, deferred };
  });
}

/**
 * 生产 worker 的 push.dispatch handler：在一个邮箱的存储快照内跑一次「到点的推送」
 * （早间简报 + 超时遗漏重推）。设备与回执记录走 assistant-state（PG 权威），简报只读邮箱日历快照。
 * 幂等：简报按「邮箱 + 北京日期」只推一次，超时回执按 notifiedOverdueAt 只推一次。
 * 本机没有真实 PostgreSQL + worker 集群，也没有 APNs 密钥与真机，这条路径是「代码已实现、未验证」。
 */
export function createPushHandler(jobs, { findUser = findUserById, snapshot = withStorageSnapshot,
  dispatch = dispatchPush } = {}) {
  return async (job, context) => {
    assertJobScope(job);
    const user = await findUser(job.owner_id);
    if (!user || user.disabled || user.status === 'disabled') throw Object.assign(new Error('Task owner unavailable'), { retryable: false });
    context.signal.throwIfAborted();
    return snapshot({ userId: user.id, user, mailboxId: job.mailbox_id }, async () => {
      if (!readSettings().mailboxes.some(box => box.id === job.mailbox_id && (box.ownerUserId || box.userId) === user.id)) {
        throw Object.assign(new Error('Task mailbox unavailable'), { retryable: false });
      }
      context.signal.throwIfAborted();
      const result = await dispatch(job.mailbox_id, { now: Date.now(), settings: readSettings() });
      return { mailboxId: job.mailbox_id, ...result };
    });
  };
}

/**
 * 生产兜底：每分钟看一遍各邮箱的设备登记，只有「简报已到点且当天没推」或「有超时回执没通知」时才入队
 * push.dispatch，避免每分钟空跑任务。同一邮箱已有 queued/running 的推送任务就跳过，不会堆积。
 * 本地单进程由 server/index.js 的每分钟 tick 负责。
 */
export async function schedulePush(jobs, now = new Date(), { limit = 50 } = {}) {
  const minute = Math.floor(now.getTime() / 60000);
  const date = beijingDate(now.getTime());
  const timeOfDay = (((now.getTime() + 8 * 3_600_000) % 86_400_000) + 86_400_000) % 86_400_000;
  const briefingWindow = timeOfDay >= 8 * 3_600_000;
  return jobs.transaction(async client => {
    const { rows: settingsRows } = await client.query('SELECT payload FROM app_settings WHERE id=$1', [settingsKey('default')]);
    let scheduled = 0;
    let deferred = 0;
    for (const mailbox of settingsRows[0]?.payload?.mailboxes || []) {
      if (scheduled >= limit) break;
      const ownerId = mailbox.ownerUserId || mailbox.userId;
      if (!ownerId || mailbox.disabled) continue;
      const identity = createHash('sha256').update(`${ownerId}\0${mailbox.id}`).digest('hex');
      const { rows: deviceRows } = await client.query('SELECT payload FROM app_settings WHERE id=$1', [`assistant:devices:${identity}`]);
      const items = (deviceRows[0]?.payload?.items || []).filter(item => item.status !== 'invalid');
      if (!items.length) continue;
      const pushedDates = deviceRows[0]?.payload?.briefingDates || {};
      const briefingDue = briefingWindow && !pushedDates[date];
      const { rows: receiptRows } = await client.query('SELECT payload FROM app_settings WHERE id=$1', [`assistant:receipts:${identity}`]);
      const overdue = (receiptRows[0]?.payload?.items || []).some(item => item.status === 'overdue' && !item.notifiedOverdueAt);
      if (!briefingDue && !overdue) continue;
      const pending = await client.query(`SELECT 1 FROM daylight_jobs WHERE tenant_id=$1 AND owner_id=$2 AND mailbox_id=$3
        AND kind='push.dispatch' AND status IN ('queued','running') LIMIT 1`, [ownerId, mailbox.id]);
      if (pending.rows.length) { deferred += 1; continue; }
      await client.query('INSERT INTO daylight_job_mailboxes VALUES ($1,$2) ON CONFLICT DO NOTHING', [ownerId, mailbox.id]);
      await client.query('SELECT 1 FROM daylight_job_mailboxes WHERE tenant_id=$1 AND mailbox_id=$2 FOR UPDATE', [ownerId, mailbox.id]);
      const { rows: inserted } = await client.query(`INSERT INTO daylight_jobs
        (id,tenant_id,owner_id,mailbox_id,kind,idempotency_key,payload,max_attempts)
        VALUES ($1,$2,$2,$3,'push.dispatch',$4,$5::jsonb,5) ON CONFLICT DO NOTHING RETURNING *`,
      [randomUUID(), ownerId, mailbox.id, `push:scheduled:${minute}`, JSON.stringify({ trigger: 'scheduled' })]);
      if (inserted[0]) await jobs.notify(client, inserted[0]);
      scheduled += 1;
    }
    return { scheduled, deferred };
  });
}
