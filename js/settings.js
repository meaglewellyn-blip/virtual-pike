/* Virtual Pike — Settings: recovery panel
 *
 * Renders into #settings-recovery in the Settings section.
 * Shows: hydration outcome, last sync time, snapshot ring summary.
 * Buttons: take manual snapshot, export backup JSON, import backup JSON,
 *          restore from a specific snapshot slot.
 *
 * INVARIANT: This module is observability + manual recovery only. It does
 * not perform automatic state mutation on boot. Snapshot creation on
 * pull/push is owned by db.js. This module just calls into the state API.
 */

(function (global) {
  'use strict';

  const SYNC_KEY = 'pike.sync.last_at';

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'className') node.className = attrs[k];
        else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2).toLowerCase(), attrs[k]);
        else if (k === 'text') node.textContent = attrs[k];
        else node.setAttribute(k, attrs[k]);
      }
    }
    for (const c of children) {
      if (c == null) continue;
      if (typeof c === 'string') node.appendChild(document.createTextNode(c));
      else node.appendChild(c);
    }
    return node;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (_) { return iso; }
  }

  function bytesPretty(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function render() {
    const root = document.getElementById('settings-recovery');
    if (!root) return;

    const state = global.Pike.state;
    const hydrated = state.isHydrated();
    const outcome  = state.hydrationOutcome() || (hydrated ? 'unknown' : 'pending');
    let syncAt = '';
    try { syncAt = localStorage.getItem(SYNC_KEY) || ''; } catch (_) {}
    const snapshots = state.listSnapshots ? state.listSnapshots() : [];
    const currentSizes = state.getCurrentSizes(state.data);
    const currentBytes = JSON.stringify(state.data).length;

    root.innerHTML = '';

    // ── Status summary ────────────────────────────────────────────────────
    const status = el('div', { className: 'recovery-status' });
    status.appendChild(el('div', { className: 'recovery-row' },
      el('span', { className: 'recovery-label', text: 'Hydration' }),
      el('span', { className: 'recovery-value', text: outcome })));
    status.appendChild(el('div', { className: 'recovery-row' },
      el('span', { className: 'recovery-label', text: 'Last sync' }),
      el('span', { className: 'recovery-value', text: fmtTime(syncAt) })));
    status.appendChild(el('div', { className: 'recovery-row' },
      el('span', { className: 'recovery-label', text: 'State size' }),
      el('span', { className: 'recovery-value', text: bytesPretty(currentBytes) })));
    status.appendChild(el('div', { className: 'recovery-row' },
      el('span', { className: 'recovery-label', text: 'Snapshots' }),
      el('span', { className: 'recovery-value', text: `${snapshots.length} / 5` })));
    root.appendChild(status);

    // ── Action buttons ────────────────────────────────────────────────────
    const actions = el('div', { className: 'recovery-actions' });

    actions.appendChild(el('button', {
      type: 'button',
      className: 'btn',
      onClick: handleManualSnapshot,
      text: 'Take snapshot now',
    }));
    actions.appendChild(el('button', {
      type: 'button',
      className: 'btn',
      onClick: handleExport,
      text: 'Export backup',
    }));
    actions.appendChild(el('button', {
      type: 'button',
      className: 'btn',
      onClick: handleImport,
      text: 'Import backup…',
    }));
    root.appendChild(actions);

    // ── Snapshot list ─────────────────────────────────────────────────────
    if (snapshots.length) {
      const list = el('div', { className: 'recovery-snapshots' });
      list.appendChild(el('h4', { className: 'recovery-subhead', text: 'Saved snapshots (newest first)' }));
      snapshots.forEach((s) => {
        const totalItems = Object.values(s.sizes || {}).reduce((a, b) => a + b, 0);
        const row = el('div', { className: 'recovery-snapshot' },
          el('div', { className: 'recovery-snapshot-meta' },
            el('div', { className: 'recovery-snapshot-when', text: fmtTime(s.savedAt) }),
            el('div', { className: 'recovery-snapshot-detail',
              text: `slot ${s.slot} · ${s.source} · ${totalItems} total items` })),
          el('button', {
            type: 'button',
            className: 'btn btn-ghost btn-sm',
            onClick: () => handleRestore(s.slot, s.savedAt),
            text: 'Restore',
          }),
        );
        list.appendChild(row);
      });
      root.appendChild(list);
    } else {
      root.appendChild(el('p', { className: 'recovery-empty',
        text: 'No snapshots yet. One is taken automatically after each successful sync.' }));
    }
  }

  // ── Handlers ────────────────────────────────────────────────────────────

  function handleManualSnapshot() {
    const result = global.Pike.state.createSnapshot('manual');
    if (result.ok) {
      flash('Snapshot saved.');
    } else if (result.reason === 'unhealthy-state') {
      alert('Cannot snapshot right now — current state failed the health check (looks unexpectedly shrunk). Refresh first, then try again.');
    } else {
      alert('Snapshot failed: ' + (result.reason || 'unknown'));
    }
    render();
  }

  function handleExport() {
    const json = global.Pike.state.exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const a = document.createElement('a');
    a.href = url;
    a.download = `pike-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash('Backup downloaded.');
  }

  function handleImport() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const text = String(reader.result || '');
        // Show a confirm before we touch anything destructive
        const proceed = window.confirm(
          'Import this backup?\n\n' +
          'This will REPLACE your current Pike data with the contents of the file.\n' +
          'A safety snapshot of your current state will be saved first, so you can roll back.\n\n' +
          'Press OK to continue.'
        );
        if (!proceed) return;
        const result = global.Pike.state.importJSON(text);
        if (result.ok) {
          flash('Backup imported. Reloading…');
          setTimeout(() => location.reload(), 800);
        } else {
          alert('Import failed: ' + (result.reason || 'unknown') +
            (result.detail ? '\n\n' + result.detail : ''));
        }
      };
      reader.onerror = () => alert('Could not read file.');
      reader.readAsText(file);
    });
    input.click();
  }

  function handleRestore(slot, savedAt) {
    const proceed = window.confirm(
      `Restore Pike state from snapshot taken ${fmtTime(savedAt)}?\n\n` +
      'Your CURRENT state will be saved as a safety snapshot first, so you can roll back the rollback if needed.\n\n' +
      'Press OK to continue.'
    );
    if (!proceed) return;
    const result = global.Pike.state.restoreSnapshot(slot);
    if (result.ok) {
      flash('Snapshot restored. Reloading…');
      setTimeout(() => location.reload(), 800);
    } else {
      alert('Restore failed: ' + (result.reason || 'unknown'));
    }
  }

  // Tiny ephemeral toast — leaves no DOM behind
  let toastTimer = null;
  function flash(msg) {
    let t = document.getElementById('recovery-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'recovery-toast';
      t.className = 'recovery-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('is-visible');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-visible'), 2500);
  }

  // Re-render on hydration + on every state change so metadata stays fresh
  function init() {
    document.addEventListener('pike:hydrated', render);
    document.addEventListener('pike:snapshot-created', render);
    document.addEventListener('pike:push-refused', (e) => {
      const reasons = (e?.detail?.reasons || []).join('; ');
      console.warn('Pike[telemetry]: push-refused event surfaced', reasons);
      // Surface a non-blocking banner so the user knows something happened.
      flash('Push refused — see console for details.');
    });
    render();
  }

  global.Pike = global.Pike || {};
  global.Pike.settings = { init, render };
})(window);
