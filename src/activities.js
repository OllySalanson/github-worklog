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
    return { date, project: entry.project.trim(), kind: entry.kind, text: entry.text.trim() };
  });
}

function isRealDate(date) {
  const parsed = new Date(`${date}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}
