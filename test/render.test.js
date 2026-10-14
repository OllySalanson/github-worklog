import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeHtml, formatCount, renderPage } from '../src/render.js';

const days = [
  {
    date: '2026-09-25',
    label: 'Friday 25 September 2026',
    tasks: 1,
    additions: 1234,
    deletions: 567,
    firstActivity: '09:05',
    lastActivity: '17:40',
    groups: [
      {
        repo: 'acme/web',
        label: 'Web & Shop',
        items: [{ id: '#7', title: 'Show <b>prices</b> "fast"', url: 'https://github.com/acme/web/pull/7?a=1&b=2' }],
        other: [],
      },
    ],
  },
  {
    date: '2026-08-31',
    label: 'Monday 31 August 2026',
    tasks: 1,
    additions: 0,
    deletions: 3,
    firstActivity: '10:00',
    lastActivity: '10:00',
    groups: [{ repo: 'acme/web', label: 'Web', items: [{ id: 'abc1234', title: 'Tidy up', url: 'https://x.test/c' }], other: [] }],
  },
];

const render = (overrides = {}) =>
  renderPage({
    title: 'Acme <Co>',
    days,
    generatedAt: new Date('2026-09-25T16:00:00Z'),
    timeZone: 'Europe/London',
    ...overrides,
  });

test('escapes everything that comes from GitHub or the config', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  const html = render();
  assert.match(html, /<title>Acme &lt;Co&gt;<\/title>/);
  assert.match(html, /Show &lt;b&gt;prices&lt;\/b&gt; &quot;fast&quot;/);
  assert.match(html, /href="https:\/\/github.com\/acme\/web\/pull\/7\?a=1&amp;b=2"/);
  assert.match(html, /<h4>Web &amp; Shop<\/h4>/);
  assert.doesNotMatch(html, /<b>prices/);
});

test('shows a summary, month headings and activity times labelled as activity, not hours', () => {
  const html = render();
  assert.match(html, /2 changes over 2 days · Updated Friday 25 September 2026 at 17:00/);
  assert.match(html, /not hours worked/);
  assert.deepEqual([...html.matchAll(/<h2 class="month">([^<]+)</g)].map((m) => m[1]), ['September 2026', 'August 2026']);
  assert.match(html, /First activity 09:05 · Last activity 17:40/);
  assert.match(html, /Activity at 10:00/);
});

test('is self-contained: no external scripts, styles, fonts or trackers', () => {
  const html = render();
  assert.doesNotMatch(html, /<script[^>]+src=/);
  assert.doesNotMatch(html, /<link/);
  assert.doesNotMatch(html, /@import|url\(/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /prefers-color-scheme: dark/);
});

test('says so when there is nothing to show', () => {
  assert.match(render({ days: [] }), /0 changes over 0 days[\s\S]*No activity found yet/);
});

test('formats counts the way GitHub does', () => {
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1234), '1,234');
  assert.equal(formatCount(1234567), '1,234,567');
});

test('heads each day with tasks completed and green and red line counts', () => {
  const html = render();
  assert.match(
    html,
    /<h3>Friday 25 September 2026<\/h3><p class="stats"><span><b>1<\/b> task completed<\/span><span><b class="added">\+1,234<\/b> lines of code added<\/span><span><b class="removed">-567<\/b> lines of code removed<\/span><\/p>/,
  );
  assert.match(html, /<b class="added">\+0<\/b> lines of code added<\/span><span><b class="removed">-3<\/b> lines of code removed/);
  const single = render({ days: [{ ...days[0], tasks: 3, additions: 1, deletions: 1 }] });
  assert.match(single, /<b>3<\/b> tasks completed/);
  assert.match(single, /\+1<\/b> line of code added/);
  assert.match(single, /-1<\/b> line of code removed/);
  assert.match(html, /--added: #1a7f37;[\s\S]*--removed: #d1242f;[\s\S]*--added: #3fb950;[\s\S]*--removed: #f85149;/);
});

const testing = (entries) => ({ kind: 'testing', label: 'Testing', entries });

test('shows other work under its project, after the code changes, in a section for each kind', () => {
  const group = {
    ...days[0].groups[0],
    other: [
      { kind: 'planning', label: 'Planning', entries: [{ text: 'Planning the "next" <stages>', start: '08:30', end: '09:15' }] },
      {
        kind: 'setting-up',
        label: 'Setting up',
        entries: [
          { text: 'Switched on the help page', start: '11:00', end: null },
          { text: 'Sent the welcome email', start: null, end: '12:00' },
          { text: 'Tidied the settings', start: null, end: null },
          { text: 'Checked the domain', start: '13:00', end: '13:00' },
        ],
      },
    ],
  };
  const html = render({ days: [{ ...days[0], groups: [group, { repo: null, label: 'Hiring', items: [], other: [testing([{ text: 'Test day', start: null, end: null }])] }] }, days[1]] });
  assert.match(
    html,
    /<div class="repo"><h4>Web &amp; Shop<\/h4><h5>Code changes<\/h5><ul>\n<li><a [^\n]*Show &lt;b&gt;prices[^\n]*<\/li>\n<\/ul>/,
  );
  assert.match(
    html,
    /<\/ul><h5>Planning<\/h5><ul>\n<li>Planning the &quot;next&quot; &lt;stages&gt;<span class="id">08:30 to 09:15<\/span><\/li>\n<\/ul><h5>Setting up<\/h5><ul>\n<li>Switched on the help page<span class="id">from 11:00<\/span><\/li>\n<li>Sent the welcome email<span class="id">until 12:00<\/span><\/li>\n<li>Tidied the settings<\/li>\n<li>Checked the domain<span class="id">13:00<\/span><\/li>\n<\/ul><\/div>\n<div class="repo"><h4>Hiring<\/h4><h5>Testing<\/h5><ul>\n<li>Test day<\/li>\n<\/ul><\/div>/,
  );
  assert.doesNotMatch(html, /Other work/);
  // Without other work, a project's changes need no heading of their own.
  assert.equal(html.match(/Code changes/g).length, 1);
  assert.match(html, /2 changes and 6 other activities over 2 days/);
});

const onlyOtherWork = (extra) => ({
  date: '2026-09-24',
  label: 'Thursday 24 September 2026',
  tasks: 1,
  additions: 0,
  deletions: 0,
  firstActivity: null,
  lastActivity: null,
  groups: [{ repo: 'acme/web', label: 'Web', items: [], other: [testing([{ text: 'Test calls (round 2)', start: null, end: null }])] }],
  ...extra,
});

test('a day with only other work shows its task count but no line totals or times', () => {
  const html = render({ days: [onlyOtherWork()] });
  assert.match(
    html,
    /<h3>Thursday 24 September 2026<\/h3><p class="stats"><span><b>1<\/b> task completed<\/span><\/p>\n<div class="repo"><h4>Web<\/h4><h5>Testing<\/h5><ul>\n<li>Test calls \(round 2\)<\/li>/,
  );
  assert.doesNotMatch(html, /lines? of code|class="times"|null|Code changes/);
  assert.match(html, /0 changes and 1 other activity over 1 day/);
});

test('a day with only other work shows activity times when its entries recorded them', () => {
  const html = render({ days: [onlyOtherWork({ tasks: 2, firstActivity: '09:00', lastActivity: '11:30' })] });
  assert.match(
    html,
    /<h3>Thursday 24 September 2026<\/h3><p class="stats"><span><b>2<\/b> tasks completed<\/span><\/p><p class="times">First activity 09:00 · Last activity 11:30<\/p>\n<div class="repo">/,
  );
  assert.doesNotMatch(html, /lines? of code/);
});
