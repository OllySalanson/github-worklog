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

// The work day a time belongs to: its calendar day in the time zone, or the
// day before when it falls before the hour the work day starts ("HH:MM"), so
// work that runs past midnight stays with the day it began.
export function workDayKey(time, timeZone, dayStartsAt = null) {
  const key = dayKey(time, timeZone);
  if (!dayStartsAt || clockTime(time, timeZone) >= dayStartsAt) return key;
  const previous = new Date(`${key}T12:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
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
// index of the first project whose branches match the branch a pull request
// was made from, or failing that of the first project whose paths match every
// file it changed, leaving out the repo's shared files, or 0 for the repo
// itself. A change that only touched shared files, or whose files were not
// fetched, stays with the repo unless its branch says otherwise.
export function projectIndex(repo, files, branch) {
  if (!repo?.projects.length) return 0;
  if (branch) {
    const index = repo.projects.findIndex((project) => project.branches.some((pattern) => pattern.test(branch)));
    if (index >= 0) return index + 1;
  }
  if (!files) return 0;
  const own = files.filter((file) => !repo.sharedPaths.some((path) => path.test(file)));
  if (!own.length) return 0;
  const index = repo.projects.findIndex(
    (project) => project.paths.length && own.every((file) => project.paths.some((path) => path.test(file))),
  );
  return index + 1;
}

// The group of a day that other work for a project joins: the repo or
// project of that name in the config (ignoring case), or else a group of its
// own after them, in the order its project first appears in the file.
function activityGroups(repos, activities) {
  const groups = new Map();
  for (const [repoIndex, repo] of repos.entries()) {
    for (const [index, label] of [repo.label, ...repo.projects.map((project) => project.label)].entries()) {
      const key = label.toLowerCase();
      if (!groups.has(key)) groups.set(key, { key: `${repo.fullName.toLowerCase()}\n${index}`, repo: repo.fullName, label, order: [repoIndex, index] });
    }
  }
  for (const [index, activity] of activities.entries()) {
    const key = activity.project.toLowerCase();
    if (!groups.has(key)) groups.set(key, { key: `\n${key}`, repo: null, label: activity.project, order: [Infinity, index] });
  }
  return groups;
}

// The projects of other work that match no repo or project in the config, so
// each shows under a heading of its own.
export function unmatchedProjects(activities, config) {
  const known = activityGroups(config.repos, []);
  const unmatched = new Map();
  for (const { project } of activities) {
    const key = project.toLowerCase();
    if (!known.has(key) && !unmatched.has(key)) unmatched.set(key, project);
  }
  return [...unmatched.values()];
}

// Groups activity into work days (newest first; see workDayKey), each with its
// changes grouped by repo, and by project within a repo, in config order, its
// totals and the first and last activity time. Other work from the activities
// file joins the group of its project (see activityGroups), split by kind in
// the order of ACTIVITY_KINDS, each entry with its start and end clock times
// and the timed ones first by start time, its first letter a capital as in
// the titles of changes. Each activity counts as a task
// completed, but has no lines of code, and its optional start and end times
// count towards the day's activity times.
export function buildDays(items, config, activities = []) {
  const { timeZone, since, repos, dayStartsAt } = config;
  const workDay = (time) => workDayKey(time, timeZone, dayStartsAt);
  const repoOrder = new Map(repos.map((repo, index) => [repo.fullName.toLowerCase(), index]));
  const projectGroups = activityGroups(repos, activities);
  const days = new Map();
  const dayFor = (key) => {
    if (!days.has(key)) days.set(key, { date: key, items: [], times: [], activities: [] });
    return days.get(key);
  };

  for (const item of items) {
    const key = workDay(item.time);
    if (since && key < since) continue;
    const day = dayFor(key);
    day.items.push(item);
    day.times.push(item.time);
  }
  for (const activity of activities) {
    if (since && activity.date < since) continue;
    const day = dayFor(activity.date);
    day.activities.push(activity);
    // A time only counts on the activity's own work day, so work that ran
    // past the start of the next one cannot give a day a time from another.
    for (const time of [activity.start, activity.end]) {
      if (time && workDay(time) === activity.date) day.times.push(time);
    }
  }

  // Commits made inside a pull request count towards the activity times of
  // their own day, but only for days that already show some work.
  for (const item of items) {
    for (const time of item.workTimes ?? []) {
      days.get(workDay(time))?.times.push(time);
    }
  }

  const kinds = Object.keys(ACTIVITY_KINDS);
  return [...days.values()]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((day) => {
      const times = day.times.map((time) => Date.parse(time)).sort((a, b) => a - b);
      const groups = new Map();
      const groupFor = (key, make) => {
        if (!groups.has(key)) groups.set(key, { ...make(), items: [], other: [] });
        return groups.get(key);
      };
      for (const item of [...day.items].sort((a, b) => Date.parse(a.time) - Date.parse(b.time))) {
        const repoIndex = repoOrder.get(item.repo.toLowerCase()) ?? Infinity;
        const repo = repos[repoIndex];
        const project = projectIndex(repo, item.files, item.branch);
        const group = groupFor(`${item.repo.toLowerCase()}\n${project}`, () => ({
          repo: item.repo,
          label: project ? repo.projects[project - 1].label : (repo?.label ?? item.repo),
          order: [repoIndex, project],
        }));
        const { files, branch, ...shown } = item;
        group.items.push({ ...shown, title: cleanTitle(item.title) });
      }
      const timed = (activity) => (activity.start ? Date.parse(activity.start) : Infinity);
      for (const activity of [...day.activities].sort((a, b) => timed(a) - timed(b) || 0)) {
        const { key, ...made } = projectGroups.get(activity.project.toLowerCase());
        const group = groupFor(key, () => made);
        let kind = group.other.find((section) => section.kind === activity.kind);
        if (!kind) {
          kind = { kind: activity.kind, label: ACTIVITY_KINDS[activity.kind], entries: [] };
          group.other.push(kind);
          group.other.sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind));
        }
        kind.entries.push({
          text: activity.text[0].toUpperCase() + activity.text.slice(1),
          start: activity.start ? clockTime(activity.start, timeZone) : null,
          end: activity.end ? clockTime(activity.end, timeZone) : null,
        });
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
      };
    });
}
