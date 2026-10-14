import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand, runGh } from './github.js';

export const BRANCH = 'gh-pages';
export const MARKER_FILE = '.github-worklog';
// The other work, encrypted, kept with the page so every rebuild has it.
export const ACTIVITIES_FILE = 'activities.enc.json';

const MARKER_TEXT = 'This branch is published by github-worklog and is replaced on every publish.\n';

// Git over https, authenticated by the GitHub CLI's existing login.
export const runGit = (args, options) =>
  runCommand('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args], options);

export class PublishError extends Error {}

// Replaces the gh-pages branch of `repo` with a single commit holding the
// (already encrypted) page and, when given, the (already encrypted) other
// work, then makes sure GitHub Pages serves that branch.
export async function publish({
  repo,
  lockedHtml,
  lockedActivities,
  force = false,
  remote = `https://github.com/${repo}.git`,
  git = runGit,
  gh = runGh,
  log = () => {},
}) {
  const dir = await mkdtemp(join(tmpdir(), 'github-worklog-'));
  try {
    await git(['init', '--quiet', '--initial-branch', BRANCH], { cwd: dir });

    const existing = await git(['ls-remote', '--heads', remote, BRANCH], { cwd: dir });
    if (existing.trim() && !force) {
      await git(['fetch', '--quiet', '--depth', '1', remote, BRANCH], { cwd: dir });
      try {
        await git(['cat-file', '-e', `FETCH_HEAD:${MARKER_FILE}`], { cwd: dir });
      } catch {
        throw new PublishError(
          `${repo} already has a ${BRANCH} branch that github-worklog did not create. ` +
            'Publishing would replace it. Use --force if that is what you want.',
        );
      }
    }

    await writeFile(join(dir, 'index.html'), lockedHtml);
    await writeFile(join(dir, '.nojekyll'), '');
    await writeFile(join(dir, MARKER_FILE), MARKER_TEXT);
    const files = ['index.html', '.nojekyll', MARKER_FILE];
    if (lockedActivities !== undefined) {
      await writeFile(join(dir, ACTIVITIES_FILE), lockedActivities);
      files.push(ACTIVITIES_FILE);
    }
    await git(['add', ...files], { cwd: dir });
    await git(
      [
        '-c', 'user.name=github-worklog',
        '-c', 'user.email=github-worklog@users.noreply.github.com',
        'commit', '--quiet', '--no-gpg-sign', '-m', 'Publish work log',
      ],
      { cwd: dir },
    );
    log(`Pushing the encrypted ${lockedActivities === undefined ? 'page' : 'page and other work'} to ${repo} (${BRANCH})...`);
    await git(['push', '--quiet', '--force', remote, `HEAD:refs/heads/${BRANCH}`], { cwd: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  return enablePages({ repo, gh, log });
}

// The encrypted other work that the last publish kept with the page in
// `repo`, or null when there is none.
export async function fetchStoredActivities({ repo, remote = `https://github.com/${repo}.git`, git = runGit }) {
  const dir = await mkdtemp(join(tmpdir(), 'github-worklog-'));
  try {
    await git(['init', '--quiet'], { cwd: dir });
    if (!(await git(['ls-remote', '--heads', remote, BRANCH], { cwd: dir })).trim()) return null;
    await git(['fetch', '--quiet', '--depth', '1', remote, BRANCH], { cwd: dir });
    try {
      await git(['cat-file', '-e', `FETCH_HEAD:${ACTIVITIES_FILE}`], { cwd: dir });
    } catch {
      return null;
    }
    return await git(['show', `FETCH_HEAD:${ACTIVITIES_FILE}`], { cwd: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function enablePages({ repo, gh = runGh, log = () => {} }) {
  const source = { branch: BRANCH, path: '/' };
  let site;
  try {
    site = JSON.parse(await gh(['api', `repos/${repo}/pages`]));
  } catch (error) {
    if (!/HTTP 404/.test(error.message)) throw error;
    log('Turning on GitHub Pages...');
    site = JSON.parse(await gh(['api', '-X', 'POST', `repos/${repo}/pages`, '--input', '-'], { input: JSON.stringify({ source }) }));
  }
  if (site.source?.branch !== source.branch || site.source?.path !== source.path) {
    log(`Pointing GitHub Pages at the ${BRANCH} branch...`);
    await gh(['api', '-X', 'PUT', `repos/${repo}/pages`, '--input', '-'], { input: JSON.stringify({ source }) });
  }
  return site.html_url;
}
