# github-worklog

Turn your GitHub activity into a simple daily record of work.

github-worklog reads the pull requests and commits you made in the repositories you choose, groups them by day, and publishes one clean, password-protected web page on GitHub Pages. It is meant to replace a hand-kept "what I did today" file: you, your manager or your client can open one address and see what was done each day, newest first.

- **Per day:** the plain-English title of every merged pull request, grouped by project, each linking to GitHub. Commits pushed straight to the default branch (common before a project starts using pull requests) are listed too.
- **Day totals:** at the top of each day, the number of tasks completed (code changes plus other work) and the lines of code added and removed, shown the way GitHub shows them: a green `+1,234` and a red `-567`.
- **Activity times:** the first and last recorded activity each day, from GitHub and from any times given for other work. These are clearly labelled as activity times, not hours worked.
- **Other work:** optionally, work that never becomes code, such as planning, reviews, testing and setting things up, listed under the day it happened from a private file you keep.
- **Private:** the page is encrypted with your password before it leaves your machine. Only the encrypted page is ever published.
- **Simple:** one static page that works on a phone, follows the light or dark setting, and loads nothing from anywhere else. No framework, no tracking, no runtime dependencies.

## How to use it

You need [Node.js](https://nodejs.org) 20 or newer, `git`, and the [GitHub CLI](https://cli.github.com) logged in (`gh auth login`) as an account that can read the repositories. github-worklog uses that existing login; it never asks for a token.

1. **Make a repository to host the page.** A new, empty, public repository is fine (for example `your-name/github-worklog`). GitHub Pages on a free account needs a public repository; the page itself stays encrypted. The repositories you report on can be private.

2. **Write a config file** somewhere private, outside any git repository, for example `~/.config/github-worklog/work.json`:

   ```json
   {
     "title": "Acme Co - record of work",
     "author": "your-github-username",
     "publishTo": "your-github-username/github-worklog",
     "repos": [
       "acme-co/storefront",
       { "repo": "acme-co/warehouse-app", "name": "Warehouse" }
     ]
   }
   ```

   There is a fuller example in [examples/worklog.example.json](examples/worklog.example.json).

3. **Save the password in a file** that only you can read. Use a long one (see [How the password lock works](#how-the-password-lock-works)):

   ```sh
   mkdir -p ~/.config/github-worklog
   printf '%s\n' 'several random words make a strong passphrase' > ~/.config/github-worklog/password
   chmod 600 ~/.config/github-worklog/password
   ```

4. **Publish:**

   ```sh
   npx github:OllySalanson/github-worklog publish \
     --config ~/.config/github-worklog/work.json \
     --password-file ~/.config/github-worklog/password
   ```

   The first publish turns on GitHub Pages for the repository. The page appears at `https://<owner>.github.io/<repo>/` within a minute or two.

5. **Refresh it** whenever you like by running the same command again. It always rebuilds the whole history from GitHub, so there is nothing to keep in sync. To refresh on a schedule without your computer, see [Publish every evening with GitHub Actions](#publish-every-evening-with-github-actions).

To check the page before publishing, `build` writes the same encrypted page to a local file instead. Open it in a browser and unlock it with your password:

```sh
npx github:OllySalanson/github-worklog build \
  --config ~/.config/github-worklog/work.json \
  --password-file ~/.config/github-worklog/password \
  --out worklog.html
```

You can also clone this repository and run `node bin/github-worklog.js` with the same arguments.

## Publish every evening with GitHub Actions

The [Publish work log](.github/workflows/publish.yml) workflow rebuilds and publishes the page every evening at 22:00 UK time, so it stays up to date even when your computer is off. You can also run it by hand from the **Actions** tab (**Publish work log**, then **Run workflow**). It publishes to the repository it runs in, exactly as `publish` does from your machine, so it needs to live in the repository that hosts the page: fork this repository and use the fork as your publishing repository, or copy the workflow and the code into yours.

GitHub's schedules run in UTC, so the workflow is scheduled at both 21:00 and 22:00 UTC, and only the run that is 22:00 in London goes ahead (21:00 UTC during British Summer Time, 22:00 UTC in winter). GitHub can start scheduled runs some minutes late when it is busy. To use another time or time zone, change the `cron` lines and the check in the **When** step.

1. **Turn on GitHub Pages first**, either by running `publish` once from your machine or under **Settings > Pages** (deploy from the `gh-pages` branch). The workflow's own token can update the page but is not allowed to switch Pages on.

2. **Make a read-only token** for reading your repositories. On GitHub, go to **Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token**, and choose:

   | Setting | Value |
   | --- | --- |
   | Resource owner | The account or organization that owns the repositories in your config. A token covers one owner, so every repository in `repos` must belong to it. An organization may need to approve the token. |
   | Expiration | Up to a year. Set a reminder: when it expires, the evening runs fail until you replace the secret. |
   | Repository access | **Only select repositories**: exactly the ones listed in `repos`. |
   | Repository permissions | **Contents: Read-only** and **Pull requests: Read-only**. **Metadata: Read-only** is added automatically. Nothing else. |

3. **Add the repository secrets** under **Settings > Secrets and variables > Actions** of the publishing repository, or with the GitHub CLI. Reading each value from a file keeps it out of your shell history and screen:

   | Secret | Required | What it holds |
   | --- | --- | --- |
   | `WORKLOG_TOKEN` | yes | The fine-grained token from step 2. |
   | `WORKLOG_PASSWORD` | yes | The page password. |
   | `WORKLOG_CONFIG` | yes | The whole [config](#config) file. Its `publishTo` and `activities` are ignored here. |
   | `WORKLOG_ACTIVITIES` | no | The whole [other work](#other-work) file. Leave it unset for no other work. |

   ```sh
   gh secret set WORKLOG_TOKEN --repo your-name/github-worklog < token-file
   gh secret set WORKLOG_PASSWORD --repo your-name/github-worklog < ~/.config/github-worklog/password
   gh secret set WORKLOG_CONFIG --repo your-name/github-worklog < ~/.config/github-worklog/work.json
   gh secret set WORKLOG_ACTIVITIES --repo your-name/github-worklog < ~/.config/github-worklog/activities.json
   ```

   Secrets are not shared with forks, and a repository without `WORKLOG_CONFIG` skips the run with a note.

4. **Run it once by hand** from the **Actions** tab and check the page still unlocks.

The workflow is careful with what it is given:

- The secrets only ever live in environment variables and reach github-worklog through pipes, so nothing private is written to the runner's disk, cached or kept as an artifact. Only the encrypted page leaves the run, as it does from your machine.
- GitHub hides secrets in the run's log. It cannot recognise the separate parts of a JSON secret, so the workflow also hides every private text value in the config and other work (titles, names, repositories and descriptions) before running anything.
- Reading uses your read-only token. Publishing uses the run's own `GITHUB_TOKEN`, which can only write to this repository (`contents: write`) and read its Pages setting (`pages: read`).
- Because your other work now comes from the `WORKLOG_ACTIVITIES` secret, update that secret when you add to your local file, or the evening run shows the older list.

## Config

| Key | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Heading and browser tab title of the unlocked page. |
| `author` | yes | GitHub username whose work to show. Only pull requests opened by, and commits linked to, this account are listed. |
| `repos` | yes | Repositories to include, as `"owner/repo"` or `{ "repo": "owner/repo", "name": "Shown name" }`. Without a `name`, `acme-co/warehouse-app` is shown as "Warehouse App". Projects appear in this order within each day. |
| `publishTo` | no | Repository to publish to, as `owner/repo`. `--repo` on the command line overrides it. |
| `timeZone` | no | [Time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) used to split days and show times. Defaults to `Europe/London`. |
| `since` | no | First day to include, as `YYYY-MM-DD`. Defaults to the whole history of every repository. |
| `activities` | no | Path to a private file of [other work](#other-work) to show alongside the code changes. A relative path is relative to the config file. `--activities` on the command line overrides it. |

## What counts as work

- **Merged pull requests** by the author, on any branch, dated by when they were merged. Titles are tidied into plain English: `fix(calc): stop double counting (#12)` becomes "Stop double counting".
- **Direct commits** by the author on each repository's default branch that are not part of a merged pull request, dated by when they were written. Merge commits are skipped.
- **Day totals** count every change listed that day as one task completed. Lines added and removed are the sum of each change's additions and deletions as GitHub reports them: the whole pull request for a pull request, or the commit's own diff for a direct commit. They come in the same GitHub requests as the changes themselves, so they add no extra calls.
- **Activity times** for a day run from the earliest to the latest of those events, also counting the commits inside that day's pull requests. They show when work happened on GitHub. They do not show breaks, meetings, or work that never reached GitHub, so they are not hours worked.

Commits are matched to the author through their GitHub account, so commits made with an email address not linked to that account are not counted.

## Other work

Much of the work behind a project never reaches GitHub: planning the next stages, reviewing bug reports, running test rounds, switching things on for real. To show it, keep a private JSON file next to your config and name it in `"activities"`. Each entry is one plain line under the day it happened:

```json
[
  { "date": "2026-09-22", "project": "Warehouse", "kind": "reviewing", "text": "reviewed all 28 staff bug reports" },
  { "date": "2026-09-24", "project": "Warehouse", "kind": "setting-up", "text": "switched on the staff page and its welcome email" }
]
```

| Key | Meaning |
| --- | --- |
| `date` | The day it happened, as `YYYY-MM-DD`. |
| `project` | Shown before the line, as in "Warehouse: reviewed all 28 staff bug reports". Any name works; it does not have to be one of the `repos`. |
| `kind` | One of `planning`, `reviewing`, `testing`, `setting-up` or `other`, shown as a small label: Planning, Reviewing, Testing, Setting up or Other. |
| `text` | What the time was spent on, in plain words. |
| `start` | Optional. When it started, as an ISO time with its offset, such as `2026-09-24T14:05:00+01:00`. |
| `end` | Optional. When it finished, in the same form. It cannot be before `start`. |

There is a fuller example in [examples/activities.example.json](examples/activities.example.json).

Each day lists its other work in an **Other work** group after the code changes, in the order of the file. Each piece of other work counts as a task completed, but never towards lines of code. Its `start` and `end` times, when given, count towards the day's first and last activity times, as long as they fall on its `date`. A day with only other work still appears, with its task count, no line totals, and activity times only if its entries have them. Like the config, the file is read on your machine and only ever published inside the encrypted page, so keep it out of git.

## How the password lock works

github-worklog renders the page in memory and encrypts it before anything is written anywhere:

- The key is derived from your password with PBKDF2-HMAC-SHA256 at 600,000 iterations, and the page is encrypted with AES-256-GCM using a fresh random IV each time. This is the same approach as [StatiCrypt](https://github.com/robinmoisson/staticrypt), using only the Web Crypto API built into Node and every modern browser.
- The published page is a small lock screen plus the encrypted data. It says nothing about whose page it is or what is inside; even the title is encrypted.
- Unlocking happens entirely in the browser. The password is never sent anywhere.
- **Remember me on this device** saves the derived key (not the password) in the browser's local storage, so that device opens the page straight away, even after you refresh it. The **Lock** button on the page forgets it again. Changing the password makes every remembered device ask again.
- The password is read from a file, never printed or logged, and never passed on the command line, so it does not end up in your shell history.

**What is published:** the `gh-pages` branch of the publishing repository holds exactly one commit with three files: the encrypted `index.html`, an empty `.nojekyll`, and a `.github-worklog` marker. Each publish replaces that commit, so old versions do not build up. Your config, your password and the unencrypted page never enter git on any branch. To protect a `gh-pages` branch you already use for something else, github-worklog refuses to replace one it did not create unless you pass `--force`.

### Limits

- **Anyone can download the encrypted page and try passwords offline, as fast as their hardware allows**, with no lockout. The iteration count slows each guess down, but only a long password keeps the page safe. Use at least 12 characters; four or more random words is better. github-worklog warns when the password is shorter than 12 characters.
- Anyone who has the password can see everything on the page, and can copy it. To take away someone's access, change the password and publish again.
- A device that chose "remember me" keeps access until someone presses **Lock** on it, the password changes, or its browser data is cleared.
- The address of the page, and the fact that it exists, are public. Only the contents are protected.
- This protects a status page from casual and curious visitors. It is not a place for secrets such as credentials or personal data.

## Development

```sh
npm test
```

The tests use Node's built-in test runner and need no installs. They run the same unlock script the browser uses, and publish to a local bare git repository instead of GitHub.

| File | Role |
| --- | --- |
| [src/cli.js](src/cli.js) | Command line: `build` and `publish`. |
| [src/config.js](src/config.js) | Reads and checks the config and password files. |
| [src/github.js](src/github.js) | Fetches pull requests and commits through `gh api graphql`. |
| [src/activities.js](src/activities.js) | Reads and checks the optional file of other work. |
| [src/worklog.js](src/worklog.js) | Groups activity and other work into days and tidies titles. |
| [src/render.js](src/render.js) | Renders the page. |
| [src/lock.js](src/lock.js), [src/unlock-client.js](src/unlock-client.js) | Encrypts the page and builds the lock screen that decrypts it. |
| [src/publish.js](src/publish.js) | Pushes to `gh-pages` and turns on GitHub Pages. |
| [.github/workflows/publish.yml](.github/workflows/publish.yml) | Publishes every evening from GitHub Actions. |

## License

[MIT](LICENSE)
