// Runs in the browser on the lock page. It is inlined into the page as-is, so
// it must stay plain, dependency-free script. The tests load it in Node too.
(function () {
  'use strict';

  var STORAGE_PREFIX = 'github-worklog:';

  function fromBase64(text) {
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function toBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  async function deriveKey(password, payload) {
    var material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
      'deriveKey',
    ]);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64(payload.salt), iterations: payload.iterations },
      material,
      { name: 'AES-GCM', length: 256 },
      true,
      ['decrypt'],
    );
  }

  async function decrypt(key, payload) {
    var plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(payload.iv) },
      key,
      fromBase64(payload.data),
    );
    return new TextDecoder().decode(plain);
  }

  function storage() {
    try {
      return window.localStorage;
    } catch (e) {
      return null;
    }
  }

  function show(html) {
    document.open();
    document.write(html);
    document.close();
  }

  async function start() {
    var payload = JSON.parse(document.getElementById('payload').textContent);
    var storageKey = STORAGE_PREFIX + payload.salt;
    var store = storage();
    var form = document.getElementById('unlock');
    var input = document.getElementById('password');
    var remember = document.getElementById('remember');
    var button = form.querySelector('button');
    var message = document.getElementById('message');

    var saved = null;
    try {
      saved = store && store.getItem(storageKey);
    } catch (e) {}
    if (saved) {
      try {
        var savedKey = await crypto.subtle.importKey('raw', fromBase64(saved), 'AES-GCM', false, ['decrypt']);
        show(await decrypt(savedKey, payload));
        return;
      } catch (e) {
        // The password changed since this device remembered it.
        try {
          store.removeItem(storageKey);
        } catch (e2) {}
      }
    }

    form.hidden = false;
    input.focus();
    form.addEventListener('submit', async function (event) {
      event.preventDefault();
      if (!input.value) return;
      button.disabled = true;
      message.textContent = 'Unlocking…';
      message.className = 'message';
      try {
        var key = await deriveKey(input.value, payload);
        var html = await decrypt(key, payload);
        if (remember.checked && store) {
          try {
            store.setItem(storageKey, toBase64(await crypto.subtle.exportKey('raw', key)));
          } catch (e) {}
        }
        show(html);
      } catch (e) {
        button.disabled = false;
        message.textContent = 'That password did not work. Please try again.';
        message.className = 'message error';
        input.select();
      }
    });
  }

  globalThis.githubWorklogUnlock = { deriveKey: deriveKey, decrypt: decrypt };
  if (typeof document !== 'undefined' && document.getElementById('payload')) {
    if (!globalThis.crypto || !crypto.subtle) {
      document.getElementById('message').textContent = 'This browser cannot unlock the page. Please open it over https in an up-to-date browser.';
    } else if (document.readyState === 'loading') {
      // Replacing the document only works once the browser has finished parsing it.
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }
})();
