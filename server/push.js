/**
 * 推送与通知（设备令牌登记 + APNs 投递 + 角标 + 触发）。
 *
 * 纪律：
 *  - **没配置就说没配置**：没有 Apple 开发者账号的 .p8 / Key ID / Team ID / Bundle ID 时
 *    `configured:false` + 一句可读的 `reason`，所有发送入口立刻返回、绝不建立网络连接，
 *    更不会假装「已推送」。测试接口返回 503 PUSH_NOT_CONFIGURED 而不是成功。
 *  - **秘密不外泄**：设备令牌只以 `tokenTail`（`…abcd`）示人，p8 私钥和 JWT 不进日志、
 *    错误消息和 `GET /api/push/status` 的响应；错误一律经 sanitizeSnapshot 脱敏。
 *  - 令牌登记落在 assistant-state 的 `devices` 命名空间（本地 JSON 或 PostgreSQL 权威都自动支持），
 *    以当前邮箱为作用域：一个用户多个邮箱即多条记录，记录里带 `mailboxIds` 数组。
 *  - 发送入口全部依赖注入（`connect` / `sendOne` / `sign`），测试不连网；真实投递需要 .p8 与真机，
 *    本机完全没有，所以这里只做到「代码已实现、未在真实 APNs 验证」。
 *  - 时间统一存 ISO / epoch 毫秒；「北京时间 08:00」这类人类语义只在触发判断里用。
 */
import crypto, { randomUUID } from 'node:crypto';
import http2 from 'node:http2';
import { readAssistantState, mutateAssistantState } from './assistant-state.js';
import { readSettings } from './store.js';
import { readInfraConfig } from './infra/config.js';
import { sanitizeSnapshot } from './traces.js';
import { beijingDate, buildBriefing } from './briefing.js';

export const DEVICES_NAMESPACE = 'devices';
export const RECEIPTS_NAMESPACE = 'receipts';
export const SCHEMA_VERSION = 1;
export const MAX_TOKEN_LENGTH = 200;
export const MIN_TOKEN_LENGTH = 8;
export const MAX_BADGE = 9999;
export const DEFAULT_APNS_TIMEOUT_MS = 10_000;
export const APNS_EXPIRATION_MS = 3_600_000;
export const NOT_CONFIGURED_REASON = '没有配置 APNs 密钥（需要 Apple 开发者账号的 .p8 密钥 + Key ID + Team ID + Bundle ID）。';
/** 通知分类：客户端据此决定点开后跳到哪里。 */
export const PUSH_CATEGORIES = Object.freeze({
  mail: 'daylight-mail',
  briefing: 'daylight-briefing',
  receipt: 'daylight-receipt',
});

const DAY_MS = 86_400_000;
const BEIJING_OFFSET = 8 * 3_600_000;
const fail = (message, status, code) => Object.assign(new Error(message), { status, code });
const iso = (value) => new Date(Number(value)).toISOString();
const clone = (value) => JSON.parse(JSON.stringify(value));
const list = (value) => (Array.isArray(value) ? value : []);

/** 错误脱敏：绝不把令牌 / p8 私钥带进日志和错误消息。 */
function sanitize(error, secrets = []) {
  const text = typeof error === 'string' ? error : String(error?.message || error || '推送失败');
  return sanitizeSnapshot(text, secrets.filter((item) => typeof item === 'string' && item.length)).slice(0, 300);
}

// ── 纯函数：JWT / 主机 / 载荷 / 对外形态 ─────────────────────

export function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

export function buildJwtHeader({ keyId } = {}) {
  return { alg: 'ES256', kid: keyId };
}

export function buildJwtPayload({ teamId, issuedAt } = {}) {
  return { iss: teamId, iat: issuedAt };
}

export function tokenTail(token) {
  const text = String(token || '');
  return text ? `…${text.slice(-4)}` : '';
}

export function clampBadge(value) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return 0;
  return Math.min(MAX_BADGE, Math.max(0, number));
}

/** apnsHost 只认两种环境；其余一律当作生产（不静默连到错误的网关）。 */
export function apnsHost(environment) {
  return environment === 'sandbox' ? 'api.sandbox.push.apple.com' : 'api.push.apple.com';
}

/**
 * 组装 APNs 载荷。纯函数：
 *  - `alert` 恒在；`badge` 夹取到 0–9999；有 threadId / category / interruptionLevel 才写入；
 *  - 自定义字段统一放顶层 `data`，与 APNs 约定一致。
 */
export function buildApnsPayload({ title, body, badge, threadId, category, sound = 'default', interruptionLevel = 'active', data } = {}) {
  const aps = { alert: { title: String(title ?? ''), body: String(body ?? '') } };
  if (badge !== undefined && badge !== null && Number.isFinite(Number(badge))) aps.badge = clampBadge(badge);
  if (sound) aps.sound = String(sound);
  if (threadId) aps['thread-id'] = String(threadId);
  if (category) aps.category = String(category);
  if (interruptionLevel) aps['interruption-level'] = String(interruptionLevel);
  const payload = { aps };
  if (data && typeof data === 'object') payload.data = data;
  return payload;
}

/** 对外形态：只给令牌指纹，绝不给完整令牌。 */
export function publicDevice(record = {}) {
  return {
    id: record.id,
    platform: record.platform || 'ios',
    environment: record.environment || 'production',
    tokenTail: tokenTail(record.token),
    mailboxIds: list(record.mailboxIds),
    locale: record.locale || '',
    status: record.status || 'active',
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    lastAttemptAt: record.lastAttemptAt || null,
    lastOkAt: record.lastOkAt || null,
    lastError: record.lastError || null,
  };
}

/** 把单行 / base64 里塞进来的 p8 归一成带换行的 PEM；不做任何输出。 */
export function normalizePrivateKey(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (!text) return '';
  if (!text.includes('BEGIN') && !text.includes('\n')) {
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      if (decoded.includes('BEGIN')) text = decoded;
    } catch { /* 保持原值，后面按未配置处理。 */ }
  }
  return text.replace(/\\n/g, '\n');
}

/**
 * 归一 APNs 配置：环境变量优先于 infra.json 的 apns 段（生产只从环境变量读，见 infra/config.js）。
 * 缺任何一项都返回 `configured:false` + 明确 reason，绝不「差不多能用」。
 */
export function apnsConfigFrom({ env = process.env, infra = null } = {}) {
  const section = (infra && infra.apns) || {};
  const pick = (key, fallback) => {
    const value = env?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    return typeof fallback === 'string' ? fallback.trim() : '';
  };
  const teamId = pick('DAYLIGHT_APNS_TEAM_ID', section.teamId);
  const keyId = pick('DAYLIGHT_APNS_KEY_ID', section.keyId);
  const bundleId = pick('DAYLIGHT_APNS_BUNDLE_ID', section.bundleId || section.topic);
  const privateKey = normalizePrivateKey(pick('DAYLIGHT_APNS_PRIVATE_KEY', section.privateKey));
  const requested = pick('DAYLIGHT_APNS_ENVIRONMENT', section.environment) || 'production';
  const environment = requested === 'sandbox' ? 'sandbox' : 'production';
  const missing = [];
  if (!teamId) missing.push('Team ID');
  if (!keyId) missing.push('Key ID');
  if (!privateKey) missing.push('.p8 私钥');
  if (!bundleId) missing.push('Bundle ID');
  const configured = missing.length === 0 && privateKey.includes('BEGIN') && privateKey.includes('PRIVATE KEY');
  return {
    configured,
    environment,
    teamId,
    keyId,
    privateKey,
    bundleId,
    teamIdTail: teamId ? tokenTail(teamId) : '',
    keyIdTail: keyId ? tokenTail(keyId) : '',
    reason: configured ? '' : `${NOT_CONFIGURED_REASON}${missing.length ? `（缺少：${missing.join('、')}）` : ''}`,
  };
}

/** 用 ES256 组装 JWT（header.payload.signature），signature 走 ieee-p1363。 */
export function signApnsJwt({ teamId, keyId, issuedAt, sign }) {
  const header = buildJwtHeader({ keyId });
  const payload = buildJwtPayload({ teamId, issuedAt });
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign(signingInput);
  if (!signature) throw new Error('APNs JWT 签名失败。');
  return { token: `${signingInput}.${base64url(signature)}`, header, payload };
}

// ── APNs 发送器（全部依赖注入，便于测试不连网） ──────────────

/**
 * 创建 APNs 发送器。
 *  - `connect` 默认 `http2.connect`，测试可注入假会话；
 *  - `sign` 默认用 config.privateKey 走 ES256（ieee-p1363）；
 *  - JWT 按「小时」缓存：同一小时内复用，跨小时重签（Apple 允许 token 最长 1 小时）；
 *  - 每次请求带超时（默认 10s），失败返回结构化原因，绝不抛到调用方之外。
 */
export function createApnsSender({
  config, connect = http2.connect, now = () => Date.now(), sign, timeoutMs = DEFAULT_APNS_TIMEOUT_MS,
} = {}) {
  const secrets = [config?.privateKey].filter(Boolean);
  const signer = sign || ((data) => crypto.sign('sha256', Buffer.from(data), { key: config.privateKey, dsaEncoding: 'ieee-p1363' }));
  let cached = null;

  function bearerToken(atMs) {
    const hour = Math.floor(atMs / 3_600_000);
    if (cached && cached.hour === hour) return cached.token;
    const { token } = signApnsJwt({
      teamId: config.teamId, keyId: config.keyId, issuedAt: Math.floor(atMs / 1000), sign: signer,
    });
    cached = { hour, token };
    return token;
  }

  function resultFor(status, text) {
    if (status === 200) return { ok: true, configured: true, status };
    let reason = '';
    try { reason = JSON.parse(text || '{}').reason || ''; } catch { /* 响应不是 JSON 就退回状态码。 */ }
    return {
      ok: false,
      configured: true,
      status,
      reason: reason || `HTTP_${status || 0}`,
      tokenInvalid: status === 410,
      authError: status === 401 || status === 403,
    };
  }

  async function send(device, payload) {
    if (!config?.configured) {
      return { ok: false, configured: false, status: 0, reason: config?.reason || NOT_CONFIGURED_REASON };
    }
    const token = String(device?.token || '');
    if (!token) return { ok: false, configured: true, status: 0, reason: 'DEVICE_TOKEN_MISSING' };
    const atMs = Number(now());
    let authorization;
    try { authorization = `bearer ${bearerToken(atMs)}`; }
    catch (error) { return { ok: false, configured: true, status: 0, reason: 'JWT_SIGN_FAILED', error: sanitize(error, secrets) }; }
    const environment = device.environment === 'sandbox' || device.environment === 'production' ? device.environment : config.environment;
    const host = apnsHost(environment);
    const body = JSON.stringify(payload || {});
    const expiration = Math.floor((atMs + APNS_EXPIRATION_MS) / 1000);
    return await new Promise((resolve) => {
      let settled = false;
      let status = 0;
      let responseText = '';
      let request = null;
      let client = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { request?.close?.(); } catch { /* ignore */ }
        try { client?.close?.(); } catch { /* ignore */ }
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, configured: true, status: 0, reason: 'TIMEOUT', host, environment }), timeoutMs);
      try {
        client = connect(`https://${host}`);
        client.on?.('error', (error) => finish({ ok: false, configured: true, status: 0, reason: 'CONNECT_ERROR', error: sanitize(error, secrets) }));
        request = client.request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          ':authority': host,
          authorization,
          'apns-topic': config.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(expiration),
        });
        request.setEncoding?.('utf8');
        request.on('response', (headers) => { status = Number(headers[':status']) || 0; });
        request.on('data', (chunk) => { responseText = `${responseText}${chunk}`.slice(-2048); });
        request.on('end', () => finish(resultFor(status, responseText)));
        request.on('error', (error) => finish({ ok: false, configured: true, status, reason: 'REQUEST_ERROR', error: sanitize(error, secrets) }));
        request.write(body);
        request.end();
      } catch (error) {
        finish({ ok: false, configured: true, status: 0, reason: 'CONNECT_ERROR', error: sanitize(error, secrets) });
      }
    });
  }

  return { send, bearerToken, resultFor, host: () => apnsHost(config?.environment || 'production') };
}

// ── 输入归一 ─────────────────────────────────────────────────

export function normalizeToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (!token) throw fail('请提供设备推送令牌。', 400, 'PUSH_DEVICE_REQUIRED');
  if (token.length > MAX_TOKEN_LENGTH) throw fail(`设备令牌最长 ${MAX_TOKEN_LENGTH} 个字符。`, 400, 'PUSH_DEVICE_INVALID');
  if (token.length < MIN_TOKEN_LENGTH || !/^[0-9a-fA-F]+$/.test(token)) {
    throw fail('设备令牌不是合法的 APNs 十六进制令牌。', 400, 'PUSH_DEVICE_INVALID');
  }
  return token.toLowerCase();
}

function normalizePlatform(value) {
  const platform = String(value ?? 'ios').trim().toLowerCase() || 'ios';
  if (platform !== 'ios') throw fail('目前只支持 iOS 设备的推送令牌。', 400, 'PUSH_DEVICE_INVALID');
  return platform;
}

function normalizeEnvironment(value, fallback = 'production') {
  if (value === undefined || value === null || value === '') return fallback === 'sandbox' ? 'sandbox' : 'production';
  const environment = String(value).trim().toLowerCase();
  if (!['sandbox', 'production'].includes(environment)) throw fail('推送环境只能是 sandbox 或 production。', 400, 'PUSH_DEVICE_INVALID');
  return environment;
}

function singleLine(value, max, fallback = '') {
  if (value === undefined || value === null) return fallback;
  const text = String(value).replace(/[\r\n]+/g, ' ').trim();
  if (text.length > max) throw fail(`内容不能超过 ${max} 个字符。`, 400, 'PUSH_MESSAGE_INVALID');
  return text;
}

// ── 设备登记（assistant-state `devices` 命名空间，按邮箱作用域） ──

export async function readDeviceState(mailboxId, { readState = readAssistantState } = {}) {
  return readState(mailboxId, DEVICES_NAMESPACE);
}

function activeDevices(items) {
  return list(items).filter((item) => item.status !== 'invalid');
}

/**
 * 登记 / 更新设备。同一邮箱作用域内同一 token 只更新不新增；`mailboxIds` 做并集合并。
 * 返回对外形态（只有 tokenTail），绝不回传完整令牌。
 */
export async function registerDevice(mailboxId, input = {}, { settings = readSettings(), config = null, now = Date.now() } = {}) {
  const token = normalizeToken(input.token);
  const platform = normalizePlatform(input.platform);
  const environment = normalizeEnvironment(input.environment, config?.environment);
  const locale = typeof input.locale === 'string' ? input.locale.trim().slice(0, 40) : '';
  const extraMailboxIds = list(input.mailboxIds).map((id) => String(id).trim()).filter(Boolean);
  for (const id of extraMailboxIds) {
    if (!(settings.mailboxes || []).some((box) => box.id === id)) throw fail('邮箱不存在或不属于当前用户。', 403, 'MAILBOX_FORBIDDEN');
  }
  const at = iso(now);
  const outcome = await mutateAssistantState(mailboxId, DEVICES_NAMESPACE, (data) => {
    data.schemaVersion = SCHEMA_VERSION;
    if (!Array.isArray(data.items)) data.items = [];
    const existing = data.items.find((item) => item.token === token);
    const merged = [...new Set([...list(existing?.mailboxIds), mailboxId, ...extraMailboxIds])];
    if (existing) {
      Object.assign(existing, { platform, environment, locale, mailboxIds: merged, status: 'active', lastError: null, updatedAt: at });
      return { record: clone(existing) };
    }
    const item = {
      id: randomUUID(), token, platform, environment, locale, mailboxIds: merged,
      status: 'active', lastError: null, createdAt: at, updatedAt: at, lastAttemptAt: null, lastOkAt: null,
    };
    data.items.push(item);
    return { record: clone(item) };
  });
  return { device: publicDevice(outcome.record) };
}

/** 注销：删不掉也如实返回 removed:false，不假装成功。 */
export async function removeDevice(mailboxId, value, { now = Date.now() } = {}) {
  const token = normalizeToken(value);
  const outcome = await mutateAssistantState(mailboxId, DEVICES_NAMESPACE, (data) => {
    const items = list(data.items);
    const index = items.findIndex((item) => item.token === token);
    if (index < 0) return { removed: false };
    items.splice(index, 1);
    return { removed: true };
  });
  void now;
  return { removed: outcome.removed === true };
}

/** 记录客户端当前角标。服务器不维护自己的未读口径，只存客户端给的数。 */
export async function setClientBadge(mailboxId, value, { now = Date.now() } = {}) {
  if (value === undefined || value === null || value === '') throw fail(`角标请填 0–${MAX_BADGE} 的整数。`, 400, 'PUSH_BADGE_INVALID');
  const badge = Number(value);
  if (!Number.isInteger(badge) || badge < 0 || badge > MAX_BADGE) throw fail(`角标请填 0–${MAX_BADGE} 的整数。`, 400, 'PUSH_BADGE_INVALID');
  const at = iso(now);
  await mutateAssistantState(mailboxId, DEVICES_NAMESPACE, (data) => {
    data.schemaVersion = SCHEMA_VERSION;
    data.badge = badge;
    data.badgeUpdatedAt = at;
    return null;
  });
  return { badge, updatedAt: at };
}

// ── 发送与状态落盘 ───────────────────────────────────────────

/**
 * 把一次发送的结果写回设备记录：成功清 lastError、失败写 lastError；
 * 410（令牌失效）把设备标 `invalid` 并停止再发——绝不反复重试一个死令牌。
 */
async function persistAttempt(mailboxId, atMs, results, { mutateState = mutateAssistantState } = {}) {
  const at = iso(atMs);
  try {
    await mutateState(mailboxId, DEVICES_NAMESPACE, (data) => {
      if (!Array.isArray(data.items)) data.items = [];
      for (const result of results) {
        const item = data.items.find((device) => device.id === result.deviceId);
        if (!item) continue;
        item.lastAttemptAt = at;
        if (result.ok) {
          item.lastOkAt = at;
          item.lastError = null;
        } else {
          item.lastError = sanitize(result.reason || `HTTP ${result.status || 0}`, [item.token]);
          if (result.tokenInvalid) { item.status = 'invalid'; item.invalidAt = at; }
        }
      }
      const ok = results.some((result) => result.ok);
      data.lastAttempt = { at, ok, ...(ok ? {} : { error: sanitize(results.find((result) => !result.ok)?.reason || '推送失败') }) };
      if (ok) data.deliveredAt = at;
      return null;
    });
  } catch { /* 状态落盘失败不影响「这次有没有真的发出去」的结论。 */ }
}

/**
 * 给一组设备发同一个载荷。返回 { sent, failed, results }。
 * 已标 invalid 的设备直接跳过（不发也不计入结果）。
 */
export async function sendToDevices(mailboxId, devices, buildPayload, {
  config, sender = null, now = Date.now(), mutateState = mutateAssistantState, timeoutMs,
} = {}) {
  const atMs = Number(now);
  const engine = sender || createApnsSender({ config, timeoutMs });
  const recipients = activeDevices(devices);
  const results = [];
  for (const device of recipients) {
    let outcome;
    try {
      outcome = await engine.send(device, buildPayload(device));
    } catch (error) {
      outcome = { ok: false, status: 0, reason: 'SEND_FAILED', error: sanitize(error, [device.token]) };
    }
    results.push({
      deviceId: device.id,
      tokenTail: tokenTail(device.token),
      ok: outcome?.ok === true,
      status: Number(outcome?.status) || 0,
      ...(outcome?.ok === true ? {} : { reason: sanitize(outcome?.reason || '推送失败', [device.token]) }),
      tokenInvalid: outcome?.status === 410,
    });
  }
  if (results.length) await persistAttempt(mailboxId, atMs, results, { mutateState });
  return { sent: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, results };
}

/** 状态自检：configured / 环境 / 指纹 / 设备列表 / 最近一次尝试。绝不回传完整令牌或私钥。 */
export async function pushStatus(mailboxId, { infra = null, env = process.env, config = null, readState = readAssistantState } = {}) {
  const resolved = config || apnsConfigFrom({ env, infra: infra || readInfraConfig() });
  const data = await readState(mailboxId, DEVICES_NAMESPACE);
  return {
    configured: resolved.configured === true,
    environment: resolved.environment,
    teamIdTail: resolved.teamIdTail,
    keyIdTail: resolved.keyIdTail,
    reason: resolved.configured ? '' : resolved.reason,
    devices: list(data.items).map(publicDevice),
    lastAttempt: data.lastAttempt || null,
    deliveredAt: data.deliveredAt || null,
    badge: Number.isInteger(data.badge) ? data.badge : null,
  };
}

/** 测试推送：未配置 → 503 PUSH_NOT_CONFIGURED（绝不返回成功）；没有设备 → 400 PUSH_NO_DEVICE。 */
export async function sendTestPush(mailboxId, input = {}, {
  infra = null, env = process.env, config = null, sender = null, now = Date.now(),
} = {}) {
  const resolved = config || apnsConfigFrom({ env, infra: infra || readInfraConfig() });
  if (!resolved.configured) throw fail(`没有配置 APNs，推送不会发出：${resolved.reason}`, 503, 'PUSH_NOT_CONFIGURED');
  const data = await readAssistantState(mailboxId, DEVICES_NAMESPACE);
  const devices = activeDevices(data.items);
  if (!devices.length) throw fail('这个邮箱还没有登记任何可用设备，先在手机上登记推送令牌。', 400, 'PUSH_NO_DEVICE');
  const title = singleLine(input.title, 100, 'Daylight 测试推送');
  const body = singleLine(input.body, 300, '如果你看到这条通知，说明这台设备已经能收到 Daylight 的推送。');
  const badge = Number.isInteger(data.badge) ? data.badge : undefined;
  const payload = buildApnsPayload({ title, body, badge, threadId: mailboxId });
  return sendToDevices(mailboxId, devices, () => payload, { config: resolved, sender, now });
}

// ── 触发 ────────────────────────────────────────────────────

/**
 * 新邮件触发：同步结束后有新邮件才推；没有新邮件直接 skipped，且未配置时绝不建连。
 * badge = 未读数 M（按产品要求，新邮件角标用服务器算出的未读），threadId = 邮箱 id。
 */
export async function notifyNewMail(mailboxId, {
  newCount = 0, unreadCount = 0, infra = null, env = process.env, config = null, sender = null, now = Date.now(),
} = {}) {
  const total = Math.max(0, Number(newCount) || 0);
  if (total <= 0) return { sent: 0, failed: 0, results: [], skipped: true, configured: null };
  const resolved = config || apnsConfigFrom({ env, infra: infra || readInfraConfig() });
  const data = await readAssistantState(mailboxId, DEVICES_NAMESPACE);
  const devices = activeDevices(data.items);
  if (!resolved.configured || !devices.length) {
    return { sent: 0, failed: 0, results: [], skipped: true, configured: resolved.configured === true };
  }
  const unread = Math.max(0, Number(unreadCount) || 0);
  const payload = buildApnsPayload({
    title: '收到新邮件',
    body: `收到 ${total} 封新邮件 · 未读 ${unread} 封`,
    badge: unread,
    threadId: mailboxId,
    category: PUSH_CATEGORIES.mail,
  });
  const outcome = await sendToDevices(mailboxId, devices, () => payload, { config: resolved, sender, now });
  return { ...outcome, skipped: false, configured: true };
}

/**
 * 等回信超时触发。扫描该邮箱「已超时且还没通知过」的回执，逐条推送并标 `notifiedOverdueAt`
 * 做幂等键；同一条只推一次。推送失败（有设备但全失败）时不标记，留给 dispatchPush 下一拍重推。
 * 未配置 / 无设备时直接 skipped，绝不建连。
 */
export async function notifyOverdueReceipts(mailboxId, {
  infra = null, env = process.env, config = null, sender = null, now = Date.now(),
  readState = readAssistantState, mutateState = mutateAssistantState,
} = {}) {
  const resolved = config || apnsConfigFrom({ env, infra: infra || readInfraConfig() });
  const receipts = await readState(mailboxId, RECEIPTS_NAMESPACE);
  const overdue = list(receipts.items).filter((item) => item.status === 'overdue' && !item.notifiedOverdueAt);
  if (!overdue.length) return { pushed: 0, failed: 0, skipped: 0, configured: resolved.configured === true };
  if (!resolved.configured) return { pushed: 0, failed: 0, skipped: overdue.length, configured: false };
  const deviceState = await readState(mailboxId, DEVICES_NAMESPACE);
  const devices = activeDevices(deviceState.items);
  if (!devices.length) return { pushed: 0, failed: 0, skipped: overdue.length, configured: true };
  let pushed = 0;
  let failed = 0;
  let skipped = 0;
  for (const receipt of overdue) {
    const payload = buildApnsPayload({
      title: '等回信超时',
      body: `等回信超时：${receipt.subject || '（无主题）'}`,
      threadId: mailboxId,
      category: PUSH_CATEGORIES.receipt,
    });
    const outcome = await sendToDevices(mailboxId, devices, () => payload, { config: resolved, sender, now });
    // 只要真发出去一条、或所有设备都给了明确答复（没有可重试的网络失败），就记为已通知。
    const settled = outcome.sent > 0 || outcome.failed === 0;
    if (settled) {
      await mutateState(mailboxId, RECEIPTS_NAMESPACE, (data) => {
        const item = list(data.items).find((entry) => entry.id === receipt.id);
        if (item && !item.notifiedOverdueAt) { item.notifiedOverdueAt = iso(now); item.updatedAt = iso(now); }
        return null;
      });
      pushed += 1;
    } else {
      failed += 1;
    }
    if (outcome.results.length === 0) skipped += 1;
  }
  return { pushed, failed, skipped, configured: true };
}

/**
 * 「该邮箱到点的推送」：早间简报（北京时间每天 08:00，用「邮箱 + 北京日期」幂等，一天只推一次）
 * 与超时遗漏重推。本地每分钟 tick 与生产 push.dispatch job 都调它。
 * 返回汇总 { briefing: 0|1, receipts: n, skipped }。
 */
export async function dispatchPush(mailboxId, {
  now = Date.now(), settings = readSettings(), infra = null, env = process.env, config = null,
  sender = null, readState = readAssistantState, mutateState = mutateAssistantState,
  briefing = buildBriefing, receipts = true,
} = {}) {
  const resolved = config || apnsConfigFrom({ env, infra: infra || readInfraConfig() });
  const atMs = Number(now);
  const summary = { briefing: 0, receipts: 0, skipped: 0 };
  const data = await readState(mailboxId, DEVICES_NAMESPACE);
  const devices = activeDevices(data.items);
  if (!devices.length || !resolved.configured) {
    summary.skipped += 1;
    return summary;
  }
  const date = beijingDate(atMs);
  const timeOfDay = (((atMs + BEIJING_OFFSET) % DAY_MS) + DAY_MS) % DAY_MS;
  const pushedDates = data.briefingDates && typeof data.briefingDates === 'object' ? data.briefingDates : {};
  if (timeOfDay >= 8 * 3_600_000 && !pushedDates[date]) {
    const { text } = await briefing(mailboxId, { now: atMs, settings });
    const badge = Number.isInteger(data.badge) ? data.badge : undefined;
    const payload = buildApnsPayload({ title: '早间简报', body: text, badge, threadId: mailboxId, category: PUSH_CATEGORIES.briefing });
    const outcome = await sendToDevices(mailboxId, devices, () => payload, { config: resolved, sender, now: atMs });
    if (outcome.sent > 0 || outcome.failed === 0) {
      await mutateState(mailboxId, DEVICES_NAMESPACE, (state) => {
        state.briefingDates = state.briefingDates && typeof state.briefingDates === 'object' ? state.briefingDates : {};
        state.briefingDates[date] = iso(atMs);
        return null;
      });
      summary.briefing = 1;
    } else {
      summary.skipped += 1;
    }
  } else {
    summary.skipped += 1;
  }
  if (receipts) {
    const overdue = await notifyOverdueReceipts(mailboxId, { config: resolved, sender, now: atMs, readState, mutateState });
    summary.receipts = overdue.pushed;
    summary.skipped += overdue.skipped;
  }
  return summary;
}
