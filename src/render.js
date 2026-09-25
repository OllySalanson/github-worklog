import { clockTime, longDate } from './worklog.js';

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// Shared by the work log page and the lock page so both look the same.
export const BASE_STYLES = `
:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --surface: #ffffff;
  --text: #1b1f24;
  --muted: #5d6671;
  --border: #e2e5e9;
  --accent: #0b62c4;
  --danger: #b42318;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111418;
    --surface: #1a1e24;
    --text: #e6e9ed;
    --muted: #9aa3ad;
    --border: #2c323a;
    --accent: #6cb2ff;
    --danger: #ff8a80;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
a { color: var(--accent); }
button { font: inherit; }
`;

const PAGE_STYLES = `
header { margin-bottom: 1.5rem; }
.top { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 0 0 .35rem; }
.meta, .note { color: var(--muted); font-size: .9rem; margin: 0; }
.note { margin-top: .5rem; }
.lock {
  flex: none;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--muted);
  border-radius: .5rem;
  padding: .3rem .75rem;
  cursor: pointer;
}
.lock:hover { color: var(--text); }
h2.month {
  font-size: .8rem;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 2rem 0 .75rem;
}
.day {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: .75rem;
  padding: 1rem 1.1rem;
  margin-bottom: .9rem;
}
.day h3 { font-size: 1.1rem; margin: 0; }
.times { color: var(--muted); font-size: .85rem; margin: .1rem 0 .4rem; }
.repo { margin-top: .75rem; }
.repo h4 { font-size: .9rem; font-weight: 600; margin: 0 0 .25rem; }
.repo ul { margin: 0; padding-left: 1.2rem; }
.repo li { margin: .2rem 0; overflow-wrap: anywhere; }
.repo li a { text-decoration: none; }
.repo li a:hover { text-decoration: underline; }
.id { color: var(--muted); font-size: .8rem; margin-left: .35rem; font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); }
`;

const LOCK_SCRIPT = `
document.getElementById('lock').addEventListener('click', function () {
  try {
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var key = localStorage.key(i);
      if (key && key.indexOf('github-worklog:') === 0) localStorage.removeItem(key);
    }
  } catch (e) {}
  location.reload();
});
`;

function monthLabel(date) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

function renderDay(day) {
  const groups = day.groups
    .map((group) => {
      const items = group.items
        .map(
          (item) =>
            `<li><a href="${escapeHtml(item.url)}">${escapeHtml(item.title)}</a><span class="id">${escapeHtml(item.id)}</span></li>`,
        )
        .join('\n');
      return `<div class="repo"><h4>${escapeHtml(group.label)}</h4><ul>\n${items}\n</ul></div>`;
    })
    .join('\n');
  const times =
    day.firstActivity === day.lastActivity
      ? `Activity at ${day.firstActivity}`
      : `First activity ${day.firstActivity} · Last activity ${day.lastActivity}`;
  return `<section class="day" id="d${day.date}"><h3>${escapeHtml(day.label)}</h3><p class="times">${times}</p>\n${groups}\n</section>`;
}

export function renderPage({ title, days, generatedAt, timeZone }) {
  const sections = [];
  let month = null;
  for (const day of days) {
    const label = monthLabel(day.date);
    if (label !== month) {
      sections.push(`<h2 class="month">${escapeHtml(label)}</h2>`);
      month = label;
    }
    sections.push(renderDay(day));
  }
  const updated = `${longDate(generatedAt, timeZone)} at ${clockTime(generatedAt, timeZone)}`;
  const count = days.reduce((sum, day) => sum + day.groups.reduce((n, group) => n + group.items.length, 0), 0);
  const summary = `${count} ${count === 1 ? 'change' : 'changes'} over ${days.length} ${days.length === 1 ? 'day' : 'days'}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLES}${PAGE_STYLES}</style>
</head>
<body>
<main>
<header>
<div class="top"><h1>${escapeHtml(title)}</h1><button type="button" class="lock" id="lock">Lock</button></div>
<p class="meta">${summary} · Updated ${escapeHtml(updated)}</p>
<p class="note">Times are the first and last GitHub activity each day, not hours worked.</p>
</header>
${sections.join('\n') || '<p class="empty">No activity found yet.</p>'}
</main>
<script>${LOCK_SCRIPT}</script>
</body>
</html>
`;
}
