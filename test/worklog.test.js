import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { buildDays, dayStats, cleanTitle, clockTime, dayKey, longDate } from '../src/worklog.js';

const config = parseConfig({ title: 'Work', author: 'dev', repos: ['acme/web', { repo: 'acme/api', name: 'API' }] });

const item = (repo, time, title, extra = {}) => ({
  kind: 'pr',
  repo,
  id: '#1',
  title,
  url: 'https://example.com',
  time,
  workTimes: [],
  ...extra,
});

test('cleanTitle turns commit-style titles into plain English', () => {
  assert.equal(cleanTitle('fix(calc): stop adding duplicate rows to the invoice (#12)'), 'Stop adding duplicate rows to the invoice');
  assert.equal(cleanTitle('feat!: new login'), 'New login');
  assert.equal(cleanTitle('Use 4 retries instead of 1.'), 'Use 4 retries instead of 1');
  assert.equal(cleanTitle('Wait for it...'), 'Wait for it...');
  assert.equal(cleanTitle('half way through step 6'), 'Half way through step 6');
  assert.equal(cleanTitle('fix: '), 'fix:');
  assert.equal(cleanTitle('Fixture loader'), 'Fixture loader');
});

test('days and times follow the configured time zone, including summer time', () => {
  // 23:30 UTC in June is 00:30 the next day in London.
  assert.equal(dayKey('2026-06-01T23:30:00Z', 'Europe/London'), '2026-06-02');
  assert.equal(clockTime('2026-06-01T23:30:00Z', 'Europe/London'), '00:30');
  // In January London is on UTC.
  assert.equal(dayKey('2026-01-01T23:30:00Z', 'Europe/London'), '2026-01-01');
  assert.equal(clockTime('2026-01-01T23:30:00Z', 'Europe/London'), '23:30');
  assert.equal(dayKey('2026-01-01T23:30:00Z', 'America/New_York'), '2026-01-01');
  assert.equal(longDate('2026-09-25'), 'Friday 25 September 2026');
  assert.equal(longDate(new Date('2026-06-01T23:30:00Z'), 'Europe/London'), 'Tuesday 2 June 2026');
});

test('groups items into days newest first, repos in config order, items oldest first', () => {
  const days = buildDays(
    [
      item('acme/api', '2026-09-24T09:00:00Z', 'fix: api later'),
      item('acme/web', '2026-09-24T10:00:00Z', 'Web thing'),
      item('acme/api', '2026-09-24T08:00:00Z', 'Api first'),
      item('acme/web', '2026-09-25T12:00:00Z', 'Newest day'),
    ],
    config,
  );
  assert.deepEqual(
    days.map((day) => day.date),
    ['2026-09-25', '2026-09-24'],
  );
  const [, older] = days;
  assert.equal(older.label, 'Thursday 24 September 2026');
  assert.deepEqual(
    older.groups.map((group) => [group.label, group.items.map((i) => i.title)]),
    [
      ['Web', ['Web thing']],
      ['API', ['Api first', 'Api later']],
    ],
  );
  assert.equal(older.firstActivity, '09:00');
  assert.equal(older.lastActivity, '11:00');
});

test('commits inside a pull request widen that day\'s activity times, but never add a day', () => {
  const days = buildDays(
    [
      item('acme/web', '2026-09-24T15:00:00Z', 'Merged', {
        workTimes: ['2026-09-24T07:15:00Z', '2026-09-23T20:00:00Z', '2026-09-24T16:45:00Z'],
      }),
    ],
    config,
  );
  assert.equal(days.length, 1);
  assert.equal(days[0].firstActivity, '08:15');
  assert.equal(days[0].lastActivity, '17:45');
});

test('drops anything before "since"', () => {
  const days = buildDays(
    [item('acme/web', '2026-08-31T22:59:00Z', 'Old'), item('acme/web', '2026-08-31T23:01:00Z', 'New')],
    { ...config, since: '2026-09-01' },
  );
  assert.deepEqual(
    days.map((day) => day.groups[0].items.map((i) => i.title)),
    [['New']],
  );
});

test('each day counts its tasks and totals the lines added and removed', () => {
  const days = buildDays(
    [
      item('acme/web', '2026-09-24T09:00:00Z', 'A', { additions: 1200, deletions: 40 }),
      item('acme/api', '2026-09-24T10:00:00Z', 'B', { kind: 'commit', additions: 34, deletions: 527 }),
      item('acme/web', '2026-09-25T10:00:00Z', 'C', { additions: 5, deletions: 0 }),
    ],
    config,
  );
  assert.deepEqual(
    days.map(({ date, tasks, additions, deletions }) => ({ date, tasks, additions, deletions })),
    [
      { date: '2026-09-25', tasks: 1, additions: 5, deletions: 0 },
      { date: '2026-09-24', tasks: 2, additions: 1234, deletions: 567 },
    ],
  );
  assert.deepEqual(dayStats([{}]), { tasks: 1, additions: 0, deletions: 0 });
});

test('other work joins its day and counts as a task, and can make a day of its own', () => {
  const activity = (date, text, kind = 'planning') => ({ date, project: 'Web', kind, text });
  const days = buildDays(
    [item('acme/web', '2026-09-24T09:00:00Z', 'A', { additions: 10, deletions: 2 })],
    { ...config, since: '2026-09-01' },
    [
      activity('2026-09-24', 'planning the next stages'),
      activity('2026-09-26', 'test calls', 'testing'),
      activity('2026-09-24', 'switched on the help page', 'setting-up'),
      activity('2026-08-31', 'too early'),
    ],
  );
  assert.deepEqual(
    days.map(({ date, tasks, additions, firstActivity, activities }) => ({
      date,
      tasks,
      additions,
      firstActivity,
      activities: activities.map((a) => `${a.label}: ${a.text}`),
    })),
    [
      { date: '2026-09-26', tasks: 1, additions: 0, firstActivity: null, activities: ['Testing: test calls'] },
      {
        date: '2026-09-24',
        tasks: 3,
        additions: 10,
        firstActivity: '10:00',
        activities: ['Planning: planning the next stages', 'Setting up: switched on the help page'],
      },
    ],
  );
  assert.equal(days[0].label, 'Saturday 26 September 2026');
  assert.deepEqual(days[0].groups, []);
});
