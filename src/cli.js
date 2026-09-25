import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadActivities } from './activities.js';
import { ConfigError, loadConfig, readPassword } from './config.js';
import { fetchActivity, runGh } from './github.js';
import { lockPage } from './lock.js';
import { PublishError, publish, runGit } from './publish.js';
import { pageSummary, renderPage } from './render.js';
import { buildDays } from './worklog.js';

export const USAGE = `Usage:
  github-worklog build   --config <file> --password-file <file> [--activities <file>] [--out <file>]
  github-worklog publish --config <file> --password-file <file> [--activities <file>] [--repo <owner/repo>] [--force]

Commands:
  build     Write the password-protected page to a local file (default: worklog.html).
  publish   Push the password-protected page to the gh-pages branch of a repo
            and turn on GitHub Pages for it.

Options:
  --config <file>         JSON config: title, author, repos (see README).
  --password-file <file>  File holding the password. The password is never printed.
  --activities <file>     File of other work, in place of "activities" in the config.
  --out <file>            build only: where to write the page.
  --repo <owner/repo>     publish only: where to publish (default: "publishTo" in the config).
  --force                 publish only: replace a gh-pages branch github-worklog did not create.
  -h, --help              Show this help.

Environment:
  GITHUB_WORKLOG_PUBLISH_TOKEN  publish only: push and set up GitHub Pages with this
                                token instead of the GitHub CLI's login. Reading
                                activity still uses the GitHub CLI's login.
`;

const MIN_PASSWORD_LENGTH = 12;

export async function run(
  argv,
  { gh = runGh, git = runGit, env = process.env, out = console.log, err = console.error, now = () => new Date() } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'password-file': { type: 'string' },
        activities: { type: 'string' },
        out: { type: 'string' },
        repo: { type: 'string' },
        force: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    err(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help || !command) {
    (values.help ? out : err)(USAGE);
    return values.help ? 0 : 2;
  }
  if (!['build', 'publish'].includes(command) || positionals.length > 1) {
    err(`Unknown command: ${positionals.join(' ')}\n\n${USAGE}`);
    return 2;
  }
  if (!values.config || !values['password-file']) {
    err(`Both --config and --password-file are required.\n\n${USAGE}`);
    return 2;
  }

  try {
    const config = await loadConfig(values.config);
    const activitiesPath = values.activities ?? config.activities;
    const activities = activitiesPath ? await loadActivities(activitiesPath) : [];
    const password = await readPassword(values['password-file']);
    if (password.length < MIN_PASSWORD_LENGTH) {
      err(`Warning: the password is shorter than ${MIN_PASSWORD_LENGTH} characters, so the page is easier to crack offline.`);
    }

    let repo = null;
    if (command === 'publish') {
      repo = values.repo ?? config.publishTo;
      if (!repo || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
        err('publish needs --repo <owner/repo> or "publishTo" in the config.');
        return 2;
      }
    }

    out(`Reading GitHub activity for ${config.author} in ${config.repos.length} repos...`);
    const items = await fetchActivity(gh, config);
    const days = buildDays(items, config, activities);
    const html = renderPage({ title: config.title, days, generatedAt: now(), timeZone: config.timeZone });
    // Only the encrypted page ever leaves memory.
    const locked = await lockPage(html, password, { author: config.author });
    out(`Found ${pageSummary(days)}.`);

    if (command === 'build') {
      const path = values.out ?? 'worklog.html';
      await writeFile(path, locked);
      out(`Wrote the password-protected page to ${path}`);
    } else {
      const token = env.GITHUB_WORKLOG_PUBLISH_TOKEN;
      const publishing = token ? { git: withToken(git, env, token), gh: withToken(gh, env, token) } : { git, gh };
      const url = await publish({ repo, lockedHtml: locked, force: values.force, ...publishing, log: out });
      out(`Published. It can take a minute to update at ${url ?? `the GitHub Pages address of ${repo}`}`);
    }
    return 0;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof PublishError) {
      err(error.message);
      return 1;
    }
    err(`Failed: ${error.message}`);
    return 1;
  }
}

// Runs git or gh as the given token: gh reads GH_TOKEN, and git's credential
// helper is gh itself.
const withToken = (command, env, token) => (args, options = {}) =>
  command(args, { ...options, env: { ...env, GH_TOKEN: token } });
