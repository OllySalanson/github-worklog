import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { enablePages, MARKER_FILE, publish } from '../src/publish.js';
import { fakeGh } from './helpers.js';

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function bareRemote() {
  const dir = await mkdtemp(join(tmpdir(), 'worklog-remote-'));
  git(['init', '--quiet', '--bare', dir]);
  return dir;
}

const branchFiles = (remote) => git(['ls-tree', '--name-only', 'gh-pages'], remote).trim().split('\n').sort();

test('publishes one commit holding only the page to gh-pages, replacing the previous one', async () => {
  const remote = await bareRemote();
  const { gh, state } = fakeGh();
  const url = await publish({ repo: 'dev/site', lockedHtml: 'locked one', remote, gh });
  assert.equal(url, 'https://dev.github.io/site/');
  assert.deepEqual(state.pages.source, { branch: 'gh-pages', path: '/' });
  assert.deepEqual(branchFiles(remote), ['.github-worklog', '.nojekyll', 'index.html']);

  await publish({ repo: 'dev/site', lockedHtml: 'locked two', remote, gh });
  assert.equal(git(['show', 'gh-pages:index.html'], remote), 'locked two');
  // Old versions do not pile up in history.
  assert.equal(git(['rev-list', '--count', 'gh-pages'], remote).trim(), '1');
});

test('refuses to replace a gh-pages branch it did not create unless forced', async () => {
  const remote = await bareRemote();
  const work = await mkdtemp(join(tmpdir(), 'worklog-work-'));
  git(['init', '--quiet', '--initial-branch', 'gh-pages', work]);
  await writeFile(join(work, 'index.html'), 'someone else');
  git(['add', '.'], work);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'theirs'], work);
  git(['push', '--quiet', remote, 'gh-pages'], work);

  const { gh } = fakeGh({ pages: { html_url: 'https://dev.github.io/site/', source: { branch: 'gh-pages', path: '/' } } });
  await assert.rejects(publish({ repo: 'dev/site', lockedHtml: 'mine', remote, gh }), /did not create[\s\S]*--force/);
  assert.equal(git(['show', 'gh-pages:index.html'], remote), 'someone else');

  await publish({ repo: 'dev/site', lockedHtml: 'mine', remote, gh, force: true });
  assert.equal(git(['show', 'gh-pages:index.html'], remote), 'mine');
  assert.ok(branchFiles(remote).includes(MARKER_FILE));
});

test('enablePages leaves a correctly set up site alone and repoints one that serves another branch', async () => {
  const good = fakeGh({ pages: { html_url: 'https://a/', source: { branch: 'gh-pages', path: '/' } } });
  assert.equal(await enablePages({ repo: 'dev/site', gh: good.gh }), 'https://a/');
  assert.equal(good.calls.length, 1);

  const other = fakeGh({ pages: { html_url: 'https://b/', source: { branch: 'main', path: '/docs' } } });
  assert.equal(await enablePages({ repo: 'dev/site', gh: other.gh }), 'https://b/');
  assert.deepEqual(other.calls[1].args, ['api', '-X', 'PUT', 'repos/dev/site/pages', '--input', '-']);
  assert.deepEqual(JSON.parse(other.calls[1].input), { source: { branch: 'gh-pages', path: '/' } });
});

test('enablePages passes on errors other than "not set up yet"', async () => {
  const gh = async () => {
    throw new Error('gh failed: Forbidden (HTTP 403)');
  };
  await assert.rejects(enablePages({ repo: 'dev/site', gh }), /HTTP 403/);
});
