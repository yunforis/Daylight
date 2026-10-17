import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSpokenEvents, spokenSchedule } from './voice-briefing.js';

const now = Date.parse('2026-10-18T01:00:00+08:00');

test('语音播报只收录当天未取消的日程，并写成可朗读的句子', () => {
  const stores = [{
    events: [
      { id: 'a', title: '算法课', start: '2026-10-18T10:15:00+08:00', location: '教学中心201', status: 'confirmed' },
      { id: 'b', title: '已取消研讨', start: '2026-10-18T14:00:00+08:00', status: 'cancelled' },
      { id: 'a', title: '算法课', start: '2026-10-18T10:15:00+08:00' },
      { id: 'c', title: '明天实验', start: '2026-10-19T09:00:00+08:00', allDay: false },
    ],
  }];
  const today = collectSpokenEvents(stores, now, 'today');
  assert.deepEqual(today.events.map((event) => event.id), ['a']);
  assert.match(spokenSchedule({ label: today.label, day: 'today', events: today.events }), /今天/);
  assert.match(spokenSchedule({ label: today.label, day: 'today', events: today.events }), /上午10点15分，算法课，地点教学中心201/);
  assert.equal(spokenSchedule({ label: today.label, day: 'today', events: today.events }).includes('已取消'), false);
  const tomorrow = collectSpokenEvents(stores, now, 'tomorrow');
  assert.equal(tomorrow.events[0].id, 'c');
  assert.match(spokenSchedule({ label: tomorrow.label, day: 'tomorrow', events: [] }), /明天.*没有日程/);
});
