import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACTIVITY_KINDS, loadActivities, parseActivities } from '../src/activities.js';
import { ConfigError } from '../src/config.js';

const good = { date: '2026-09-24', project: ' Web ', kind: 'setting-up', text: ' switched on the help page ' };

test('reads a list of activities and trims their words', () => {
  assert.deepEqual(parseActivities([good], 'a.json'), [
    { date: '2026-09-24', project: 'Web', kind: 'setting-up', text: 'switched on the help page' },
  ]);
  assert.deepEqual(parseActivities([], 'a.json'), []);
  assert.deepEqual(Object.values(ACTIVITY_KINDS), ['Planning', 'Reviewing', 'Testing', 'Setting up', 'Other']);
});

test('rejects bad activities with a message that says which one', () => {
  const cases = [
    [{}, /must hold a JSON list/],
    [[null], /Activity 1 in a\.json must be an object/],
    [[good, { ...good, date: '24/09/2026' }], /Activity 2 in a\.json needs a "date"/],
    [[{ ...good, date: '2026-02-30' }], /needs a "date"/],
    [[{ ...good, project: ' ' }], /needs a non-empty "project"/],
    [[{ ...good, text: 3 }], /needs a non-empty "text"/],
    [[{ ...good, kind: 'meeting' }], /unknown "kind"; use one of planning, reviewing, testing, setting-up, other/],
  ];
  for (const [data, pattern] of cases) {
    assert.throws(() => parseActivities(data, 'a.json'), (error) => error instanceof ConfigError && pattern.test(error.message));
  }
});

test('loads an activities file and reports unreadable or invalid files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'worklog-activities-'));
  await writeFile(join(dir, 'good.json'), JSON.stringify([good]));
  await writeFile(join(dir, 'bad.json'), '[ nope');
  assert.equal((await loadActivities(join(dir, 'good.json'))).length, 1);
  await assert.rejects(loadActivities(join(dir, 'bad.json')), /Activities file .* is not valid JSON/);
  await assert.rejects(loadActivities(join(dir, 'missing.json')), /Cannot read activities file .*ENOENT/);
});

test('the example activities file is valid', async () => {
  const path = new URL('../examples/activities.example.json', import.meta.url);
  const activities = parseActivities(JSON.parse(await readFile(path, 'utf8')), 'example');
  assert.ok(activities.length >= 4);
});
