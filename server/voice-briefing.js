import { readSettings, readStore } from './store.js';
import { beijingDayStart, beijingLabel } from './briefing.js';
import { callJsonModel } from './model-json.js';

const DAY_MS = 86_400_000;
const BEIJING_OFFSET = 8 * 3_600_000;

function spokenClock(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms + BEIJING_OFFSET);
  const hour = date.getUTCHours();
  const minute = date.getUTCMinutes();
  const period = hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
  const hour12 = hour % 12 || 12;
  return minute ? `${period}${hour12}点${minute}分` : `${period}${hour12}点`;
}

export function collectSpokenEvents(stores, now, day) {
  const start = beijingDayStart(now) + (day === 'tomorrow' ? DAY_MS : 0);
  const end = start + DAY_MS;
  const seen = new Set();
  const events = [];
  for (const store of stores) {
    for (const event of store?.events || []) {
      if (!event || event.status === 'cancelled' || seen.has(event.id)) continue;
      const at = Date.parse(event.start);
      if (!Number.isFinite(at) || at < start || at >= end) continue;
      seen.add(event.id);
      events.push(event);
    }
  }
  events.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { start, label: beijingLabel(start), events };
}

export function spokenSchedule({ label, day, events }) {
  const which = day === 'tomorrow' ? '明天' : '今天';
  if (!events.length) return `${which}（${label}）没有日程安排。`;
  const lines = events.slice(0, 12).map((event) => {
    const when = event.allDay ? '全天' : spokenClock(event.start);
    const place = String(event.location || '').trim();
    return `${when}，${String(event.title || '未命名日程').trim()}${place ? `，地点${place}` : ''}`;
  });
  const extra = events.length > 12 ? `另外还有${events.length - 12}项，打开日历可以看全。` : '';
  return `${which}（${label}）一共${events.length}项安排。${lines.join('。')}。${extra}`.replace(/。+/g, '。').trim();
}

export async function buildVoiceBriefing({
  day = 'today',
  now = Date.now(),
  settings = readSettings(),
  stores = null,
} = {}) {
  const scope = day === 'tomorrow' ? 'tomorrow' : 'today';
  const mailboxStores = stores || (settings.mailboxes || []).map((mailbox) => readStore(mailbox.id));
  const collected = collectSpokenEvents(mailboxStores.length ? mailboxStores : [readStore(settings.activeMailboxId)], now, scope);
  const fallback = spokenSchedule({ label: collected.label, day: scope, events: collected.events });
  if (!settings?.apiKey || !settings?.baseUrl || !settings?.model) {
    return { text: fallback, source: 'schedule', count: collected.events.length, day: scope };
  }
  try {
    const facts = collected.events.slice(0, 20).map((event) => ({
      title: event.title, start: event.start, allDay: Boolean(event.allDay), location: event.location || '',
    }));
    const result = await callJsonModel(settings, [
      { role: 'system', content: '你是日程播报员。只根据给定日程写一段给语音合成朗读的中文口播，不要 Markdown，不要编造没有的会议、地点或时间。没有日程就明确说没有安排。返回 JSON {"script":"口播稿"}，120到320个字。' },
      { role: 'user', content: JSON.stringify({ day: scope === 'tomorrow' ? '明天' : '今天', date: collected.label, events: facts }) },
    ], { label: '日程语音播报', timeoutMs: 25000 });
    const script = String(result?.script || '').replace(/\s+/g, ' ').trim();
    if (!script) return { text: fallback, source: 'schedule', count: collected.events.length, day: scope };
    return { text: script.slice(0, 800), source: 'model', count: collected.events.length, day: scope };
  } catch {
    return { text: fallback, source: 'schedule', count: collected.events.length, day: scope };
  }
}
