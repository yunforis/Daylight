import { createHash, randomUUID } from 'node:crypto';
export const SOURCES = {
  graduate: { title: '研究生课表', url: 'https://graduate.shanghaitech.edu.cn/gsapp/sys/yjsemaphome/portal/index.do', origin: 'https://graduate.shanghaitech.edu.cn' },
  blackboard: { title: 'Blackboard', url: 'https://elearning.shanghaitech.edu.cn:8443/webapps/portal/execute/tabs/tabAction?tab_tab_group_id=_1_1', origin: 'https://elearning.shanghaitech.edu.cn:8443' },
  piazza: { title: 'Piazza', url: 'https://piazza.com/class/mtgoeh6v4cf3xb', origin: 'https://piazza.com' },
};
export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const digest = value => createHash('sha256').update(String(value)).digest('hex');
export const clean = (v, max = 1000) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, max);
export const emptyCampus = () => ({ projects: [], runs: [] });
export function projectOf(data, id) {
  const p = data.projects.find(p => p.id === id && !p.archived);
  if (!p) throw fail('学习项目不存在。', 404);
  return p;
}
export function newProject(input = {}) {
  const title = clean(input.title, 100);
  if (!title) throw fail('请填写项目名称。');
  return { id: randomUUID(), title, createdAt: new Date().toISOString(), documents: [], pages: [], schedule: [], assignments: [], conversations: [], sources: {} };
}
export function sourceUrl(source, value) {
  if (!SOURCES[source]) throw fail('不支持的课程来源。');
  const u = new URL(value || SOURCES[source].url);
  if (u.origin !== SOURCES[source].origin || u.username || u.password) throw fail('课程链接不属于所选平台。');
  for (const key of ['_yhz','v','ticket','token']) u.searchParams.delete(key); return u.href;
}
export function mergeSnapshot(project, input, now = new Date().toISOString()) {
  const source = input.source;
  if (!SOURCES[source]) throw fail('不支持的课程来源。');
  if (!Array.isArray(input.pages) || !input.pages.length || input.pages.length > 300) throw fail('没有可读取的课程页面，可能需要重新登录。');
  const pages = input.pages.map(p => {
    const url = sourceUrl(source, p.url), text = clean(p.text, 100000);
    if (!text || /统一身份认证|Unified identity authentication/i.test(p.title || '') || /\/authserver\/|\/login(?:\/|\?|$)/i.test(url)) throw fail('登录已过期，请在官方页面重新登录。', 409);
    return { id: digest(`${source}:${url}`), source, url, title: clean(p.title, 200), text, tables: (Array.isArray(p.tables) ? p.tables : []).slice(0,12).map(t => t.slice(0,200).map(r => r.slice(0,30).map(c => clean(c,3000)))), hash: digest(text), fetchedAt: now };
  });
  let changed = 0;
  for (const page of pages) {
    const idx = project.pages.findIndex(p => p.id === page.id);
    if (idx < 0) { project.pages.push({ ...page, version: 1 }); changed++; }
    else {
      const old = project.pages[idx];
      if (old.hash !== page.hash) changed++;
      project.pages[idx] = { ...page, version: (old.version || 1) + (old.hash !== page.hash ? 1 : 0) };
    }
  }
  // A partial crawl NEVER implies deleted courses or cancelled lessons.
  project.sources[source] = { lastSuccessAt: now, pageCount: pages.length, changed, status: input.partial ? 'partial' : 'synced', note: clean(input.note, 300) };
  project.updatedAt = now;
  return { changed, pages: pages.length, status: project.sources[source].status };
}
export function validateSchedule(rows) {
  if (!Array.isArray(rows) || rows.length > 1000) throw fail('课表条数无效。');
  return rows.map(row => {
    const id = clean(row.id, 150), title = clean(row.title, 200), start = clean(row.start, 40), end = clean(row.end, 40);
    if (!id || !title || !/(?:[Zz]|[+-]\d\d:\d\d)$/.test(start) || !/(?:[Zz]|[+-]\d\d:\d\d)$/.test(end) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start)) throw fail('每节课需要稳定编号、名称和带时区的有效起止时间。');
    return { id, title, start: new Date(start).toISOString(), end: new Date(end).toISOString(), location: clean(row.location, 300), status: row.status === 'cancelled' ? 'cancelled' : 'active', sourceUrl: clean(row.sourceUrl, 1500) };
  });
}
export function scheduleConflicts(projectId, rows, events) {
  return rows.flatMap(row => (events || []).filter(e => e.status !== 'cancelled' && !(e.campusProjectId === projectId && e.campusSourceId === row.id) && Date.parse(e.start) < Date.parse(row.end) && Date.parse(e.end) > Date.parse(row.start)).map(e => ({lessonId:row.id,title:row.title,start:row.start,otherTitle:e.title,otherStart:e.start}))).slice(0,100);
}
export function validateAssignments(rows, pages) {
  const known=new Set(pages.map(p=>p.url));
  return (Array.isArray(rows)?rows:[]).slice(0,200).map(a=>{
    const title=clean(a.title,200), dueAt=clean(a.dueAt,40), sourceUrl=clean(a.sourceUrl,1500);
    if(!title||!known.has(sourceUrl)||!/(?:Z|[+-]\d\d:\d\d)$/.test(dueAt)||!Number.isFinite(Date.parse(dueAt)))throw fail('作业缺少可核对的来源或截止时间，请查看课程原文。');
    // Due-date changes update the same assignment instead of creating another task.
    return {id:digest(`${sourceUrl}:${title.normalize('NFKC').toLowerCase()}`).slice(0,32),title,dueAt,sourceUrl};
  });
}
export function renameProject(project, title) {
  const next = clean(title, 100);
  if (!next) throw fail('请填写文件夹名称。');
  project.title = next;
  project.updatedAt = new Date().toISOString();
  return project;
}
function courseTerms(query) {
  const text = clean(query, 1000).toLowerCase();
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  const words = [...segmenter.segment(text)].filter(s => s.isWordLike).map(s => s.segment).filter(s => s.length >= 2 || /[a-z0-9]/i.test(s));
  const grams = [];
  const compact = text.replace(/\s+/g, '');
  if (/[\u4e00-\u9fff]/.test(compact)) for (let i = 0; i < compact.length - 1 && grams.length < 24; i++) grams.push(compact.slice(i, i + 2));
  return [...new Set([...words, ...grams])].slice(0, 32);
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
/** Keyword ranking, optionally fused with stored embeddings. Scope never crosses folders or documents. */
export function searchChunks(project, query, limit = 8, options = {}) {
  const terms = courseTerms(query);
  const allow = Array.isArray(options.documentIds) && options.documentIds.length ? new Set(options.documentIds) : null;
  const documents = (project.documents || []).filter(d => !allow || allow.has(d.id));
  const chunks = documents.flatMap(d => (d.chunks || []).map(c => ({ ...c, documentId: d.id, filename: d.filename, source: d.source || '' })));
  if (!allow) chunks.push(...(project.pages || []).flatMap(p => {
    const rows = [];
    for (let i = 0; i < (p.text || '').length; i += 620) rows.push({ content: p.text.slice(i, i + 700), page: 1, documentId: p.id, filename: p.title, sourceUrl: p.url, source: p.source });
    return rows;
  }));
  const queryVector = options.queryVector;
  const ranked = chunks.map(c => {
    const text = String(c.content || '').toLowerCase();
    const keyword = terms.reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0) / (terms.length || 1);
    const vector = queryVector ? cosine(queryVector, c.embedding) : 0;
    return { ...c, keyword, vector };
  }).filter(c => c.keyword > 0 || c.vector > 0.05);
  const fuse = rows => { const score = new Map(); rows.forEach((row, index) => score.set(row, (score.get(row) || 0) + 1 / (60 + index + 1))); return score; };
  const keywordRank = fuse([...ranked].filter(c => c.keyword > 0).sort((a, b) => b.keyword - a.keyword));
  const vectorRank = queryVector ? fuse([...ranked].filter(c => c.vector > 0.05).sort((a, b) => b.vector - a.vector)) : new Map();
  return ranked.map(c => ({ ...c, score: (keywordRank.get(c) || 0) + (vectorRank.get(c) || 0) }))
    .filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
    .map(({ embedding, ...c }, i) => ({ ...c, citation: i + 1 }));
}
