import { SOURCES, clean, fail } from './domain.js';

export function currentGraduateTerm(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  if (month >= 8) return `${year}1`;
  if (month <= 1) return `${year - 1}1`;
  return `${month <= 7 ? year - 1 : year}2`;
}

export function graduateRows(payload) {
  const rows = payload?.datas?.xsjxrwcx?.rows || payload?.xsjxrwcx?.rows || payload?.rows || payload;
  if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw fail('课表接口没有可读取的课程。');
  return rows;
}

/** Map the graduate `xsjxrwcx` JSON into the deterministic timetable table. */
export function graduateRowsToTable(rows) {
  const table = [['课程代码', '课程名称', '班级名称', '首次上课日期', '上课时间地点']];
  for (const row of rows) {
    const code = clean(row.KCDM, 40);
    const title = clean(row.KCMC, 200);
    const when = clean(row.PKSJDD || row.PKSJ, 2000);
    const first = clean(row.SCSKRQ, 20);
    if (!code || !title || !when) continue;
    table.push([code, title, clean(row.BJMC, 200), first, when]);
  }
  if (table.length < 2) throw fail('课表接口没有可读取的课程。');
  return table;
}

export function graduateSnapshot(payload) {
  const table = graduateRowsToTable(graduateRows(payload));
  const text = table.slice(1).map((row) => `${row[1]} ${row[2]} ${row[4]}`).join('\n');
  return {
    source: 'graduate',
    pages: [{
      url: SOURCES.graduate.url,
      title: '研究生课表',
      text,
      tables: [table],
    }],
  };
}

function sectionChunks(html) {
  const parts = String(html || '').split(/<b class="ml-1">/i);
  const chunks = [];
  for (const part of parts.slice(1)) {
    const title = clean(part.split('<')[0], 120);
    if (title) chunks.push({ title, html: part });
  }
  return chunks.length ? chunks : [{ title: '资料', html: String(html || '') }];
}

export function parsePiazzaResources(html) {
  const source = String(html || '');
  if (!source.trim()) throw fail('没有 Piazza 页面内容。');
  if (source.length > 2_000_000) throw fail('Piazza 页面过大。');
  const resources = [];
  for (const chunk of sectionChunks(source)) {
    const link = /href="(\/class_profile\/get_resource\/[a-z0-9]+\/[a-z0-9]+)"[\s\S]{0,500}?>([^<]{1,240})</gi;
    let match;
    while ((match = link.exec(chunk.html))) {
      const name = clean(match[2], 240);
      if (!name) continue;
      const after = chunk.html.slice(match.index, match.index + 1200);
      const date = clean(/date-student[^>]*>([^<]{1,40})</i.exec(after)?.[1], 40);
      resources.push({
        name,
        href: match[1],
        url: `https://piazza.com${match[1]}`,
        section: chunk.title,
        date,
        kind: /homework|作业|assignment/i.test(chunk.title) ? 'homework' : /通知|announce/i.test(chunk.title) ? 'notice' : 'lecture',
      });
    }
  }
  if (!resources.length) throw fail('这个 Piazza 页面里没有课件或作业链接，请打开 Resources 页后再导入。');
  return resources.slice(0, 300);
}

export function piazzaSnapshot(html, { skipTitles = [] } = {}) {
  const skip = new Set(skipTitles.map((title) => clean(title, 240).toLowerCase()).filter(Boolean));
  const resources = parsePiazzaResources(html).filter((item) => item.kind !== 'notice' || !skip.has(item.name.toLowerCase()));
  if (!resources.length) throw fail('通知都已在邮箱里出现，没有新的 Piazza 资料。');
  const bySection = new Map();
  for (const item of resources) {
    const list = bySection.get(item.section) || [];
    list.push(item);
    bySection.set(item.section, list);
  }
  const pages = [...bySection.entries()].map(([section, items]) => ({
    url: `${SOURCES.piazza.url}#${encodeURIComponent(section)}`,
    title: `Piazza · ${section}`,
    text: items.map((item) => `${item.name} ${item.date} ${item.url}`).join('\n'),
    tables: [],
  }));
  return { source: 'piazza', resources, pages };
}

export function parseBlackboardCourses(html) {
  const source = String(html || '');
  if (!source.trim()) throw fail('没有 Blackboard 课程列表。');
  if (source.length > 2_000_000) throw fail('Blackboard 页面过大。');
  const courses = [];
  const seen = new Set();
  const patterns = [
    /course_id=(_\d+_\d+)[^"'<]{0,160}[^>]*>([^<]{1,160})</gi,
    /href="([^"]*course_id=(_\d+_\d+)[^"]*)"[^>]*>([^<]{1,160})</gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const id = match[2] && match[1].startsWith('http') ? match[2] : match[1];
      const title = clean(match[2] && match[1].startsWith('http') ? match[3] : match[2], 160);
      const href = match[1].startsWith('http') || match[1].startsWith('/') ? match[1] : '';
      if (!/^_\d+_\d+$/.test(id) || !title || seen.has(id)) continue;
      seen.add(id);
      courses.push({
        id,
        title,
        url: href.startsWith('http') ? href : `https://elearning.shanghaitech.edu.cn:8443/webapps/blackboard/execute/modulepage/view?course_id=${id}&mode=view`,
      });
    }
  }
  if (!courses.length) throw fail('没有解析到 Blackboard 课程，请在已登录的课程列表页导入。');
  return courses.slice(0, 80);
}

export function blackboardSnapshot(html) {
  const courses = parseBlackboardCourses(html);
  return {
    source: 'blackboard',
    courses,
    pages: courses.map((course) => ({
      url: course.url,
      title: course.title,
      text: `${course.title}\n${course.url}`,
      tables: [],
    })),
  };
}
