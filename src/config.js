import { readFile } from 'node:fs/promises';

const REPO_PATTERN = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class ConfigError extends Error {}

export async function loadConfig(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`Cannot read config file ${path}: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`Config file ${path} is not valid JSON: ${error.message}`);
  }
  return parseConfig(data);
}

export function parseConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ConfigError('Config must be a JSON object.');
  }
  const title = requireString(data, 'title');
  const author = requireString(data, 'author');
  const timeZone = data.timeZone === undefined ? 'Europe/London' : requireString(data, 'timeZone');
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
  } catch {
    throw new ConfigError(`"timeZone" is not a known time zone: ${timeZone}`);
  }
  let since = null;
  if (data.since !== undefined) {
    since = requireString(data, 'since');
    if (!DATE_PATTERN.test(since)) throw new ConfigError('"since" must be a date like 2026-01-31.');
  }
  let publishTo = null;
  if (data.publishTo !== undefined) {
    publishTo = requireString(data, 'publishTo');
    if (!REPO_PATTERN.test(publishTo)) throw new ConfigError('"publishTo" must look like owner/repo.');
  }
  if (!Array.isArray(data.repos) || data.repos.length === 0) {
    throw new ConfigError('"repos" must be a non-empty list of "owner/repo" names.');
  }
  const repos = data.repos.map(parseRepo);
  const seen = new Set();
  for (const repo of repos) {
    const key = repo.fullName.toLowerCase();
    if (seen.has(key)) throw new ConfigError(`Repo listed twice: ${repo.fullName}`);
    seen.add(key);
  }
  return { title, author, timeZone, since, publishTo, repos };
}

function parseRepo(entry) {
  const spec = typeof entry === 'string' ? { repo: entry } : entry;
  if (!spec || typeof spec !== 'object' || typeof spec.repo !== 'string' || !REPO_PATTERN.test(spec.repo)) {
    throw new ConfigError(`Each repo must be "owner/repo" or { "repo": "owner/repo", "name": "Label" }: ${JSON.stringify(entry)}`);
  }
  if (spec.name !== undefined && (typeof spec.name !== 'string' || !spec.name.trim())) {
    throw new ConfigError(`Repo "name" must be a non-empty string: ${spec.repo}`);
  }
  const [owner, name] = spec.repo.split('/');
  return { owner, name, fullName: spec.repo, label: spec.name?.trim() || labelFromName(name) };
}

const WORD_SPELLINGS = { github: 'GitHub', gitlab: 'GitLab', api: 'API', ui: 'UI', ios: 'iOS' };

// "warehouse-app" -> "Warehouse App"
export function labelFromName(name) {
  return name
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((word) => WORD_SPELLINGS[word.toLowerCase()] ?? word[0].toUpperCase() + word.slice(1))
    .join(' ');
}

function requireString(data, key) {
  const value = data[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ConfigError(`"${key}" must be a non-empty string.`);
  }
  return value.trim();
}

export async function readPassword(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // The error message only names the file, never its contents.
    throw new ConfigError(`Cannot read password file ${path}: ${error.code ?? 'read failed'}`);
  }
  const password = text.replace(/\r?\n$/, '');
  if (!password) throw new ConfigError(`Password file ${path} is empty.`);
  return password;
}
