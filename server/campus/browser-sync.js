import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { SOURCES, fail } from './domain.js';
import { currentGraduateTerm } from './importers.js';

const running = new Set();
const progress = new Map();

export function readCampusProgress(userId) {
  return progress.get(userId) || { phase: 'idle', source: '', done: 0, total: 0, label: '' };
}

function report(userId, patch) {
  progress.set(userId, { phase: 'running', source: '', done: 0, total: 0, label: '', ...progress.get(userId), ...patch });
}
const CHROME_ROOT = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
const GRADUATE_ORIGIN = 'https://graduate.shanghaitech.edu.cn';
const GRADUATE_TIMETABLE = `${GRADUATE_ORIGIN}/gsapp/sys/wdkbappshtech/*default/index.do`;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loginRequired(message) {
  return Object.assign(fail(message, 409), { retry: true });
}

function chromeKey() {
  let password = '';
  try {
    password = execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage', '-a', 'Chrome'], { encoding: 'utf8' }).trim();
  } catch {
    throw fail('读不到本机 Chrome 的登录状态。请先打开普通 Chrome 并登录学校网站。', 503);
  }
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

function decryptCookie(key, host, hexValue) {
  const blob = Buffer.from(hexValue, 'hex');
  const prefix = blob.subarray(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') return blob.toString('latin1');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const plain = Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]);
  const digest = crypto.createHash('sha256').update(host).digest();
  const value = plain.subarray(0, 32).equals(digest) ? plain.subarray(32) : plain;
  return value.toString('latin1');
}

function chromeProfiles() {
  const statePath = path.join(CHROME_ROOT, 'Local State');
  if (!fs.existsSync(statePath)) throw fail('没有找到本机 Google Chrome。请先安装并登录学校网站。', 503);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const names = Object.keys(state?.profile?.info_cache || {});
  const last = state?.profile?.last_used;
  return [...new Set([last, ...names].filter(Boolean))];
}

function cookieDatabase(profile) {
  const dir = path.join(CHROME_ROOT, profile);
  for (const relative of ['Cookies', path.join('Network', 'Cookies')]) {
    const file = path.join(dir, relative);
    if (fs.existsSync(file)) return file;
  }
  return '';
}

function hostMatches(hostKey, hostname) {
  const host = hostKey.startsWith('.') ? hostKey.slice(1) : hostKey;
  if (hostKey.startsWith('.')) return hostname === host || hostname.endsWith(`.${host}`);
  return hostname === host;
}

function stillValid(expiresUtc) {
  const raw = Number(expiresUtc);
  if (!raw) return true;
  const unix = raw / 1_000_000 - 11_644_473_600;
  return unix > Date.now() / 1000;
}

/** Reads only school and Piazza cookies from the normal Chrome profile. Values stay in memory. */
function readSchoolCookies() {
  const key = chromeKey();
  const cookies = [];
  for (const profile of chromeProfiles()) {
    const database = cookieDatabase(profile);
    if (!database) continue;
    const copy = path.join(os.tmpdir(), `daylight-chrome-${process.pid}-${profile.replace(/\W/g, '')}.sqlite`);
    try {
      execFileSync('sqlite3', [database, `.backup '${copy.replaceAll("'", '')}'`], { stdio: 'ignore' });
    } catch {
      continue;
    }
    let output = '';
    try {
      output = execFileSync('sqlite3', ['-separator', '\t', copy, `SELECT host_key, name, hex(encrypted_value), path, expires_utc FROM cookies WHERE host_key LIKE '%shanghaitech.edu.cn%' OR host_key LIKE '%piazza.com%'`], { encoding: 'utf8', maxBuffer: 8_000_000 });
    } catch {
      output = '';
    } finally {
      fs.rmSync(copy, { force: true });
    }
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;
      const [host, name, hexValue, cookiePath, expires] = line.split('\t');
      if (!host || !name || !hexValue || !stillValid(expires)) continue;
      try {
        cookies.push({ host, name, value: decryptCookie(key, host, hexValue), path: cookiePath || '/' });
      } catch {
        // Skip a cookie we cannot decrypt. The rest of the session can still be used.
      }
    }
  }
  return cookies;
}

let cookieCache = null;
function schoolCookies() {
  if (cookieCache && Date.now() - cookieCache.at < 60_000) return cookieCache.cookies.map((cookie) => ({ ...cookie }));
  const cookies = readSchoolCookies();
  cookieCache = { at: Date.now(), cookies };
  return cookies.map((cookie) => ({ ...cookie }));
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      out[index] = await fn(items[index], index);
    }
  }));
  return out;
}

function cookieHeader(cookies, url) {
  const target = new URL(url);
  const matches = cookies.filter((cookie) => hostMatches(cookie.host, target.hostname) && target.pathname.startsWith(cookie.path || '/'));
  matches.sort((a, b) => b.host.length - a.host.length);
  const picked = new Map();
  for (const cookie of matches) if (!picked.has(cookie.name)) picked.set(cookie.name, cookie.value);
  return [...picked.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function absorbCookies(cookies, url, response) {
  const lines = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  const hostname = new URL(url).hostname;
  for (const line of lines) {
    const pair = line.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const existing = cookies.find((cookie) => cookie.name === name && cookie.host === hostname);
    if (existing) existing.value = value;
    else cookies.push({ host: hostname, name, value, path: '/' });
  }
}

function openNormalChrome(url) {
  execFile('open', ['-a', 'Google Chrome', url], () => {});
}

async function requestText(url, cookies, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  const response = await fetch(url, {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': USER_AGENT,
      Cookie: cookieHeader(cookies, url),
      ...headers,
    },
    body,
  });
  absorbCookies(cookies, url, response);
  return { status: response.status, text: await response.text(), url: response.url };
}

function isLoginDocument(url, text) {
  if (/authserver|\/login(?:\/|$|\?)|\/signin|blackboard\.login/i.test(url)) return true;
  const head = text.slice(0, 4000);
  return /统一身份认证/.test(head) && /type=["']password["']|登录/.test(head);
}

async function collectGraduate(userId) {
  report(userId, { source: 'graduate', label: '正在读取研究生课表', done: 0, total: 1 });
  const cookies = schoolCookies();
  const term = currentGraduateTerm();
  await requestText(GRADUATE_TIMETABLE, cookies).catch(() => {});
  const result = await requestText(`${GRADUATE_ORIGIN}/gsapp/sys/wdkbappshtech/modules/xskcb/xsjxrwcx.do`, cookies, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: GRADUATE_ORIGIN,
      Referer: GRADUATE_TIMETABLE,
    },
    body: `XNXQDM=${term}&pageNumber=1&pageSize=100`,
  });
  const trimmed = result.text.trim();
  if (!trimmed.startsWith('{')) {
    if (isLoginDocument(result.url, result.text)) throw loginRequired('请在刚打开的普通 Chrome 窗口里登录研究生系统，登录完成后会自动读取课表。');
    throw fail('课表接口返回的不是课程数据。请在普通 Chrome 里打开「我的课表」后再同步。', 409);
  }
  const payload = JSON.parse(trimmed);
  const rows = payload?.datas?.xsjxrwcx?.rows;
  if (!Array.isArray(rows) || !rows.length) throw fail('登录态已经拿到，但当前学期接口没有课程。', 409);
  report(userId, { source: 'graduate', label: `已读取 ${rows.length} 门课程`, done: 1, total: 1 });
  return { source: 'graduate', payload, files: [] };
}

function embeddedJson(html, marker) {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  let index = start + marker.length;
  while (html[index] === ' ') index += 1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let end = index; end < html.length; end += 1) {
    const char = html[end];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return JSON.parse(html.slice(index, end + 1));
    }
  }
  return null;
}

function piazzaLoggedOut(text) {
  return /name=["']email["']|Log In to Piazza/i.test(String(text || '').slice(0, 8000));
}

async function collectPiazza(userId) {
  report(userId, { source: 'piazza', label: '正在读取 Piazza 资料列表', done: 0, total: 0 });
  const cookies = schoolCookies();
  const classPage = await requestText(SOURCES.piazza.url, cookies);
  if (piazzaLoggedOut(classPage.text)) throw loginRequired('请在刚打开的普通 Chrome 窗口里登录 Piazza，登录完成后会自动读取资料。');
  const user = embeddedJson(classPage.text, 'const USER = ');
  const classId = new URL(SOURCES.piazza.url).pathname.split('/').filter(Boolean).pop();
  const networks = Array.isArray(user?.networks) ? user.networks : [];
  const network = networks.find((item) => item.id === classId);
  if (!network?.school_ext || !network.term_key || !network.short_number) throw fail('Piazza 课程页里没有资料入口。', 409);
  const resourcesPage = await requestText(`https://piazza.com/${network.school_ext}/${network.term_key}/${network.short_number}/resources`, cookies);
  if (piazzaLoggedOut(resourcesPage.text)) throw loginRequired('请在刚打开的普通 Chrome 窗口里登录 Piazza，登录完成后会自动读取资料。');
  const resources = embeddedJson(resourcesPage.text, 'RESOURCES = ');
  if (!Array.isArray(resources) || !resources.length) throw fail('Piazza 资料页没有课件列表。', 409);
  const sectionTitle = { homework: 'Homework', homework_solutions: 'Homework', lecture_notes: 'Lecture Notes' };
  const html = resources.map((item) => {
    const title = sectionTitle[item.config?.section] || '资料';
    const name = String(item.subject || '课件').replace(/[<>&"]/g, '').slice(0, 240);
    return `<b class="ml-1">${title}</b><a href="/class_profile/get_resource/${network.id}/${item.id}">${name}</a>`;
  }).join('');
  const downloadList = resources.slice(0, 40);
  report(userId, { source: 'piazza', label: `正在下载课件 0/${downloadList.length}`, done: 0, total: downloadList.length });
  let downloaded = 0;
  const files = (await mapPool(downloadList, 4, async (item) => {
    const href = `https://piazza.com/class_profile/get_resource/${network.id}/${item.id}`;
    const response = await fetch(href, { headers: { 'User-Agent': USER_AGENT, Cookie: cookieHeader(cookies, href) }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    downloaded += 1;
    report(userId, { source: 'piazza', label: `正在下载课件 ${downloaded}/${downloadList.length}`, done: downloaded, total: downloadList.length });
    if (!response.ok) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 5).toString() !== '%PDF-') return null;
    const filename = String(item.subject || '课件').replace(/[\\/]/g, ' ').slice(0, 150);
    const section = item.config?.section || '';
    return {
      filename: filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`,
      bytes,
      course: sectionTitle[section] || 'Piazza',
      kind: /homework/.test(section) ? 'homework' : 'lecture',
    };
  })).filter(Boolean);
  report(userId, { source: 'piazza', label: `课件下载结束，共 ${files.length} 个`, done: downloadList.length, total: downloadList.length });
  return { source: 'piazza', html, files };
}

async function collectBlackboard(userId) {
  report(userId, { source: 'blackboard', label: '正在读取 Blackboard 课程', done: 0, total: 1 });
  const cookies = schoolCookies();
  const home = await requestText(SOURCES.blackboard.url, cookies, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
  if (isLoginDocument(home.url, home.text)) throw loginRequired('请在刚打开的普通 Chrome 窗口里登录 Blackboard，登录完成后会自动读取课程。');
  const list = await requestText('https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/execute/globalCourseNavMenuSection?cmd=view&serviceLevel=blackboard.data.course.Course$ServiceLevel:FULL', cookies, {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: SOURCES.blackboard.url },
  });
  const html = `${home.text}\n${list.text}`;
  const ids = [...html.matchAll(/course_id=(_\d+_\d+)/g)].map((match) => match[1]);
  const courseIds = [...new Set(ids)].slice(0, 12);
  report(userId, { source: 'blackboard', label: `正在读取 ${courseIds.length} 门课`, done: 0, total: courseIds.length || 1 });
  let finishedCourses = 0;
  const nested = await mapPool(courseIds, 3, async (id) => {
    let page;
    try {
      page = await requestText(`https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/execute/modulepage/view?course_id=${id}&mode=view`, cookies, { timeoutMs: 20000 });
    } catch {
      finishedCourses += 1;
      report(userId, { source: 'blackboard', label: `跳过超时课程 ${finishedCourses}/${courseIds.length}`, done: finishedCourses, total: courseIds.length });
      return [];
    }
    const course = (page.text.match(/<title>([^<]{1,80})/i)?.[1] || id).replace(/\s+/g, ' ').trim();
    const links = [...page.text.matchAll(/href="([^"]+(?:\.pdf(?:\?[^"]*)?|bbcswebdav[^"]*))"/gi)].map((match) => match[1]).slice(0, 8);
    const saved = (await mapPool(links, 4, async (link) => {
      const href = new URL(link, 'https://elearning.shanghaitech.edu.cn:8443').href;
      try {
        const response = await fetch(href, { headers: { 'User-Agent': USER_AGENT, Cookie: cookieHeader(cookies, href) }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
        if (!response.ok) return null;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.subarray(0, 5).toString() !== '%PDF-') return null;
        const filename = decodeURIComponent(href.split('/').pop().split('?')[0] || '课件.pdf');
        return { filename: filename.toLowerCase().endsWith('.pdf') ? filename : `${filename}.pdf`, bytes, course, kind: 'lecture' };
      } catch { return null; }
    })).filter(Boolean);
    finishedCourses += 1;
    report(userId, { source: 'blackboard', label: `已读取课程 ${finishedCourses}/${courseIds.length}`, done: finishedCourses, total: courseIds.length });
    return saved;
  });
  const files = nested.flat().slice(0, 40);
  return { source: 'blackboard', html, files };
}

const collectors = { graduate: collectGraduate, piazza: collectPiazza, blackboard: collectBlackboard };
const entryUrls = {
  graduate: GRADUATE_TIMETABLE,
  piazza: SOURCES.piazza.url,
  blackboard: SOURCES.blackboard.url,
};

/** Opens the user's normal Chrome, then fetches with the cookies already stored there. */
export async function collectCampus(userId, source) {
  if (!collectors[source]) throw fail('不支持的课程来源。');
  if (running.has(userId)) throw fail('正在采集，请等待当前同步结束。', 409);
  running.add(userId);
  try {
    try {
      return await collectors[source](userId);
    } catch (error) {
      if (!error.retry) throw error;
      openNormalChrome(entryUrls[source]);
      const deadline = Date.now() + 120000;
      let lastError = error;
      while (Date.now() < deadline) {
        await sleep(2000);
        cookieCache = null;
        try {
          return await collectors[source](userId);
        } catch (again) {
          lastError = again;
          if (!again.retry) throw again;
        }
      }
      throw lastError;
    }
  } finally {
    const current = progress.get(userId);
    if (current?.phase === 'running') report(userId, { phase: 'done', label: current.label || '同步结束' });
    running.delete(userId);
  }
}
