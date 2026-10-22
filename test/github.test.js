import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';
import { fetchActivity, graphql, retryingGh } from '../src/github.js';
import { commit, fakeGh, pr } from './helpers.js';

const config = parseConfig({ title: 'Work', author: 'dev', repos: ['acme/app', 'acme/empty'] });

test('lists merged pull requests by the author and direct commits not covered by one', async () => {
  // Brought in by merging someone else's pull request.
  const merged = commit('9999999000', 'From a merge', '2026-09-01T09:00:00Z');
  // The commit of pull request #3 that a rebase merge copied as eeeeeee555.
  const beforeRebase = commit('7777777000', 'Rebased from a merged PR', '2026-09-02T09:00:00Z');
  const { gh } = fakeGh({
    pageSize: 2,
    pullRequests: {
      'acme/app': [
        pr(1, 'Mine', '2026-09-01T10:00:00Z', {
          commitTimes: ['2026-09-01T08:00:00Z'],
          mergeCommit: 'aaaaaaa111',
          additions: 1234,
          deletions: 56,
        }),
        pr(2, 'Someone else', '2026-09-01T11:00:00Z', { author: 'other', commits: [merged] }),
        pr(3, 'Also mine', '2026-09-02T10:00:00Z', { author: 'DEV', commits: [beforeRebase] }),
      ],
      'acme/empty': [],
    },
    commits: {
      'acme/app': [
        commit('aaaaaaa111', 'Squashed PR (#1)\n\nbody', '2026-09-01T10:00:00Z'),
        commit('bbbbbbb222', 'Pushed straight to main\n\nMore detail', '2026-08-30T09:00:00Z', { additions: 7, deletions: 3 }),
        commit('ccccccc333', 'Merge branch main', '2026-08-30T09:30:00Z', { parents: 2 }),
        commit('ddddddd444', 'In a closed PR, then pushed', '2026-08-29T09:00:00Z'),
        commit('eeeeeee555', 'Rebased from a merged PR\n\nbody', '2026-09-02T09:00:00Z'),
        commit('fffffff666', 'Rebased from a merged PR', '2026-09-03T09:00:00Z'),
        merged,
        commit('1111111999', 'First commit', '2026-08-28T09:00:00Z', { parents: 0 }),
      ],
    },
  });

  const items = await fetchActivity(gh, config);
  assert.deepEqual(
    items.map(({ kind, id, title, time, workTimes }) => ({ kind, id, title, time, workTimes })),
    [
      { kind: 'pr', id: '#1', title: 'Mine', time: '2026-09-01T10:00:00Z', workTimes: ['2026-09-01T08:00:00Z'] },
      { kind: 'pr', id: '#3', title: 'Also mine', time: '2026-09-02T10:00:00Z', workTimes: ['2026-09-02T09:00:00Z'] },
      { kind: 'commit', id: 'bbbbbbb', title: 'Pushed straight to main', time: '2026-08-30T09:00:00Z', workTimes: [] },
      { kind: 'commit', id: 'ddddddd', title: 'In a closed PR, then pushed', time: '2026-08-29T09:00:00Z', workTimes: [] },
      { kind: 'commit', id: 'fffffff', title: 'Rebased from a merged PR', time: '2026-09-03T09:00:00Z', workTimes: [] },
      { kind: 'commit', id: '1111111', title: 'First commit', time: '2026-08-28T09:00:00Z', workTimes: [] },
    ],
  );
  assert.deepEqual(
    items.map(({ additions, deletions }) => [additions, deletions]),
    [[1234, 56], [0, 0], [7, 3], [0, 0], [0, 0], [0, 0]],
  );
  assert.equal(items[2].url, 'https://github.com/acme/app/commit/bbbbbbb222');
  assert.ok(items.every((i) => i.repo === 'acme/app'));
});

test('reads every commit of a pull request with more than one page of them', async () => {
  const times = ['2026-09-01T01:00:00Z', '2026-09-01T02:00:00Z', '2026-09-01T03:00:00Z', '2026-09-01T04:00:00Z', '2026-09-01T05:00:00Z'];
  const last = commit('5555555000', 'Last of many', '2026-09-01T06:00:00Z');
  const { gh, calls } = fakeGh({
    commitPageSize: 2,
    pullRequests: {
      'acme/app': [pr(1, 'Long', '2026-09-01T10:00:00Z', { commitTimes: times, commits: [last] })],
      'acme/empty': [],
    },
    commits: { 'acme/app': [last] },
  });

  const items = await fetchActivity(gh, config);
  // The last commit came on the third page, so it is not listed again as a
  // direct commit.
  assert.deepEqual(
    items.map(({ id, workTimes }) => [id, workTimes]),
    [['#1', ['2026-09-01T06:00:00Z', ...times]]],
  );
  const pages = calls.filter((call) => call.args[3].includes('pullRequest(')).map((call) => call.args.slice(-4));
  assert.deepEqual(pages, [
    ['-F', 'number=1', '-f', 'cursor=2'],
    ['-F', 'number=1', '-f', 'cursor=4'],
  ]);
});

test('does not ask GitHub which pull requests a commit belongs to', async () => {
  const { gh, calls } = fakeGh({ pullRequests: { 'acme/app': [], 'acme/empty': [] } });
  await fetchActivity(gh, config);
  assert.ok(calls.every((call) => !call.args.join(' ').includes('associatedPullRequests')));
});

test('an empty repository with no default branch contributes nothing', async () => {
  const { gh } = fakeGh({ pullRequests: { 'acme/app': [], 'acme/empty': [] } });
  assert.deepEqual(await fetchActivity(gh, config), []);
});

test('fails clearly for unknown users and inaccessible repos', async () => {
  await assert.rejects(fetchActivity(fakeGh({ login: 'someone' }).gh, config), /GitHub user not found: dev/);
  await assert.rejects(fetchActivity(fakeGh().gh, config), /not found or not accessible: acme\/app/);
});

test('lists the files and branch of each change, only for repos split into projects', async () => {
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
    items.map(({ repo, id, files, branch }) => [repo, id, files, branch]),
    [
      ['acme/other', '#4', undefined, undefined],
      ['acme/other', 'ccccccc', undefined, undefined],
      ['acme/app', '#1', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], 'work-1'],
      ['acme/app', '#2', ['billing/x.ts'], 'work-2'],
      ['acme/app', 'aaaaaaa', ['billing/y.ts', 'docs/y.md'], undefined],
    ],
  );
  // Only the repo split into projects asks for files: two more pages for the
  // big pull request, and one REST call for the direct commit.
  const queries = calls.filter((call) => call.args[1] === 'graphql').map((call) => call.args[3]);
  assert.equal(queries.filter((query) => query.includes('files(')).length, 3);
  assert.equal(queries.filter((query) => query.includes('headRefName')).length, 1);
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

const SOMETHING_WENT_WRONG =
  'gh failed: gh: Something went wrong while executing your query on 2026-10-22T13:43:20Z. Please include `0D86:BA840` when reporting this issue.';

// A gh that fails with each of failures in turn, then answers.
function flakyGh(failures) {
  const calls = [];
  const gh = async (args) => {
    calls.push(args);
    if (calls.length <= failures.length) throw new Error(failures[calls.length - 1]);
    return 'answer';
  };
  return { gh, calls };
}

test('asks again, waiting longer each time, when GitHub fails in a way that comes and goes', async () => {
  for (const failure of [
    SOMETHING_WENT_WRONG,
    'gh failed: HTTP 502: Bad Gateway (https://api.github.com/graphql)',
    "gh failed: We couldn't respond to your request in time. Sorry about that.",
    'gh failed: Post "https://api.github.com/graphql": read tcp: connection reset by peer: ECONNRESET',
  ]) {
    const { gh, calls } = flakyGh([failure, failure]);
    const waits = [];
    const retrying = retryingGh(gh, { sleep: async (ms) => waits.push(ms) });
    assert.equal(await retrying(['api', 'graphql']), 'answer');
    assert.equal(calls.length, 3);
    assert.deepEqual(waits, [1000, 2000]);
  }
});

test('gives up clearly when GitHub keeps failing', async () => {
  const { gh, calls } = flakyGh(Array(10).fill(SOMETHING_WENT_WRONG));
  const waits = [];
  const retrying = retryingGh(gh, { delays: [10, 20, 40], sleep: async (ms) => waits.push(ms) });
  await assert.rejects(retrying(['api', 'graphql']), /Something went wrong.*\(GitHub failed 4 times in a row; try again later\)$/);
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [10, 20, 40]);
});

test('does not ask again when the failure will not go away', async () => {
  const { gh, calls } = flakyGh(['gh failed: Could not resolve to a Repository with the name acme/gone.', 'unused']);
  const retrying = retryingGh(gh, { sleep: async () => assert.fail('should not wait') });
  await assert.rejects(retrying(['api', 'graphql']), /Could not resolve/);
  assert.equal(calls.length, 1);
});

test('reads activity through a flaky GitHub', async () => {
  const { gh: fake } = fakeGh({
    pullRequests: { 'acme/app': [pr(1, 'Mine', '2026-09-01T10:00:00Z')], 'acme/empty': [] },
  });
  let count = 0;
  const gh = async (args, options) => {
    if (++count % 2 === 1) throw new Error(SOMETHING_WENT_WRONG);
    return fake(args, options);
  };
  const items = await fetchActivity(gh, config, { sleep: async () => {} });
  assert.deepEqual(
    items.map(({ id }) => id),
    ['#1'],
  );
});
