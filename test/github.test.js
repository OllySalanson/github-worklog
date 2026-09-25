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
        pr(1, 'Mine', '2026-09-01T10:00:00Z', { commitTimes: ['2026-09-01T08:00:00Z'] }),
        pr(2, 'Someone else', '2026-09-01T11:00:00Z', { author: 'other' }),
        pr(3, 'Also mine', '2026-09-02T10:00:00Z', { author: 'DEV' }),
      ],
      'acme/empty': [],
    },
    commits: {
      'acme/app': [
        commit('aaaaaaa111', 'Squashed PR (#1)\n\nbody', '2026-09-01T10:00:00Z', { prStates: ['MERGED'] }),
        commit('bbbbbbb222', 'Pushed straight to main\n\nMore detail', '2026-08-30T09:00:00Z'),
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
  await graphql(gh, 'query', { owner: 'acme', cursor: null });
  assert.deepEqual(seen, ['api', 'graphql', '-f', 'query=query', '-f', 'owner=acme']);
});
