import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { buildDays, dayStats, cleanTitle, clockTime, dayKey, longDate, projectIndex, unmatchedProjects, workDayKey } from '../src/worklog.js';

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

const split = parseConfig({
  title: 'Work',
  author: 'dev',
  repos: [
    {
      repo: 'acme/web',
      name: 'Web',
      projects: [
        { name: 'Billing', paths: ['billing/**', 'docs/billing.md'] },
        { name: 'Help', paths: ['help/**', 'docs/**'] },
      ],
      sharedPaths: ['AGENTS.md', '**/package.json'],
    },
    { repo: 'acme/api', name: 'API' },
  ],
});

test('a change joins the first project whose paths cover all its files, leaving out shared files', () => {
  const [web, api] = split.repos;
  assert.equal(projectIndex(web, ['billing/a.ts', 'docs/billing.md']), 1);
  assert.equal(projectIndex(web, ['billing/a.ts', 'AGENTS.md', 'billing/package.json']), 1);
  assert.equal(projectIndex(web, ['docs/billing.md']), 1);
  assert.equal(projectIndex(web, ['docs/help.md', 'help/b.ts']), 2);
  assert.equal(projectIndex(web, ['billing/a.ts', 'help/b.ts']), 0);
  assert.equal(projectIndex(web, ['billing/a.ts', 'src/app.ts']), 0);
  assert.equal(projectIndex(web, ['AGENTS.md', 'package.json']), 0);
  assert.equal(projectIndex(web, []), 0);
  assert.equal(projectIndex(web, undefined), 0);
  assert.equal(projectIndex(api, ['billing/a.ts']), 0);
});

const byBranch = parseConfig({
  title: 'Work',
  author: 'dev',
  repos: [
    {
      repo: 'acme/web',
      name: 'Web',
      projects: [
        { name: 'Billing', paths: ['billing/**'], branches: ['fm/billing-*'] },
        { name: 'Help', branches: ['fm/help-*'] },
      ],
      sharedPaths: ['AGENTS.md'],
    },
  ],
});

test('a pull request from a matching branch joins that project whatever files it changed', () => {
  const [web] = byBranch.repos;
  assert.equal(projectIndex(web, ['billing/a.ts', 'src/app.ts', 'help/b.ts'], 'fm/billing-refunds'), 1);
  assert.equal(projectIndex(web, ['billing/a.ts'], 'fm/help-faq'), 2);
  assert.equal(projectIndex(web, ['AGENTS.md'], 'fm/help-faq'), 2);
  assert.equal(projectIndex(web, undefined, 'fm/help-faq'), 2);
});

test('without a matching branch a change falls back to its files', () => {
  const [web] = byBranch.repos;
  assert.equal(projectIndex(web, ['billing/a.ts'], 'fm/web-tidy'), 1);
  assert.equal(projectIndex(web, ['billing/a.ts', 'src/app.ts'], 'fm/web-tidy'), 0);
  assert.equal(projectIndex(web, ['billing/a.ts']), 1);
  // A project with only branches never takes a change by its files.
  assert.equal(projectIndex(web, ['help/b.ts'], 'fm/web-tidy'), 0);
  assert.equal(projectIndex(web, ['src/app.ts'], 'fm/billing'), 0);
  assert.equal(projectIndex(split.repos[0], ['billing/a.ts', 'src/app.ts'], 'fm/billing-refunds'), 0);
});

test('projects show as their own groups, after their repo and before the next repo', () => {
  const days = buildDays(
    [
      item('acme/api', '2026-09-24T08:00:00Z', 'Api'),
      item('acme/web', '2026-09-24T09:00:00Z', 'Help page', { files: ['help/b.ts'] }),
      item('acme/web', '2026-09-24T10:00:00Z', 'Invoices', { files: ['billing/a.ts', 'AGENTS.md'] }),
      item('acme/web', '2026-09-24T11:00:00Z', 'Everything', { files: ['billing/a.ts', 'src/app.ts'] }),
      item('acme/web', '2026-09-24T12:00:00Z', 'Refunds', { files: ['billing/b.ts'] }),
    ],
    split,
  );
  assert.deepEqual(
    days[0].groups.map((group) => [group.repo, group.label, group.items.map((i) => i.title)]),
    [
      ['acme/web', 'Web', ['Everything']],
      ['acme/web', 'Billing', ['Invoices', 'Refunds']],
      ['acme/web', 'Help', ['Help page']],
      ['acme/api', 'API', ['Api']],
    ],
  );
  assert.equal(days[0].tasks, 5);
  assert.ok(days[0].groups.every((group) => group.items.every((i) => !('files' in i))));
});

test('pull requests show under the project their branch names, and the branch is not shown', () => {
  const days = buildDays(
    [
      item('acme/web', '2026-09-24T09:00:00Z', 'Refunds email', { files: ['billing/a.ts', 'src/email.ts'], branch: 'fm/billing-email' }),
      item('acme/web', '2026-09-24T10:00:00Z', 'Tidy', { files: ['billing/a.ts', 'src/email.ts'], branch: 'fm/web-tidy' }),
    ],
    byBranch,
  );
  assert.deepEqual(
    days[0].groups.map((group) => [group.label, group.items.map((i) => i.title)]),
    [
      ['Web', ['Tidy']],
      ['Billing', ['Refunds email']],
    ],
  );
  assert.ok(days[0].groups.every((group) => group.items.every((i) => !('branch' in i))));
});

test('other work joins the group of its project, after its changes, in a section for each kind in a set order', () => {
  const activity = (project, kind, text, start) => ({ date: '2026-09-24', project, kind, text, ...(start && { start }) });
  const days = buildDays(
    [item('acme/web', '2026-09-24T09:00:00Z', 'A'), item('acme/api', '2026-09-24T10:00:00Z', 'B')],
    config,
    [
      activity('Hiring', 'other', 'interviewed a developer'),
      activity('api', 'testing', 'untimed test round'),
      activity('API', 'testing', 'afternoon test round', '2026-09-24T15:00:00+01:00'),
      activity('Web', 'other', 'wrote a guide'),
      activity('API', 'planning', 'planned the next stage', '2026-09-24T08:00:00+01:00'),
      activity('API', 'testing', 'morning test round', '2026-09-24T09:30:00+01:00'),
      activity('Docs', 'reviewing', 'read the drafts'),
      activity('API', 'setting-up', 'switched on the keys', '2026-09-24T11:00:00+01:00'),
      activity('API', 'reviewing', 'went through the bug reports', '2026-09-24T10:00:00+01:00'),
    ],
  );
  assert.deepEqual(
    days[0].groups.map((group) => [
      group.repo,
      group.label,
      group.items.map((i) => i.title),
      group.other.map((kind) => [kind.label, kind.entries.map((e) => e.text)]),
    ]),
    [
      ['acme/web', 'Web', ['A'], [['Other', ['Wrote a guide']]]],
      [
        'acme/api',
        'API',
        ['B'],
        [
          ['Planning', ['Planned the next stage']],
          ['Reviewing', ['Went through the bug reports']],
          // Timed entries in time order, then untimed ones in the order of the file.
          ['Testing', ['Morning test round', 'Afternoon test round', 'Untimed test round']],
          ['Setting up', ['Switched on the keys']],
        ],
      ],
      // Projects with no repo of their name follow, in the order of the file.
      [null, 'Hiring', [], [['Other', ['Interviewed a developer']]]],
      [null, 'Docs', [], [['Reviewing', ['Read the drafts']]]],
    ],
  );
  assert.equal(days[0].tasks, 11);
  const projects = (...names) => names.map((project) => ({ project }));
  assert.deepEqual(unmatchedProjects(projects('Hiring', 'web', 'API', 'Docs', 'hiring'), config), ['Hiring', 'Docs']);
});

test('other work keeps its start and end clock times in the configured time zone', () => {
  const days = buildDays([], config, [
    { date: '2026-09-24', project: 'Web', kind: 'testing', text: 'both', start: '2026-09-24T13:00:00Z', end: '2026-09-24T13:45:00Z' },
    { date: '2026-09-24', project: 'Web', kind: 'testing', text: 'end only', end: '2026-09-24T16:00:00Z' },
  ]);
  assert.deepEqual(days[0].groups[0].other[0].entries, [
    { text: 'Both', start: '14:00', end: '14:45' },
    { text: 'End only', start: null, end: '17:00' },
  ]);
});

test('a project within a repo gets its own other work, beside the repo and its changes', () => {
  const activity = (project, kind, text) => ({ date: '2026-09-24', project, kind, text });
  const days = buildDays(
    [
      item('acme/web', '2026-09-24T09:00:00Z', 'Help page', { files: ['help/b.ts'] }),
      item('acme/web', '2026-09-24T10:00:00Z', 'Everything', { files: ['src/app.ts'] }),
    ],
    split,
    [
      activity('Billing', 'reviewing', 'went through the refund requests'),
      activity('Help', 'testing', 'tried every help link'),
      activity('Web', 'planning', 'planned the new menu'),
      activity('API', 'setting-up', 'switched on the keys'),
    ],
  );
  assert.deepEqual(
    days[0].groups.map((group) => [group.repo, group.label, group.items.map((i) => i.title), group.other.map((kind) => kind.label)]),
    [
      ['acme/web', 'Web', ['Everything'], ['Planning']],
      // A project with only other work that day still has its place after its repo.
      ['acme/web', 'Billing', [], ['Reviewing']],
      ['acme/web', 'Help', ['Help page'], ['Testing']],
      ['acme/api', 'API', [], ['Setting up']],
    ],
  );
  assert.deepEqual(unmatchedProjects([activity('billing', 'other', 'x'), activity('Shop', 'other', 'y')], split), ['Shop']);
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
  const other = (day) => day.groups.flatMap((group) => group.other.flatMap((kind) => kind.entries.map((e) => `${kind.label}: ${e.text}`)));
  assert.deepEqual(
    days.map((day) => ({ date: day.date, tasks: day.tasks, additions: day.additions, firstActivity: day.firstActivity, other: other(day) })),
    [
      { date: '2026-09-26', tasks: 1, additions: 0, firstActivity: null, other: ['Testing: Test calls'] },
      {
        date: '2026-09-24',
        tasks: 3,
        additions: 10,
        firstActivity: '10:00',
        other: ['Planning: Planning the next stages', 'Setting up: Switched on the help page'],
      },
    ],
  );
  assert.equal(days[0].label, 'Saturday 26 September 2026');
  assert.equal(days[0].lastActivity, null);
  assert.deepEqual(days[0].groups.map((group) => [group.label, group.items]), [['Web', []]]);
});

test('the start and end times of other work count towards the day\'s activity times', () => {
  const activity = (date, extra) => ({ date, project: 'Web', kind: 'testing', text: 'test calls', ...extra });
  const days = buildDays(
    [item('acme/web', '2026-09-24T12:00:00Z', 'A')],
    config,
    [
      activity('2026-09-24', { start: '2026-09-24T07:15:00Z', end: '2026-09-24T08:00:00Z' }),
      activity('2026-09-24', { end: '2026-09-24T16:40:00Z' }),
      activity('2026-09-24', {}),
      // Past midnight in London, so it does not stretch the 24th.
      activity('2026-09-24', { end: '2026-09-24T23:30:00Z' }),
      activity('2026-09-26', { start: '2026-09-26T09:00:00+01:00' }),
      activity('2026-09-27', {}),
    ],
  );
  assert.deepEqual(
    days.map(({ date, tasks, firstActivity, lastActivity }) => ({ date, tasks, firstActivity, lastActivity })),
    [
      { date: '2026-09-27', tasks: 1, firstActivity: null, lastActivity: null },
      { date: '2026-09-26', tasks: 1, firstActivity: '09:00', lastActivity: '09:00' },
      { date: '2026-09-24', tasks: 5, firstActivity: '08:15', lastActivity: '17:40' },
    ],
  );
});

test('a work day can start later than midnight, so times before then belong to the day before', () => {
  // 00:30 on 9 October in London (summer time) is 23:30 UTC on the 8th.
  assert.equal(workDayKey('2026-10-08T23:30:00Z', 'Europe/London'), '2026-10-09');
  assert.equal(workDayKey('2026-10-08T23:30:00Z', 'Europe/London', '06:00'), '2026-10-08');
  assert.equal(workDayKey('2026-10-09T04:59:00Z', 'Europe/London', '06:00'), '2026-10-08');
  assert.equal(workDayKey('2026-10-09T05:00:00Z', 'Europe/London', '06:00'), '2026-10-09');
  // Across the end of a month and a year.
  assert.equal(workDayKey('2026-11-01T01:00:00Z', 'Europe/London', '06:00'), '2026-10-31');
  assert.equal(workDayKey('2027-01-01T02:00:00Z', 'Europe/London', '06:00'), '2026-12-31');
});

test('with "dayStartsAt", changes, commits and other work past midnight stay with the day they began', () => {
  const late = { ...config, dayStartsAt: '06:00' };
  const activity = (date, extra) => ({ date, project: 'Web', kind: 'testing', text: 'test round', ...extra });
  const days = buildDays(
    [
      item('acme/web', '2026-10-08T09:00:00Z', 'Morning'),
      // Merged at 00:40 on the 9th in London, with a commit at 00:20.
      item('acme/web', '2026-10-08T23:40:00Z', 'After midnight', { workTimes: ['2026-10-08T23:20:00Z'] }),
      // 06:00 on the 9th starts the next work day.
      item('acme/web', '2026-10-09T05:00:00Z', 'Next morning'),
    ],
    late,
    [
      activity('2026-10-08', { start: '2026-10-08T22:30:00+01:00', end: '2026-10-09T01:40:00+01:00' }),
      // Dated the 9th but at 02:00 that night, which is the 8th's work day.
      activity('2026-10-09', { start: '2026-10-09T02:00:00+01:00' }),
    ],
  );
  assert.deepEqual(
    days.map(({ date, tasks, firstActivity, lastActivity, groups }) => ({
      date,
      tasks,
      firstActivity,
      lastActivity,
      titles: groups.flatMap((group) => group.items.map((i) => i.title)),
    })),
    [
      { date: '2026-10-09', tasks: 2, firstActivity: '06:00', lastActivity: '06:00', titles: ['Next morning'] },
      { date: '2026-10-08', tasks: 3, firstActivity: '10:00', lastActivity: '01:40', titles: ['Morning', 'After midnight'] },
    ],
  );
  // Without it, each change stays on its calendar day.
  assert.deepEqual(
    buildDays([item('acme/web', '2026-10-08T23:40:00Z', 'After midnight')], config).map((day) => day.date),
    ['2026-10-09'],
  );
});
