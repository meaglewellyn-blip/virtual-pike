/* Virtual Pike — SHA-256 client password gate
 *
 * Mirrors the Triage pattern. Soft gate to keep casual eyes off Pike.
 * NOT a real security boundary — anyone who reads js/db.js can see the
 * Supabase anon key and hit the API directly. The repo will become private
 * once Cloudflare Pages is set up; this gate adds a UI-level barrier.
 *
 * To set the password:
 *   1. In a terminal, run:  echo -n 'YOUR_PASSWORD' | shasum -a 256
 *   2. Copy the 64-char hex hash (everything before the trailing space)
 *   3. Paste it as PIKE_PASSWORD_HASH below and commit.
 *   4. The password itself is never written down — only its hash.
 */

(function (global) {
  'use strict';

  // === Pike password (SHA-256 of Meagan's chosen passphrase). ===
  // The password itself was hashed locally and never written down.
  // To rotate: run  echo -n 'NEWPASSWORD' | shasum -a 256  and replace below.
  const PIKE_PASSWORD_HASH = '16c1eed5863a7009ce63bccd720b07899cf09e96ea2fc95701e189c5b04fea6f';
  // ===============================================================

  const SESSION_KEY = 'pike.auth.unlocked.v1';

  async function sha256(text) {
    const buf = new TextEncoder().encode(text);
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function isUnlockedLocally() {
    try {
      // sessionStorage is used intentionally: it expires when the browser tab
      // (or app) is closed, so Pike re-prompts for the passphrase on every
      // fresh open — matching the Triage pattern.
      return sessionStorage.getItem(SESSION_KEY) === '1';
    } catch (_) { return false; }
  }

  function markUnlocked() {
    try { sessionStorage.setItem(SESSION_KEY, '1'); } catch (_) {}
    document.body.classList.remove('pike-locked');
    document.dispatchEvent(new CustomEvent('pike:unlock'));
  }

  function markLocked() {
    document.body.classList.add('pike-locked');
  }

  async function attemptUnlock(input) {
    const trimmed = (input || '').trim();
    if (!trimmed) return false;
    const hash = await sha256(trimmed);
    if (hash === PIKE_PASSWORD_HASH) {
      markUnlocked();
      return true;
    }
    return false;
  }

  function lock() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
    markLocked();
    const input = document.getElementById('pike-gate-input');
    if (input) { input.value = ''; input.focus(); }
  }

  function wireGateUI() {
    const form  = document.getElementById('pike-gate-form');
    const input = document.getElementById('pike-gate-input');
    const error = document.getElementById('pike-gate-error');
    if (!form || !input) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      error.textContent = '';
      const ok = await attemptUnlock(input.value);
      if (!ok) {
        error.textContent = 'Not quite. Try again.';
        input.value = '';
        input.focus();
      }
    });
  }

  function init() {
    if (isUnlockedLocally()) {
      markUnlocked();
    } else {
      markLocked();
    }
    wireGateUI();
    // Auto-focus the gate input when locked
    if (!isUnlockedLocally()) {
      const input = document.getElementById('pike-gate-input');
      if (input) input.focus();
    }
  }

  global.Pike = global.Pike || {};
  global.Pike.auth = { init, attemptUnlock, lock, isUnlocked: isUnlockedLocally };
})(window);
