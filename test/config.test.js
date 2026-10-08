import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConfigError, globToRegExp, labelFromName, loadConfig, parseConfig, readPassword } from '../src/config.js';

const base = { title: 'Work', author: 'dev', repos: ['acme/app'] };

test('fills in defaults and labels repos from their names', () => {
  const config = parseConfig({ ...base, repos: ['acme/warehouse-app', { repo: 'acme/help-desk', name: 'Support' }] });
  assert.equal(config.timeZone, 'Europe/London');
  assert.equal(config.since, null);
  assert.equal(config.publishTo, null);
  assert.equal(config.activities, null);
  assert.deepEqual(config.repos, [
    { owner: 'acme', name: 'warehouse-app', fullName: 'acme/warehouse-app', label: 'Warehouse App', projects: [], sharedPaths: [] },
    { owner: 'acme', name: 'help-desk', fullName: 'acme/help-desk', label: 'Support', projects: [], sharedPaths: [] },
  ]);
});

test('reads projects within a repo and their file patterns', () => {
  const config = parseConfig({
    ...base,
    repos: [
      {
        repo: 'acme/app',
        projects: [{ name: ' Billing ', paths: ['billing/**', 'docs/billing-*.md'] }],
        sharedPaths: ['AGENTS.md'],
      },
    ],
  });
  const [repo] = config.repos;
  assert.equal(repo.label, 'App');
  assert.deepEqual(repo.projects.map((project) => project.label), ['Billing']);
  const [billing, docs] = repo.projects[0].paths;
  assert.ok(billing.test('billing/invoices/index.ts') && !billing.test('src/billing.ts'));
  assert.ok(docs.test('docs/billing-runbook.md') && !docs.test('docs/help.md'));
  assert.ok(repo.sharedPaths[0].test('AGENTS.md') && !repo.sharedPaths[0].test('docs/AGENTS.md'));
  assert.deepEqual(repo.projects[0].branches, []);
});

test('reads branch patterns of a project, with or without paths', () => {
  const config = parseConfig({
    ...base,
    repos: [
      {
        repo: 'acme/app',
        projects: [
          { name: 'Billing', paths: ['billing/**'], branches: [' fm/billing-* '] },
          { name: 'Help', branches: ['help/**'] },
        ],
      },
    ],
  });
  const [billing, help] = config.repos[0].projects;
  assert.equal(billing.paths.length, 1);
  assert.ok(billing.branches[0].test('fm/billing-refunds') && !billing.branches[0].test('fm/rr-billing-refunds'));
  assert.deepEqual(help.paths, []);
  assert.ok(help.branches[0].test('help/faq/typos') && !help.branches[0].test('fm/help'));
});

test('file patterns match like .gitignore-style globs', () => {
  const matches = (pattern, path) => globToRegExp(pattern).test(path);
  assert.ok(matches('supabase/functions/clerk-*/**', 'supabase/functions/clerk-process/index.ts'));
  assert.ok(matches('supabase/functions/clerk-*/**', 'supabase/functions/clerk-process/deep/a.test.ts'));
  assert.ok(!matches('supabase/functions/clerk-*/**', 'supabase/functions/quote/clerk-x/index.ts'));
  assert.ok(matches('supabase/migrations/*_clerk*.sql', 'supabase/migrations/20260731000016_clerk.sql'));
  assert.ok(!matches('supabase/migrations/*_clerk*.sql', 'supabase/migrations/20260731000016_clerk.sqlx'));
  assert.ok(matches('**/package.json', 'package.json'));
  assert.ok(matches('**/package.json', 'apps/web/package.json'));
  assert.ok(!matches('**/package.json', 'apps/web/package.json.bak'));
  assert.ok(matches('docs/v?.md', 'docs/v2.md'));
  assert.ok(!matches('docs/*.md', 'docs/a/b.md'));
  assert.ok(matches('a+b (1).txt', 'a+b (1).txt'));
  assert.ok(!matches('a.txt', 'abtxt'));
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
    [{ ...base, repos: [{ repo: 'acme/app', projects: [] }] }, /"projects" must be a non-empty list/],
    [{ ...base, repos: [{ repo: 'acme/app', projects: [{ paths: ['a/**'] }] }] }, /non-empty "name"/],
    [{ ...base, repos: [{ repo: 'acme/app', projects: [{ name: 'A', paths: [] }] }] }, /"paths" of project A/],
    [{ ...base, repos: [{ repo: 'acme/app', projects: [{ name: 'A', paths: ['a', ''] }] }] }, /"paths" of project A/],
    [{ ...base, repos: [{ repo: 'acme/app', projects: [{ name: 'A' }] }] }, /Project A needs "paths", "branches" or both/],
    [{ ...base, repos: [{ repo: 'acme/app', projects: [{ name: 'A', branches: [] }] }] }, /"branches" of project A must be a non-empty list of branch patterns/],
    [{ ...base, repos: [{ repo: 'acme/app', projects: [{ name: 'A', branches: 'fm/a-*' }] }] }, /"branches" of project A/],
    [{ ...base, repos: [{ repo: 'acme/app', projects: [{ name: 'A', paths: ['a'], branches: [' '] }] }] }, /"branches" of project A/],
    [{ ...base, repos: [{ repo: 'acme/app', projects: [{ name: 'App', paths: ['a'] }] }] }, /same name as its repo/],
    [{ ...base, repos: [{ repo: 'acme/app', projects: [{ name: 'A', paths: ['a'] }, { name: 'a', paths: ['b'] }] }] }, /listed twice/],
    [{ ...base, repos: [{ repo: 'acme/app', sharedPaths: ['AGENTS.md'] }] }, /alongside "projects"/],
    [{ ...base, repos: [{ repo: 'acme/app', projects: [{ name: 'A', paths: ['a'] }], sharedPaths: 'x' }] }, /"sharedPaths"/],
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

test('the example config is valid', async () => {
  const config = await loadConfig(new URL('../examples/worklog.example.json', import.meta.url).pathname);
  assert.deepEqual(config.repos.map((repo) => [repo.label, repo.projects.map((project) => project.label)]), [
    ['Storefront', []],
    ['Warehouse', []],
    ['Back Office', ['Label Printer']],
  ]);
});
