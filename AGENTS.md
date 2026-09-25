# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Zero runtime and dev dependencies by design: Node 20+ built-ins only (`node:test`, Web Crypto, `parseArgs`). Test with `npm test`. README's Development table maps each `src/` file to its role.
- Security invariant: the unencrypted page, the config, the activities file and the password must never be written to disk or git, nor printed. `src/cli.js` renders in memory and hands only the output of `lockPage` to `build`/`publish`; keep it that way and keep the tests in `test/cli.test.js` that assert it.
- The lock page must stay generic (no title or owner details): the publishing repo is public, so anything outside the encrypted payload is public.
- `src/unlock-client.js` is inlined verbatim into the lock page and also loaded by the tests via `vm`, so it must stay plain browser script with no imports. It must wait for `DOMContentLoaded` before `document.write`, or a remembered key silently fails to open the page.
- The salt is derived from the author (`saltFor` in `src/lock.js`) so "remember me" survives republishing; the IV is random per build.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
