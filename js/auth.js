/* Virtual Pike — SHA-256 client username + passphrase gate
 *
 * Soft gate to keep casual eyes off Pike. NOT a real security boundary —
 * anyone who reads js/db.js can see the Supabase anon key. This is a UI gate.
 *
 * Both fields must match: the form hashes `username:passphrase` and compares
 * against PIKE_GATE_HASH. To rotate either:
 *   1. echo -n 'newuser:newpass' | shasum -a 256
 *   2. Paste the 64-char hex hash below and commit.
 *   The username and passphrase are never written down — only their joint hash.
 */

(function (global) {
  'use strict';

  // === Pike gate hash = sha256('username:passphrase') ===========
  // Current credentials hashed locally; the inputs themselves are never stored.
  const PIKE_GATE_HASH = '51d77e9fe806d2ab12014af224db055a226ab54407956c3e37424408b7c61c5a';
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
      // fresh open. DO NOT switch to localStorage — that would make the gate
      // permanent and undermine the lock-on-quit behavior.
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

  async function attemptUnlock(username, passphrase) {
    const u = (username || '').trim();
    const p = (passphrase || '').trim();
    if (!u || !p) return false;
    // Joint hash: prevents either field alone from unlocking.
    const hash = await sha256(u + ':' + p);
    if (hash === PIKE_GATE_HASH) {
      markUnlocked();
      return true;
    }
    return false;
  }

  function lock() {
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
    markLocked();
    const u = document.getElementById('pike-gate-username');
    const p = document.getElementById('pike-gate-input');
    if (u) u.value = '';
    if (p) { p.value = ''; }
    if (u) u.focus(); else if (p) p.focus();
  }

  function wireGateUI() {
    const form  = document.getElementById('pike-gate-form');
    const usernameEl = document.getElementById('pike-gate-username');
    const passEl     = document.getElementById('pike-gate-input');
    const error      = document.getElementById('pike-gate-error');
    if (!form || !passEl) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (error) error.textContent = '';
      const ok = await attemptUnlock(usernameEl?.value, passEl.value);
      if (!ok) {
        if (error) error.textContent = 'Not quite. Try again.';
        passEl.value = '';
        // Re-focus username if blank, else password — small UX touch
        if (usernameEl && !usernameEl.value.trim()) usernameEl.focus();
        else passEl.focus();
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
    // Auto-focus the username field when locked (or password if no username field)
    if (!isUnlockedLocally()) {
      const u = document.getElementById('pike-gate-username');
      const p = document.getElementById('pike-gate-input');
      if (u) u.focus(); else if (p) p.focus();
    }
  }

  global.Pike = global.Pike || {};
  global.Pike.auth = { init, attemptUnlock, lock, isUnlocked: isUnlockedLocally };
})(window);
