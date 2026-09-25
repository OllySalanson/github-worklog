import { ACTIVITY_KINDS } from './activities.js';

const CONVENTIONAL_PREFIX = /^(feat|fix|chore|docs|refactor|perf|test|tests|build|ci|style|revert)(\([^)]*\))?!?:\s*/i;
const TRAILING_PR_NUMBER = /\s*\(#\d+\)$/;

// Turns "fix(api): stop double counting (#12)." into "Stop double counting".
export function cleanTitle(title) {
  let text = title.trim().replace(TRAILING_PR_NUMBER, '').replace(CONVENTIONAL_PREFIX, '').trim();
  if (text.endsWith('.') && !text.endsWith('..')) text = text.slice(0, -1);
  if (!text) return title.trim();
  return text[0].toUpperCase() + text.slice(1);
}

export function dayKey(time, timeZone) {
  // en-CA formats dates as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(time),
  );
}

export function clockTime(time, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(
    new Date(time),
  );
}

// "Friday 25 September 2026", for a YYYY-MM-DD key or a Date in a time zone.
export function longDate(value, timeZone = 'UTC') {
  // Noon UTC keeps a calendar date key on the same day whatever the zone.
  const date = typeof value === 'string' ? new Date(`${value}T12:00:00Z`) : value;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.year}`;
}

// Tasks completed and lines added and removed across a day's changes.
export function dayStats(items) {
  return {
    tasks: items.length,
    additions: items.reduce((sum, item) => sum + (item.additions ?? 0), 0),
    deletions: items.reduce((sum, item) => sum + (item.deletions ?? 0), 0),
  };
}

// Groups activity into days (newest first), each with its items grouped by
// repo in config order, its totals and the first and last activity time, and
// then any other work from the activities file, which never counts as a task.
export function buildDays(items, config, activities = []) {
  const { timeZone, since, repos } = config;
  const repoOrder = new Map(repos.map((repo, index) => [repo.fullName.toLowerCase(), index]));
  const days = new Map();
  const dayFor = (key) => {
    if (!days.has(key)) days.set(key, { date: key, items: [], times: [], activities: [] });
    return days.get(key);
  };

  for (const item of items) {
    const key = dayKey(item.time, timeZone);
    if (since && key < since) continue;
    const day = dayFor(key);
    day.items.push(item);
    day.times.push(item.time);
  }
  for (const activity of activities) {
    if (since && activity.date < since) continue;
    dayFor(activity.date).activities.push({ ...activity, label: ACTIVITY_KINDS[activity.kind] });
  }

  // Commits made inside a pull request count towards the activity times of
  // their own day, but only for days that already show some work.
  for (const item of items) {
    for (const time of item.workTimes ?? []) {
      days.get(dayKey(time, timeZone))?.times.push(time);
    }
  }

  return [...days.values()]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((day) => {
      const times = day.times.map((time) => Date.parse(time)).sort((a, b) => a - b);
      const groups = new Map();
      for (const item of [...day.items].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
        const key = item.repo.toLowerCase();
        if (!groups.has(key)) {
          const repo = repos[repoOrder.get(key)];
          groups.set(key, { repo: item.repo, label: repo?.label ?? item.repo, items: [] });
        }
        groups.get(key).items.push({ ...item, title: cleanTitle(item.title) });
      }
      return {
        date: day.date,
        label: longDate(day.date),
        ...dayStats(day.items),
        firstActivity: times.length ? clockTime(times[0], timeZone) : null,
        lastActivity: times.length ? clockTime(times.at(-1), timeZone) : null,
        groups: [...groups.values()].sort(
          (a, b) => (repoOrder.get(a.repo.toLowerCase()) ?? Infinity) - (repoOrder.get(b.repo.toLowerCase()) ?? Infinity),
        ),
        activities: day.activities,
      };
    });
}
