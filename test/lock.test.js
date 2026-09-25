import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { encrypt, ITERATIONS, lockPage, saltFor } from '../src/lock.js';

// Load the exact script the browser runs so the tests decrypt with it.
vm.runInThisContext(readFileSync(new URL('../src/unlock-client.js', import.meta.url), 'utf8'));
const { deriveKey, decrypt } = globalThis.githubWorklogUnlock;

const payloadOf = (page) => JSON.parse(page.match(/<script type="application\/json" id="payload">(.*?)<\/script>/)[1]);
const SECRET = '<!doctype html><title>Acme secret plans</title><p>Café ☕ launch</p>';

test('the page script decrypts with the right password and rejects a wrong one', async () => {
  const page = await lockPage(SECRET, 'correct horse battery staple', { author: 'dev', iterations: 1000 });
  const payload = payloadOf(page);
  assert.equal(await decrypt(await deriveKey('correct horse battery staple', payload), payload), SECRET);
  await assert.rejects(decrypt(await deriveKey('correct horse battery stapl', payload), payload));
});

test('the lock page gives nothing away', async () => {
  const password = 'quiet otter lantern';
  const page = await lockPage(SECRET, password, { author: 'dev', iterations: 1000 });
  // The random base64 payload could spell anything, so check the rest of the page.
  const visible = page.replace(/<script type="application\/json" id="payload">[^<]*<\/script>/, '');
  assert.notEqual(visible, page);
  assert.doesNotMatch(visible, /Acme|secret|launch/);
  assert.ok(!page.includes(password));
  assert.match(page, /<title>Work log<\/title>/);
  assert.match(page, /Remember me on this device/);
  assert.match(page, /autocomplete="current-password"/);
});

test('uses AES-256-GCM with PBKDF2-SHA256 at 600,000 iterations by default', async () => {
  assert.equal(ITERATIONS, 600_000);
  const payload = payloadOf(await lockPage('x', 'pw', { author: 'dev' }));
  assert.equal(payload.v, 1);
  assert.equal(payload.iterations, 600_000);
  assert.equal(Buffer.from(payload.salt, 'base64').length, 16);
  assert.equal(Buffer.from(payload.iv, 'base64').length, 12);
  // One byte of plaintext plus the 16 byte GCM tag.
  assert.equal(Buffer.from(payload.data, 'base64').length, 17);
});

test('keeps the salt per author so remembered devices survive a refresh, with a fresh IV each time', async () => {
  const salt = await saltFor('Dev');
  const first = await encrypt('same', 'pw', { salt, iterations: 1000 });
  const second = await encrypt('same', 'pw', { salt, iterations: 1000 });
  assert.equal(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
  assert.deepEqual(await saltFor('dev'), salt);
  assert.notDeepEqual(await saltFor('someone-else'), salt);

  // A key remembered from the first build opens the second.
  const key = await deriveKey('pw', first);
  assert.equal(await decrypt(key, second), 'same');
});
