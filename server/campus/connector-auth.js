import { randomBytes, createHash } from 'node:crypto';
import { redisGet, redisSet, redisDel } from '../infra/redis.js';
import { findUserById } from '../infra/postgres.js';
const key = value => createHash('sha256').update(value).digest('hex');
export async function issueCampusToken(userId, projectId) {
  const user = await findUserById(userId);
  const token = `campus_${randomBytes(32).toString('base64url')}`, id = key(token);
  const expiresAt = new Date(Date.now() + 90 * 86400000).toISOString();
  await redisSet(`campus-connector:${id}`, JSON.stringify({ userId, projectId, sv: Number(user.session_version || 0), expiresAt }), 90 * 86400);
  return { token, id, expiresAt };
}
export async function resolveCampusToken(header, method, path) {
  const token = /^Bearer (campus_[A-Za-z0-9_-]{43})$/.exec(header || '')?.[1];
  if (!token) return null;
  const id = key(token), raw = await redisGet(`campus-connector:${id}`);
  if (!raw) return null;
  const record = JSON.parse(raw);
  const match = /^\/campus\/projects\/([^/]+)\/(snapshot|documents|sync-status|import)$/.exec(path);
  if (method !== 'POST' || !match || match[1] !== record.projectId) return null;
  const user = await findUserById(record.userId);
  if (!user || Number(user.session_version || 0) !== record.sv) return null;
  return { user, projectId: record.projectId, id };
}
export async function revokeCampusToken(id) { if (/^[a-f0-9]{64}$/.test(id)) await redisDel(`campus-connector:${id}`); }
