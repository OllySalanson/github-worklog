import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { run } from '../src/cli.js';
import { runGit } from '../src/publish.js';
import { commit, fakeGh, pr } from './helpers.js';

vm.runInThisContext(await readFile(new URL('../src/unlock-client.js', import.meta.url), 'utf8'));
const { deriveKey, decrypt } = globalThis.githubWorklogUnlock;

const PASSWORD = 'a long and private passphrase';

async function setup(config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'worklog-cli-'));
  const configPath = join(dir, 'config.json');
  const passwordPath = join(dir, 'password');
  await writeFile(
    configPath,
    JSON.stringify({ title: 'Acme work', author: 'dev', repos: ['acme/app', { repo: 'acme/tools', name: 'Tools' }], ...config }),
  );
  await writeFile(passwordPath, `${PASSWORD}\n`);
  const fake = fakeGh({
    pullRequests: {
      'acme/app': [pr(4, 'feat: add a checkout page', '2026-09-24T14:00:00Z')],
      'acme/tools': [],
    },
    commits: { 'acme/tools': [commit('1234567abc', 'Fix the build script', '2026-06-02T08:30:00Z')] },
  });
  const output = [];
  const deps = {
    gh: fake.gh,
    out: (line) => output.push(line),
    err: (line) => output.push(line),
    now: () => new Date('2026-09-25T12:00:00Z'),
  };
  return { dir, configPath, passwordPath, fake, output, deps };
}

async function unlock(page, password = PASSWORD) {
  const payload = JSON.parse(page.match(/id="payload">(.*?)<\/script>/)[1]);
  return decrypt(await deriveKey(password, payload), payload);
}

test('build writes only the encrypted page, which unlocks to the work log', async () => {
  const { dir, configPath, passwordPath, output, deps } = await setup();
  const out = join(dir, 'site.html');
  const code = await run(['build', '--config', configPath, '--password-file', passwordPath, '--out', out], deps);
  assert.equal(code, 0, output.join('\n'));

  const page = await readFile(out, 'utf8');
  assert.doesNotMatch(page, /Acme|checkout|build script/);
  const html = await unlock(page);
  assert.match(html, /<title>Acme work<\/title>/);
  assert.match(html, /Thursday 24 September 2026[\s\S]*Add a checkout page/);
  assert.match(html, /Tuesday 2 June 2026[\s\S]*<h4>Tools<\/h4>[\s\S]*Fix the build script/);
  assert.match(html, /Activity at 09:30/);

  assert.doesNotMatch(output.join('\n'), new RegExp(PASSWORD));
  assert.match(output.join('\n'), /Found 2 changes over 2 days/);
});

test('build adds other work from the activities file, only inside the encrypted page', async () => {
  const { dir, output, deps } = await setup();
  await writeFile(
    join(dir, 'activities.json'),
    JSON.stringify([
      { date: '2026-09-24', project: 'Warehouse', kind: 'reviewing', text: 'reviewed all 28 staff bug reports' },
      { date: '2026-09-23', project: 'Warehouse', kind: 'testing', text: 'test calls (round 2)' },
    ]),
  );
  const configPath = join(dir, 'with-activities.json');
  await writeFile(configPath, JSON.stringify({ title: 'Acme work', author: 'dev', repos: ['acme/app'], activities: 'activities.json' }));
  const out = join(dir, 'site.html');
  const code = await run(['build', '--config', configPath, '--password-file', join(dir, 'password'), '--out', out], deps);
  assert.equal(code, 0, output.join('\n'));

  const page = await readFile(out, 'utf8');
  assert.doesNotMatch(page, /Warehouse|bug reports|test calls/);
  const html = await unlock(page);
  assert.match(html, /Thursday 24 September 2026[\s\S]*Add a checkout page[\s\S]*Other work[\s\S]*Reviewing<\/span><span>Warehouse: reviewed all 28 staff bug reports/);
  assert.match(html, /<h3>Wednesday 23 September 2026<\/h3><p class="stats"><span><b>1<\/b> task completed<\/span><\/p>\n\n<div class="repo other">[\s\S]*Testing<\/span><span>Warehouse: test calls \(round 2\)/);
  assert.match(html, /<b>2<\/b> tasks completed<\/span><span><b class="added">/);
  assert.match(output.join('\n'), /Found 1 change and 2 other activities over 2 days/);
});

test('publish pushes the encrypted page to gh-pages and turns on Pages', async () => {
  const { configPath, passwordPath, fake, output, deps } = await setup({ publishTo: 'dev/worklog' });
  const remote = await mkdtemp(join(tmpdir(), 'worklog-remote-'));
  execFileSync('git', ['init', '--quiet', '--bare', remote]);
  // Send the push to a local bare repo instead of github.com.
  const git = (args, options) =>
    runGit(
      args.map((arg) => (arg === 'https://github.com/dev/worklog.git' ? remote : arg)),
      options,
    );

  const code = await run(['publish', '--config', configPath, '--password-file', passwordPath], { ...deps, git });
  assert.equal(code, 0, output.join('\n'));
  assert.match(output.join('\n'), /Published\. It can take a minute to update at https:\/\/dev\.github\.io\/site\//);
  assert.deepEqual(fake.state.pages.source, { branch: 'gh-pages', path: '/' });

  const published = execFileSync('git', ['show', 'gh-pages:index.html'], { cwd: remote, encoding: 'utf8' });
  assert.doesNotMatch(published, /Acme|checkout/);
  assert.match(await unlock(published), /Add a checkout page/);
  const files = execFileSync('git', ['ls-tree', '-r', '--name-only', 'gh-pages'], { cwd: remote, encoding: 'utf8' });
  assert.doesNotMatch(files, /config|password|\.json/);
});

test('publish can push with its own token while reading with the GitHub CLI login', async () => {
  const { configPath, passwordPath, fake, output, deps } = await setup();
  const remote = await mkdtemp(join(tmpdir(), 'worklog-remote-'));
  execFileSync('git', ['init', '--quiet', '--bare', remote]);
  const tokens = [];
  const gh = (args, options = {}) => {
    tokens.push({ call: args[1] === 'graphql' ? 'read' : 'pages', token: options.env?.GH_TOKEN });
    return fake.gh(args, options);
  };
  const git = (args, options = {}) => {
    tokens.push({ call: 'git', token: options.env?.GH_TOKEN });
    return runGit(args.map((arg) => (arg === 'https://github.com/dev/ci.git' ? remote : arg)), options);
  };
  const env = { PATH: process.env.PATH, GITHUB_WORKLOG_PUBLISH_TOKEN: 'publish-secret' };

  const code = await run(['publish', '--config', configPath, '--password-file', passwordPath, '--repo', 'dev/ci'], {
    ...deps,
    gh,
    git,
    env,
  });
  assert.equal(code, 0, output.join('\n'));
  assert.deepEqual(new Set(tokens.filter((t) => t.call === 'read').map((t) => t.token)), new Set([undefined]));
  assert.ok(tokens.some((t) => t.call === 'git') && tokens.some((t) => t.call === 'pages'));
  for (const t of tokens.filter((t) => t.call !== 'read')) assert.equal(t.token, 'publish-secret');
  assert.doesNotMatch(output.join('\n'), /publish-secret/);
});

test('--activities replaces the activities file named in the config', async () => {
  const { dir, passwordPath, output, deps } = await setup();
  await writeFile(
    join(dir, 'elsewhere.json'),
    JSON.stringify([{ date: '2026-09-24', project: 'Warehouse', kind: 'planning', text: 'planned the next stage' }]),
  );
  const configPath = join(dir, 'stale-activities.json');
  await writeFile(configPath, JSON.stringify({ title: 'T', author: 'dev', repos: ['acme/app'], activities: 'gone.json' }));
  const out = join(dir, 'site.html');
  const code = await run(
    ['build', '--config', configPath, '--password-file', passwordPath, '--activities', join(dir, 'elsewhere.json'), '--out', out],
    deps,
  );
  assert.equal(code, 0, output.join('\n'));
  assert.match(await unlock(await readFile(out, 'utf8')), /Warehouse: planned the next stage/);
});

test('publish refuses other work without a start time from the date the config asks, before reading GitHub', async () => {
  const { dir, passwordPath, fake, output, deps } = await setup();
  const activitiesPath = join(dir, 'activities.json');
  await writeFile(
    activitiesPath,
    JSON.stringify([
      { date: '2026-09-21', project: 'Warehouse', kind: 'planning', text: 'planned before the times were kept' },
      { date: '2026-09-22', project: 'Warehouse', kind: 'reviewing', text: 'reviewed all 28 staff bug reports from the first week' },
      { date: '2026-09-23', project: 'Storefront', kind: 'testing', text: 'test orders', start: '2026-09-23T14:00:00+01:00' },
      { date: '2026-09-24', project: 'Storefront', kind: 'other', text: 'wrote a guide', end: '2026-09-24T16:00:00+01:00' },
    ]),
  );
  const configPath = join(dir, 'strict.json');
  await writeFile(
    configPath,
    JSON.stringify({ title: 'T', author: 'dev', repos: ['acme/app'], publishTo: 'dev/worklog', activities: 'activities.json', requireActivityTimesFrom: '2026-09-22' }),
  );
  const git = async () => {
    throw new Error('git should not run');
  };
  const code = await run(['publish', '--config', configPath, '--password-file', passwordPath], { ...deps, git, env: {} });
  assert.equal(code, 1);
  assert.equal(fake.calls.length, 0);
  const text = output.join('\n');
  assert.match(text, /^Not publishing: 2 pieces of other work have no "start" time, and "requireActivityTimesFrom" in the config asks for one on every entry from 2026-09-22:$/m);
  assert.match(text, /^  - activity 2, 2026-09-22, Warehouse: "reviewed all 28 staff bug reports\.\.\."$/m);
  assert.match(text, /^  - activity 4, 2026-09-24, Storefront: "wrote a guide"$/m);
  assert.doesNotMatch(text, /activity [13],/);
  assert.match(text, /"start": "2026-09-22T14:05:00\+01:00", in .*activities\.json\. Then publish again\.$/m);

  // In GitHub Actions the log may be public, so it names entries without their words.
  output.length = 0;
  assert.equal(await run(['publish', '--config', configPath, '--password-file', passwordPath], { ...deps, git, env: { GITHUB_ACTIONS: 'true' } }), 1);
  assert.match(output.join('\n'), /^  - activity 2, 2026-09-22, Warehouse$/m);
  assert.match(output.join('\n'), /in your activities file and the WORKLOG_ACTIVITIES secret\. Then publish again\.$/m);
  assert.doesNotMatch(output.join('\n'), /reviewed|guide|activities\.json/);

  // build still writes the page, with a warning.
  output.length = 0;
  const out = join(dir, 'site.html');
  const built = await run(['build', '--config', configPath, '--password-file', passwordPath, '--out', out], { ...deps, env: {} });
  assert.equal(built, 0, output.join('\n'));
  assert.match(output.join('\n'), /^Warning: 2 pieces of other work have no "start" time[\s\S]*Until then, publish refuses\.$/m);
  assert.match(await unlock(await readFile(out, 'utf8')), /Warehouse: reviewed all 28 staff bug reports/);
});

test('publish goes ahead when all other work from the required date has a start time', async () => {
  const { dir, passwordPath, output, deps } = await setup();
  const remote = await mkdtemp(join(tmpdir(), 'worklog-remote-'));
  execFileSync('git', ['init', '--quiet', '--bare', remote]);
  const git = (args, options) => runGit(args.map((arg) => (arg === 'https://github.com/dev/worklog.git' ? remote : arg)), options);
  await writeFile(
    join(dir, 'activities.json'),
    JSON.stringify([
      { date: '2026-09-21', project: 'Warehouse', kind: 'planning', text: 'planned the next stage' },
      { date: '2026-09-24', project: 'Warehouse', kind: 'testing', text: 'test calls', start: '2026-09-24T07:10:00+01:00' },
    ]),
  );
  const configPath = join(dir, 'strict.json');
  await writeFile(
    configPath,
    JSON.stringify({ title: 'T', author: 'dev', repos: ['acme/app'], publishTo: 'dev/worklog', activities: 'activities.json', requireActivityTimesFrom: '2026-09-22' }),
  );
  const code = await run(['publish', '--config', configPath, '--password-file', passwordPath], { ...deps, git, env: {} });
  assert.equal(code, 0, output.join('\n'));
  assert.doesNotMatch(output.join('\n'), /start" time/);
  const published = execFileSync('git', ['show', 'gh-pages:index.html'], { cwd: remote, encoding: 'utf8' });
  assert.match(await unlock(published), /First activity 07:10/);
});

test('with "dayStartsAt", work past midnight stays with the day it began, alongside required start times', async () => {
  const { dir, passwordPath, output, deps } = await setup();
  await writeFile(
    join(dir, 'activities.json'),
    JSON.stringify([
      { date: '2026-09-24', project: 'Warehouse', kind: 'testing', text: 'late test round', start: '2026-09-24T23:10:00+01:00', end: '2026-09-25T01:40:00+01:00' },
    ]),
  );
  const configPath = join(dir, 'workday.json');
  await writeFile(
    configPath,
    JSON.stringify({ title: 'T', author: 'dev', repos: ['acme/app'], activities: 'activities.json', requireActivityTimesFrom: '2026-09-22', dayStartsAt: '06:00' }),
  );
  const out = join(dir, 'site.html');
  const code = await run(['build', '--config', configPath, '--password-file', passwordPath, '--out', out], deps);
  assert.equal(code, 0, output.join('\n'));
  assert.doesNotMatch(output.join('\n'), /start" time/);
  const html = await unlock(await readFile(out, 'utf8'));
  assert.match(html, /Thursday 24 September 2026[\s\S]*First activity 15:00 · Last activity 01:40/);
  assert.doesNotMatch(html, /id="d2026-09-25"/);
});

test('--repo overrides publishTo, and publish without either is refused', async () => {
  const { configPath, passwordPath, output, deps } = await setup();
  const code = await run(['publish', '--config', configPath, '--password-file', passwordPath], deps);
  assert.equal(code, 2);
  assert.match(output.join('\n'), /needs --repo/);
});

test('warns about short passwords without printing them', async () => {
  const { configPath, dir, output, deps } = await setup();
  const shortPath = join(dir, 'short');
  await writeFile(shortPath, 'hunter2\n');
  await run(['build', '--config', configPath, '--password-file', shortPath, '--out', join(dir, 'x.html')], deps);
  const text = output.join('\n');
  assert.match(text, /shorter than 12 characters/);
  assert.doesNotMatch(text, /hunter2/);
});

test('explains usage mistakes and config errors', async () => {
  const { configPath, passwordPath, dir, output, deps } = await setup();
  assert.equal(await run([], deps), 2);
  assert.equal(await run(['--help'], deps), 0);
  assert.equal(await run(['deploy', '--config', configPath, '--password-file', passwordPath], deps), 2);
  assert.equal(await run(['build', '--config', configPath], deps), 2);
  assert.equal(await run(['build', '--nope'], deps), 2);
  assert.equal(await run(['build', '--config', join(dir, 'missing.json'), '--password-file', passwordPath], deps), 1);
  const noActivities = join(dir, 'no-activities.json');
  await writeFile(noActivities, JSON.stringify({ title: 'T', author: 'dev', repos: ['acme/app'], activities: 'gone.json' }));
  assert.equal(await run(['build', '--config', noActivities, '--password-file', passwordPath], deps), 1);
  const text = output.join('\n');
  assert.match(text, /Usage:/);
  assert.match(text, /Unknown command: deploy/);
  assert.match(text, /Both --config and --password-file are required/);
  assert.match(text, /Unknown option '--nope'/);
  assert.match(text, /Cannot read config file/);
  assert.match(text, /Cannot read activities file .*gone\.json: ENOENT/);
});

test('reports GitHub failures without a stack trace', async () => {
  const { configPath, passwordPath, output, deps } = await setup();
  const gh = async () => {
    throw new Error('gh failed: HTTP 401: Bad credentials');
  };
  assert.equal(await run(['build', '--config', configPath, '--password-file', passwordPath], { ...deps, gh }), 1);
  assert.match(output.at(-1), /^Failed: gh failed: HTTP 401: Bad credentials$/);
});
