# github-worklog

Turn your GitHub activity into a simple daily record of work.

github-worklog reads the pull requests and commits you made in the repositories you choose, groups them by day, and publishes one clean, password-protected web page on GitHub Pages. It is meant to replace a hand-kept "what I did today" file: you, your manager or your client can open one address and see what was done each day, newest first.

- **Per day:** the plain-English title of every merged pull request, grouped by project, each linking to GitHub. Commits pushed straight to the default branch (common before a project starts using pull requests) are listed too.
- **Activity times:** the first and last GitHub activity each day. These are clearly labelled as activity times, not hours worked.
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

5. **Refresh it** whenever you like by running the same command again. It always rebuilds the whole history from GitHub, so there is nothing to keep in sync. To refresh on a schedule, put the command in `cron` or a scheduled task.

To check the page before publishing, `build` writes the same encrypted page to a local file instead. Open it in a browser and unlock it with your password:

```sh
npx github:OllySalanson/github-worklog build \
  --config ~/.config/github-worklog/work.json \
  --password-file ~/.config/github-worklog/password \
  --out worklog.html
```

You can also clone this repository and run `node bin/github-worklog.js` with the same arguments.

## Config

| Key | Required | Meaning |
| --- | --- | --- |
| `title` | yes | Heading and browser tab title of the unlocked page. |
| `author` | yes | GitHub username whose work to show. Only pull requests opened by, and commits linked to, this account are listed. |
| `repos` | yes | Repositories to include, as `"owner/repo"` or `{ "repo": "owner/repo", "name": "Shown name" }`. Without a `name`, `acme-co/warehouse-app` is shown as "Warehouse App". Projects appear in this order within each day. |
| `publishTo` | no | Repository to publish to, as `owner/repo`. `--repo` on the command line overrides it. |
| `timeZone` | no | [Time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) used to split days and show times. Defaults to `Europe/London`. |
| `since` | no | First day to include, as `YYYY-MM-DD`. Defaults to the whole history of every repository. |

## What counts as work

- **Merged pull requests** by the author, on any branch, dated by when they were merged. Titles are tidied into plain English: `fix(calc): stop double counting (#12)` becomes "Stop double counting".
- **Direct commits** by the author on each repository's default branch that are not part of a merged pull request, dated by when they were written. Merge commits are skipped.
- **Activity times** for a day run from the earliest to the latest of those events, also counting the commits inside that day's pull requests. They show when work happened on GitHub. They do not show breaks, meetings, or work that never reached GitHub, so they are not hours worked.

Commits are matched to the author through their GitHub account, so commits made with an email address not linked to that account are not counted.

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
| [src/worklog.js](src/worklog.js) | Groups activity into days and tidies titles. |
| [src/render.js](src/render.js) | Renders the page. |
| [src/lock.js](src/lock.js), [src/unlock-client.js](src/unlock-client.js) | Encrypts the page and builds the lock screen that decrypts it. |
| [src/publish.js](src/publish.js) | Pushes to `gh-pages` and turns on GitHub Pages. |

## License

[MIT](LICENSE)
