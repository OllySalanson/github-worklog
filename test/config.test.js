import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, labelFromName, loadConfig, parseConfig, readPassword } from '../src/config.js';

const base = { title: 'Work', author: 'dev', repos: ['acme/app'] };

test('fills in defaults and labels repos from their names', () => {
  const config = parseConfig({ ...base, repos: ['acme/warehouse-app', { repo: 'acme/help-desk', name: 'Support' }] });
  assert.equal(config.timeZone, 'Europe/London');
  assert.equal(config.since, null);
  assert.equal(config.publishTo, null);
  assert.equal(config.activities, null);
  assert.deepEqual(config.repos, [
    { owner: 'acme', name: 'warehouse-app', fullName: 'acme/warehouse-app', label: 'Warehouse App' },
    { owner: 'acme', name: 'help-desk', fullName: 'acme/help-desk', label: 'Support' },
  ]);
});

test('labels keep well-known spellings', () => {
  assert.equal(labelFromName('github-worklog'), 'GitHub Worklog');
  assert.equal(labelFromName('public_api.v2'), 'Public API V2');
});

test('rejects bad configs with a clear message', () => {
  const cases = [
    [null, /JSON object/],
    [{ ...base, title: '' }, /"title"/],
    [{ ...base, author: 3 }, /"author"/],
    [{ ...base, repos: [] }, /"repos"/],
    [{ ...base, repos: ['not a repo'] }, /owner\/repo/],
    [{ ...base, repos: [{ repo: 'acme/app', name: '' }] }, /"name"/],
    [{ ...base, repos: ['acme/app', 'ACME/app'] }, /listed twice/],
    [{ ...base, timeZone: 'Mars/Base' }, /time zone/],
    [{ ...base, since: '1 Jan' }, /"since"/],
    [{ ...base, publishTo: 'nope' }, /"publishTo"/],
    [{ ...base, activities: '' }, /"activities"/],
  ];
  for (const [data, pattern] of cases) {
    assert.throws(() => parseConfig(data), (error) => error instanceof ConfigError && pattern.test(error.message));
  }
});

test('loads a config file and reports unreadable or invalid files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worklog-config-'));
  await writeFile(join(dir, 'good.json'), JSON.stringify(base));
  await writeFile(join(dir, 'bad.json'), '{ nope');
  await writeFile(join(dir, 'relative.json'), JSON.stringify({ ...base, activities: 'private/activities.json' }));
  await writeFile(join(dir, 'absolute.json'), JSON.stringify({ ...base, activities: '/somewhere/activities.json' }));
  assert.equal((await loadConfig(join(dir, 'good.json'))).title, 'Work');
  assert.equal((await loadConfig(join(dir, 'relative.json'))).activities, join(dir, 'private/activities.json'));
  assert.equal((await loadConfig(join(dir, 'absolute.json'))).activities, '/somewhere/activities.json');
  await assert.rejects(loadConfig(join(dir, 'bad.json')), /not valid JSON/);
  await assert.rejects(loadConfig(join(dir, 'missing.json')), /Cannot read config file/);
});

test('reads the password, dropping only the final newline, and never echoes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worklog-password-'));
  await writeFile(join(dir, 'unix'), ' correct horse \n');
  await writeFile(join(dir, 'windows'), 'battery staple\r\n');
  await writeFile(join(dir, 'empty'), '\n');
  assert.equal(await readPassword(join(dir, 'unix')), ' correct horse ');
  assert.equal(await readPassword(join(dir, 'windows')), 'battery staple');
  await assert.rejects(readPassword(join(dir, 'empty')), /is empty/);
  await assert.rejects(readPassword(join(dir, 'missing')), (error) => /ENOENT/.test(error.message));
});
