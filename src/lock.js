import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { BASE_STYLES } from './render.js';

const { subtle } = webcrypto;

// OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256.
export const ITERATIONS = 600_000;

const CLIENT_SCRIPT = readFileSync(new URL('./unlock-client.js', import.meta.url), 'utf8');

const LOCK_STYLES = `
main { padding-top: 18vh; max-width: 24rem; }
h1 { font-size: 1.4rem; margin: 0 0 .35rem; }
p { color: var(--muted); margin: 0 0 1.25rem; }
form { display: grid; gap: .8rem; }
form[hidden] { display: none; }
input[type=password] {
  font: inherit;
  width: 100%;
  padding: .7rem .8rem;
  border: 1px solid var(--border);
  border-radius: .5rem;
  background: var(--surface);
  color: var(--text);
}
input[type=password]:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
label.remember { display: flex; align-items: center; gap: .5rem; color: var(--muted); font-size: .95rem; }
label.remember input { width: 1.05rem; height: 1.05rem; margin: 0; accent-color: var(--accent); }
.unlock {
  padding: .7rem;
  border: 0;
  border-radius: .5rem;
  background: var(--accent);
  color: var(--bg);
  font-weight: 600;
  cursor: pointer;
}
.unlock:disabled { opacity: .6; cursor: progress; }
.message { min-height: 1.5em; margin: .8rem 0 0; font-size: .95rem; color: var(--muted); }
.message.error { color: var(--danger); }
`;

const toBase64 = (bytes) => Buffer.from(bytes).toString('base64');
const fromBase64 = (text) => new Uint8Array(Buffer.from(text, 'base64'));

// Marks the file of other work that publish stores, encrypted, with the page.
export const STORED_ACTIVITIES_FORMAT = 'github-worklog activities';

// A stable salt per author keeps "remember me" working across refreshes,
// while a fresh random IV on every build keeps AES-GCM safe.
export async function saltFor(author) {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(`github-worklog salt v1:${author.toLowerCase()}`));
  return new Uint8Array(digest).slice(0, 16);
}

async function deriveKey(password, salt, iterations, usage) {
  const material = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

export async function encrypt(plaintext, password, { salt, iterations = ITERATIONS }) {
  const key = await deriveKey(password, salt, iterations, 'encrypt');
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  return { v: 1, iterations, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

// Rejects when the password is wrong or the data was changed.
export async function decrypt(payload, password) {
  const key = await deriveKey(password, fromBase64(payload.salt), payload.iterations, 'decrypt');
  const data = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(payload.iv) }, key, fromBase64(payload.data));
  return new TextDecoder().decode(data);
}

// The lock page deliberately says nothing about whose page it is: everything
// specific, including the title, is inside the encrypted payload.
export function renderLockPage(payload) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Work log</title>
<style>${BASE_STYLES}${LOCK_STYLES}</style>
</head>
<body>
<main>
<h1>Work log</h1>
<p>This page is private. Enter the password to see it.</p>
<form id="unlock" hidden>
<input type="password" id="password" name="password" autocomplete="current-password" aria-label="Password" placeholder="Password" required>
<label class="remember"><input type="checkbox" id="remember"> Remember me on this device</label>
<button type="submit" class="unlock">Unlock</button>
</form>
<p class="message" id="message" role="status" aria-live="polite"></p>
<noscript><p>Please turn on JavaScript to unlock this page.</p></noscript>
</main>
<script type="application/json" id="payload">${JSON.stringify(payload)}</script>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>
`;
}

export async function lockPage(html, password, { author, iterations } = {}) {
  const payload = await encrypt(html, password, { salt: await saltFor(author), iterations });
  return renderLockPage(payload);
}

// The other work, encrypted with the page password, for publish to keep with
// the page so a rebuild elsewhere (such as the evening run in GitHub Actions)
// has every entry. Nothing needs to remember this key, so the salt is random.
export async function lockActivities(activities, password, { iterations } = {}) {
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const payload = await encrypt(JSON.stringify(activities), password, { salt, iterations });
  return `${JSON.stringify({ format: STORED_ACTIVITIES_FORMAT, ...payload })}\n`;
}

// The list stored by lockActivities, still to be checked by parseActivities.
// Rejects when the password is not the one it was stored with.
export async function unlockActivities(text, password) {
  const payload = JSON.parse(text);
  if (payload?.format !== STORED_ACTIVITIES_FORMAT || payload.v !== 1) throw new Error('not stored by github-worklog');
  return JSON.parse(await decrypt(payload, password));
}
