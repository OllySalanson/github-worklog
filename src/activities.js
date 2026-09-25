import { readFile } from 'node:fs/promises';
import { ConfigError } from './config.js';

// The kinds of other work, in the words shown on the page.
export const ACTIVITY_KINDS = {
  planning: 'Planning',
  reviewing: 'Reviewing',
  testing: 'Testing',
  'setting-up': 'Setting up',
  other: 'Other',
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
// A full ISO timestamp with its offset, such as 2026-09-24T14:05:00+01:00.
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export async function loadActivities(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read activities file ${path}: ${error.code ?? 'read failed'}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Activities file ${path} is not valid JSON: ${error.message}`);
  }
  return parseActivities(data, path);
}

export function parseActivities(data, path) {
  if (!Array.isArray(data)) throw new ConfigError(`Activities file ${path} must hold a JSON list of activities.`);
  return data.map((entry, index) => {
    const where = `Activity ${index + 1} in ${path}`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ConfigError(`${where} must be an object.`);
    const date = entry.date;
    if (typeof date !== 'string' || !DATE_PATTERN.test(date) || !isRealDate(date)) {
      throw new ConfigError(`${where} needs a "date" like 2026-01-31.`);
    }
    for (const key of ['project', 'text']) {
      if (typeof entry[key] !== 'string' || !entry[key].trim()) {
        throw new ConfigError(`${where} needs a non-empty "${key}".`);
      }
    }
    if (!Object.hasOwn(ACTIVITY_KINDS, entry.kind)) {
      throw new ConfigError(`${where} has an unknown "kind"; use one of ${Object.keys(ACTIVITY_KINDS).join(', ')}.`);
    }
    const activity = { date, project: entry.project.trim(), kind: entry.kind, text: entry.text.trim() };
    for (const key of ['start', 'end']) {
      if (entry[key] === undefined) continue;
      if (typeof entry[key] !== 'string' || !TIME_PATTERN.test(entry[key]) || Number.isNaN(Date.parse(entry[key]))) {
        throw new ConfigError(`${where} has a "${key}" that is not a time like 2026-01-31T14:05:00Z.`);
      }
      activity[key] = entry[key];
    }
    if (activity.start && activity.end && Date.parse(activity.end) < Date.parse(activity.start)) {
      throw new ConfigError(`${where} ends before it starts.`);
    }
    return activity;
  });
}

function isRealDate(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}
