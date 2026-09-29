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

// The index of the project a change belongs to within its repo: one past the
// index of the first project whose paths match every file it changed, leaving
// out the repo's shared files, or 0 for the repo itself. A change that only
// touched shared files, or whose files were not fetched, stays with the repo.
export function projectIndex(repo, files) {
  if (!repo?.projects.length || !files) return 0;
  const own = files.filter((file) => !repo.sharedPaths.some((path) => path.test(file)));
  if (!own.length) return 0;
  const index = repo.projects.findIndex((project) => own.every((file) => project.paths.some((path) => path.test(file))));
  return index + 1;
}

// Groups activity into days (newest first), each with its items grouped by
// repo, and by project within a repo, in config order, its totals and the first and last activity time, and
// then any other work from the activities file. Each activity counts as a task
// completed, but has no lines of code, and its optional start and end times
// count towards the day's activity times.
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
    const day = dayFor(activity.date);
    day.activities.push({ ...activity, label: ACTIVITY_KINDS[activity.kind] });
    // A time only counts on the activity's own day, so work that ran past
    // midnight cannot give a day a clock time from another day.
    for (const time of [activity.start, activity.end]) {
      if (time && dayKey(time, timeZone) === activity.date) day.times.push(time);
    }
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
        const repoIndex = repoOrder.get(item.repo.toLowerCase()) ?? Infinity;
        const repo = repos[repoIndex];
        const project = projectIndex(repo, item.files);
        const key = `${item.repo.toLowerCase()}\n${project}`;
        if (!groups.has(key)) {
          const label = project ? repo.projects[project - 1].label : (repo?.label ?? item.repo);
          groups.set(key, { repo: item.repo, label, order: [repoIndex, project], items: [] });
        }
        const { files, ...shown } = item;
        groups.get(key).items.push({ ...shown, title: cleanTitle(item.title) });
      }
      return {
        date: day.date,
        label: longDate(day.date),
        ...dayStats(day.items),
        tasks: day.items.length + day.activities.length,
        firstActivity: times.length ? clockTime(times[0], timeZone) : null,
        lastActivity: times.length ? clockTime(times.at(-1), timeZone) : null,
        groups: [...groups.values()]
          .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1])
          .map(({ order, ...group }) => group),
        activities: day.activities,
      };
    });
}
