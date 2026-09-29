import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { fetchActivity, graphql } from '../src/github.js';
import { commit, fakeGh, pr } from './helpers.js';

const config = parseConfig({ title: 'Work', author: 'dev', repos: ['acme/app', 'acme/empty'] });

test('lists merged pull requests by the author and direct commits not covered by one', async () => {
  const { gh } = fakeGh({
    pageSize: 2,
    pullRequests: {
      'acme/app': [
        pr(1, 'Mine', '2026-09-01T10:00:00Z', { commitTimes: ['2026-09-01T08:00:00Z'], additions: 1234, deletions: 56 }),
        pr(2, 'Someone else', '2026-09-01T11:00:00Z', { author: 'other' }),
        pr(3, 'Also mine', '2026-09-02T10:00:00Z', { author: 'DEV' }),
      ],
      'acme/empty': [],
    },
    commits: {
      'acme/app': [
        commit('aaaaaaa111', 'Squashed PR (#1)\n\nbody', '2026-09-01T10:00:00Z', { prStates: ['MERGED'] }),
        commit('bbbbbbb222', 'Pushed straight to main\n\nMore detail', '2026-08-30T09:00:00Z', { additions: 7, deletions: 3 }),
        commit('ccccccc333', 'Merge branch main', '2026-08-30T09:30:00Z', { parents: 2 }),
        commit('ddddddd444', 'In a closed PR, then pushed', '2026-08-29T09:00:00Z', { prStates: ['CLOSED'] }),
        commit('eeeeeee555', 'Rebased from a merged PR', '2026-09-02T09:00:00Z', { prStates: ['OPEN', 'MERGED'] }),
      ],
    },
  });

  const items = await fetchActivity(gh, config);
  assert.deepEqual(
    items.map(({ kind, id, title, time, workTimes }) => ({ kind, id, title, time, workTimes })),
    [
      { kind: 'pr', id: '#1', title: 'Mine', time: '2026-09-01T10:00:00Z', workTimes: ['2026-09-01T08:00:00Z'] },
      { kind: 'pr', id: '#3', title: 'Also mine', time: '2026-09-02T10:00:00Z', workTimes: [] },
      { kind: 'commit', id: 'bbbbbbb', title: 'Pushed straight to main', time: '2026-08-30T09:00:00Z', workTimes: [] },
      { kind: 'commit', id: 'ddddddd', title: 'In a closed PR, then pushed', time: '2026-08-29T09:00:00Z', workTimes: [] },
    ],
  );
  assert.deepEqual(
    items.map(({ additions, deletions }) => [additions, deletions]),
    [[1234, 56], [0, 0], [7, 3], [0, 0]],
  );
  assert.equal(items[2].url, 'https://github.com/acme/app/commit/bbbbbbb222');
  assert.ok(items.every((i) => i.repo === 'acme/app'));
});

test('an empty repository with no default branch contributes nothing', async () => {
  const { gh } = fakeGh({ pullRequests: { 'acme/app': [], 'acme/empty': [] } });
  assert.deepEqual(await fetchActivity(gh, config), []);
});

test('fails clearly for unknown users and inaccessible repos', async () => {
  await assert.rejects(fetchActivity(fakeGh({ login: 'someone' }).gh, config), /GitHub user not found: dev/);
  await assert.rejects(fetchActivity(fakeGh().gh, config), /not found or not accessible: acme\/app/);
});

test('lists the files each change touched, only for repos split into projects', async () => {
  const split = parseConfig({
    title: 'Work',
    author: 'dev',
    repos: ['acme/other', { repo: 'acme/app', projects: [{ name: 'Billing', paths: ['billing/**'] }] }],
  });
  const { gh, calls } = fakeGh({
    filePageSize: 2,
    pullRequests: {
      'acme/app': [
        pr(1, 'Big', '2026-09-01T10:00:00Z', { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'] }),
        pr(2, 'Small', '2026-09-02T10:00:00Z', { files: ['billing/x.ts'] }),
        pr(3, 'Not mine', '2026-09-03T10:00:00Z', { author: 'other', files: ['f.ts', 'g.ts', 'h.ts'] }),
      ],
      'acme/other': [pr(4, 'Elsewhere', '2026-09-01T10:00:00Z', { files: ['z.ts'] })],
    },
    commits: {
      'acme/app': [
        commit('aaaaaaa111', 'Direct', '2026-09-04T10:00:00Z'),
        commit('bbbbbbb222', 'Merge', '2026-09-04T11:00:00Z', { parents: 2 }),
      ],
      'acme/other': [commit('ccccccc333', 'Direct elsewhere', '2026-09-04T10:00:00Z')],
    },
    commitFiles: { 'acme/app': { aaaaaaa111: ['billing/y.ts', 'docs/y.md'] } },
  });

  const items = await fetchActivity(gh, split);
  assert.deepEqual(
    items.map(({ repo, id, files }) => [repo, id, files]),
    [
      ['acme/other', '#4', undefined],
      ['acme/other', 'ccccccc', undefined],
      ['acme/app', '#1', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']],
      ['acme/app', '#2', ['billing/x.ts']],
      ['acme/app', 'aaaaaaa', ['billing/y.ts', 'docs/y.md']],
    ],
  );
  // Only the repo split into projects asks for files: two more pages for the
  // big pull request, and one REST call for the direct commit.
  const queries = calls.filter((call) => call.args[1] === 'graphql').map((call) => call.args[3]);
  assert.equal(queries.filter((query) => query.includes('files(')).length, 3);
  assert.deepEqual(
    calls.filter((call) => call.args[1] === '--paginate').map((call) => call.args[2]),
    ['repos/acme/app/commits/aaaaaaa111'],
  );
  const pages = calls.filter((call) => call.args[3].includes('pullRequest(')).map((call) => call.args.slice(-4));
  assert.deepEqual(pages, [
    ['-F', 'number=1', '-f', 'cursor=2'],
    ['-F', 'number=1', '-f', 'cursor=4'],
  ]);
});

test('surfaces GraphQL errors', async () => {
  const gh = async () => JSON.stringify({ errors: [{ message: 'rate limited' }, { message: 'try later' }] });
  await assert.rejects(graphql(gh, 'query {}', {}), /rate limited; try later/);
});

test('passes variables as strings and leaves out empty ones', async () => {
  let seen;
  const gh = async (args) => {
    seen = args;
    return '{"data":{}}';
  };
  await graphql(gh, 'query', { owner: 'acme', number: 7, cursor: null });
  assert.deepEqual(seen, ['api', 'graphql', '-f', 'query=query', '-f', 'owner=acme', '-F', 'number=7']);
});
