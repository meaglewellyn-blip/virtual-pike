/* Virtual Pike — in-memory state + change emitter
 *
 * The whole app's data lives in one JSON object (Pike.state.data).
 * Anything that mutates state should call Pike.state.commit() to:
 *   1. write to localStorage (instant)
 *   2. schedule a debounced push to Supabase
 *   3. emit a 'change' event so views re-render
 *
 * Realtime updates from Supabase replace state in place and re-emit.
 */

(function (global) {
  'use strict';

  const STORAGE_KEY = 'pike.app_state.v1';
  const ROW_ID = 'meagan';

  function defaultState() {
    return {
      version: 1,
      settings: {
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York',
        defaultWorkdayStart: '10:00',
        weatherLocation: { lat: 34.0232, lon: -84.3616, label: 'Roswell, GA' },
        dayStart: '05:00',
        dayEnd: '23:00',
      },
      dailyOverrides: {},   // { 'YYYY-MM-DD': { workdayStart: 'HH:MM' } }
      // Date-keyed personal review notes. Each date is independent and persists
      // until the user explicitly clears or edits it. Never reset by render or
      // sync. Shape: { 'YYYY-MM-DD': { notes: string, updatedAt: ISO } }
      dailyReviews: {},
      events: [],
      tasks: [],
      recurrences: [],
      rhythms: [],
      rhythmCompletions: {},
      trips: [],
      travelTemplates: null,
      workoutSequence: { order: [], nextIndex: 0, history: [] },
      templates: [],
      people: [],
      brainDump: [],
      reminders: [],
      quotes: [],
      budget: {
        version: 1,
        settings: {
          currency: 'USD',
          defaultAccountId: null,
          weekStartsOn: 1,
          showCentsOnDashboard: false,
        },
        accounts: [],
        debts: [],
        payPeriods: [],
        categories: [],
        transactions: [],
        recurringBills: [],
        rules: [],
      },
    };
  }

  function loadFromLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (e) {
      console.warn('Pike: bad localStorage payload, starting fresh', e);
      return null;
    }
  }

  function saveToLocal(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.warn('Pike: localStorage write failed', e);
    }
  }

  // Tiny event emitter
  const listeners = new Set();
  function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit() {
    listeners.forEach((fn) => {
      try { fn(state.data); } catch (e) { console.error(e); }
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Hydration gate
  // ──────────────────────────────────────────────────────────────────────────
  // The May 11 wipe happened because boot-time init() calls (rhythms, travel,
  // gcal, etc.) committed against the local/default state BEFORE pullOnce()
  // resolved. Those commits pushed an effectively-empty payload to Supabase,
  // overwriting the authoritative remote row.
  //
  // The gate below queues every commit until db.js declares hydration done
  // (or definitively unavailable). After hydration, queued mutators are
  // applied against the freshest state in a single batch and one consolidated
  // push goes out.
  //
  // db.js calls Pike.state.markHydrated(outcome) where outcome is:
  //   'hydrated'   — pullOnce returned a remote row and state.replace() ran
  //   'no-row'     — Supabase has no row for this id yet (first-ever boot)
  //   'failed'     — pullOnce failed (network, etc.); flush anyway so the
  //                  user isn't blocked from working offline
  //   'local-only' — Supabase not configured / supabase-js not loaded
  //
  // Failsafe: if db.js never calls markHydrated within HYDRATION_TIMEOUT_MS
  // (e.g. db.js fails to load entirely), we auto-flush so the app stays usable.
  const HYDRATION_TIMEOUT_MS = 12000;
  const pendingMutators = [];
  let hydrated = false;
  let hydrationOutcome = null;
  let hydrationTimer = null;

  function flushPendingMutators() {
    if (!pendingMutators.length) return;
    const mutators = pendingMutators.splice(0, pendingMutators.length);
    let mutated = false;
    mutators.forEach((m) => {
      try { m(state.data); mutated = true; } catch (e) { console.error('Pike: queued mutator threw', e); }
    });
    if (!mutated) return;
    state.lastLocalCommitAt = Date.now();
    saveToLocal(state.data);
    emit();
    if (global.Pike?.db?.schedulePush) {
      global.Pike.db.schedulePush(state.data);
    }
  }

  function markHydrated(outcome) {
    if (hydrated) return;
    hydrated = true;
    hydrationOutcome = outcome || 'hydrated';
    if (hydrationTimer) { clearTimeout(hydrationTimer); hydrationTimer = null; }
    flushPendingMutators();
    document.dispatchEvent(new CustomEvent('pike:hydrated', { detail: { outcome: hydrationOutcome } }));
  }

  // Arm the failsafe immediately so a slow/blocked db.init can't deadlock commits forever.
  hydrationTimer = setTimeout(() => {
    if (!hydrated) {
      console.warn('Pike[telemetry]: hydration-timeout-fallback — flushing pending commits without remote sync');
      markHydrated('failed');
    }
  }, HYDRATION_TIMEOUT_MS);

  // ──────────────────────────────────────────────────────────────────────────
  // Shrinkage guard
  // ──────────────────────────────────────────────────────────────────────────
  // Defence in depth. Even if some future bug commits empty arrays, refuse to
  // push if any tracked collection drops from non-zero to zero, OR shrinks
  // by more than SHRINK_REFUSE_PCT. The most recent server sizes are cached
  // by db.js after successful pull/push. The guard is consulted from db.push
  // immediately before the upsert via state.evaluatePushSafety(data).
  const TRACKED_PATHS = [
    'tasks', 'dailyReviews', 'trips', 'reminders', 'events',
    'rhythms', 'rhythmCompletions', 'recurrences', 'people',
    'brainDump', 'quotes', 'dailyOverrides', 'calendarEvents',
    'workoutSequence.history', 'budget.transactions', 'budget.accounts',
  ];

  function collectionSize(obj, path) {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return 0;
      cur = cur[p];
    }
    if (Array.isArray(cur)) return cur.length;
    if (cur && typeof cur === 'object') return Object.keys(cur).length;
    return 0;
  }

  function getCurrentSizes(data) {
    const sizes = {};
    TRACKED_PATHS.forEach((p) => { sizes[p] = collectionSize(data, p); });
    return sizes;
  }

  function evaluatePushSafety(data, baseline) {
    // Returns { ok, reasons[] }. db.js refuses the push if !ok unless the
    // user has explicitly acknowledged via state.setShrinkOverride(true).
    if (!baseline) return { ok: true, reasons: [] };
    const cur = getCurrentSizes(data);
    const reasons = [];
    TRACKED_PATHS.forEach((path) => {
      const before = baseline[path] || 0;
      const after  = cur[path] || 0;
      if (before > 0 && after === 0) {
        reasons.push(`${path}: ${before} → 0 (catastrophic shrink)`);
      } else if (before >= 10 && after < Math.floor(before * 0.3)) {
        // >70% drop on a meaningful collection — likely accidental
        reasons.push(`${path}: ${before} → ${after} (>70% drop)`);
      }
    });
    return { ok: reasons.length === 0, reasons };
  }

  let shrinkOverride = false;

  const state = {
    data: loadFromLocal() || defaultState(),
    rowId: ROW_ID,
    storageKey: STORAGE_KEY,
    // Tracks the last time we made a local change. Used by db.js to ignore
    // stale realtime broadcasts that would otherwise stomp on in-flight edits.
    lastLocalCommitAt: 0,

    // Mutate state, save locally, push to remote, broadcast change.
    // BEFORE HYDRATION: the mutator is QUEUED. It will be applied once db.js
    // calls markHydrated(). This prevents boot-time inits from racing with
    // pullOnce and pushing a default/stale state over the authoritative
    // remote row (the May 11 incident).
    commit(mutator) {
      if (typeof mutator !== 'function') return;
      if (!hydrated) {
        pendingMutators.push(mutator);
        return;
      }
      mutator(state.data);
      state.lastLocalCommitAt = Date.now();
      saveToLocal(state.data);
      emit();
      if (global.Pike?.db?.schedulePush) {
        global.Pike.db.schedulePush(state.data);
      }
    },

    // Replace entire state (e.g. from realtime pull) without re-pushing.
    replace(next) {
      if (!next || typeof next !== 'object') return;
      state.data = mergeWithDefaults(next);
      saveToLocal(state.data);
      emit();
    },

    on,
    defaults: defaultState,

    // Hydration API — db.js owns the call.
    isHydrated: () => hydrated,
    hydrationOutcome: () => hydrationOutcome,
    markHydrated,

    // Shrinkage guard API — db.js consults before each push and stores
    // the post-push server-side sizes via setBaselineSizes().
    getCurrentSizes,
    evaluatePushSafety: (data) => evaluatePushSafety(data, state._baselineSizes),
    setBaselineSizes(sizes) { state._baselineSizes = sizes; },
    setShrinkOverride(v) { shrinkOverride = !!v; },
    shouldOverrideShrink: () => shrinkOverride,

    // Snapshot ring + manual recovery API. Lives entirely in localStorage —
    // never interferes with the active state key or any sync path.
    createSnapshot,
    listSnapshots,
    restoreSnapshot,
    exportJSON,
    importJSON,
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Snapshot ring (pike.backup.1 .. pike.backup.MAX_SNAPSHOTS)
  // ──────────────────────────────────────────────────────────────────────────
  // Defence in depth in case the shrinkage guard ever fails to catch a wipe.
  // - Slot 1 is the newest; oldest rotates out at MAX_SNAPSHOTS.
  // - Snapshots are taken only after successful hydration AND a state that
  //   passes the shrinkage health check (so we never archive a corrupted state).
  // - Each snapshot includes savedAt, source ('push' | 'pull' | 'manual' |
  //   'pre-import'), and the full state JSON.
  // - Failures are non-fatal: localStorage quota errors are caught and logged.
  const SNAPSHOT_PREFIX = 'pike.backup.';
  const MAX_SNAPSHOTS = 5;
  const SNAPSHOT_SOURCES = ['push', 'pull', 'manual', 'pre-import'];

  function snapshotKey(slot) { return SNAPSHOT_PREFIX + slot; }

  function isStateSnapshotHealthy(data) {
    // Use the same evaluatePushSafety guard the network push uses. The baseline
    // here is the previous snapshot's sizes if available, else current baseline.
    // If no baseline at all, accept (first-ever snapshot has nothing to compare).
    if (!data || typeof data !== 'object') return false;
    const prevSnap = readSnapshot(1);
    const baseline = prevSnap?.sizes || state._baselineSizes;
    if (!baseline) return true;
    return evaluatePushSafety(data, baseline).ok;
  }

  function readSnapshot(slot) {
    try {
      const raw = localStorage.getItem(snapshotKey(slot));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) { return null; }
  }

  function createSnapshot(source) {
    const src = SNAPSHOT_SOURCES.includes(source) ? source : 'manual';
    const data = state.data;
    if (!isStateSnapshotHealthy(data)) {
      console.warn('Pike: snapshot skipped — current state failed health check', src);
      return { ok: false, reason: 'unhealthy-state' };
    }
    const entry = {
      savedAt: new Date().toISOString(),
      source: src,
      sizes: getCurrentSizes(data),
      data,
    };
    try {
      // Rotate: slot MAX → drop, slot N → slot N+1, then write to slot 1
      try { localStorage.removeItem(snapshotKey(MAX_SNAPSHOTS)); } catch(_) {}
      for (let i = MAX_SNAPSHOTS - 1; i >= 1; i--) {
        const cur = localStorage.getItem(snapshotKey(i));
        if (cur != null) localStorage.setItem(snapshotKey(i + 1), cur);
      }
      localStorage.setItem(snapshotKey(1), JSON.stringify(entry));
      console.info('Pike: snapshot created', { source: src, savedAt: entry.savedAt, sizes: entry.sizes });
      document.dispatchEvent(new CustomEvent('pike:snapshot-created', { detail: { source: src, savedAt: entry.savedAt } }));
      return { ok: true, savedAt: entry.savedAt };
    } catch (e) {
      console.warn('Pike: snapshot write failed (likely quota)', e);
      return { ok: false, reason: 'quota' };
    }
  }

  function listSnapshots() {
    const out = [];
    for (let i = 1; i <= MAX_SNAPSHOTS; i++) {
      const e = readSnapshot(i);
      if (e) out.push({ slot: i, savedAt: e.savedAt, source: e.source, sizes: e.sizes });
    }
    return out;
  }

  function restoreSnapshot(slot) {
    const entry = readSnapshot(slot);
    if (!entry || !entry.data) return { ok: false, reason: 'not-found' };
    // Always take a pre-restore safety snapshot of the CURRENT state so the
    // user can roll back the rollback if they hit the wrong button.
    createSnapshot('manual');
    state.replace(entry.data);
    // After restoring, allow the push to happen even if it looks like shrinkage
    // (we are intentionally going backwards in time).
    state.setShrinkOverride(true);
    if (global.Pike?.db?.schedulePush) global.Pike.db.schedulePush(state.data);
    setTimeout(() => state.setShrinkOverride(false), 5000);
    return { ok: true, savedAt: entry.savedAt };
  }

  function exportJSON() {
    // Returns the current state as a JSON string. The caller is responsible
    // for downloading via Blob/anchor.
    return JSON.stringify(state.data, null, 2);
  }

  function importJSON(jsonText) {
    let parsed = null;
    try { parsed = JSON.parse(jsonText); }
    catch (e) { return { ok: false, reason: 'invalid-json', detail: String(e) }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'not-an-object' };
    }
    // Loose validation — at minimum it should look like Pike's state shape.
    // We don't reject on missing keys (older exports may not have them); we
    // only reject if it clearly isn't Pike data at all.
    const looksLikePike = (
      typeof parsed.version === 'number' ||
      parsed.tasks !== undefined ||
      parsed.settings !== undefined ||
      parsed.brainDump !== undefined
    );
    if (!looksLikePike) return { ok: false, reason: 'unrecognized-shape' };

    // Safety snapshot of the current state BEFORE we replace.
    createSnapshot('pre-import');

    // Replace + push (override shrink guard since the user explicitly asked).
    state.replace(parsed);
    state.setShrinkOverride(true);
    if (global.Pike?.db?.schedulePush) global.Pike.db.schedulePush(state.data);
    setTimeout(() => state.setShrinkOverride(false), 5000);
    return { ok: true };
  }

  function mergeWithDefaults(incoming) {
    const def = defaultState();
    const incomingBudget = incoming.budget || {};
    const merged = {
      ...def,
      ...incoming,
      settings: { ...def.settings, ...(incoming.settings || {}) },
      workoutSequence: { ...def.workoutSequence, ...(incoming.workoutSequence || {}) },
      dailyOverrides: incoming.dailyOverrides || {},
      // Preserve every existing daily review verbatim. Falls back to {} only
      // if incoming doesn't include the field at all (legacy state). Never
      // overwrites or strips per-date notes.
      dailyReviews: incoming.dailyReviews || {},
      budget: {
        ...def.budget,
        ...incomingBudget,
        settings: { ...def.budget.settings, ...(incomingBudget.settings || {}) },
      },
    };
    // Strip legacy _localTs (per-device wall-clock) — never reintroduce.
    delete merged._localTs;
    return merged;
  }

  global.Pike = global.Pike || {};
  global.Pike.state = state;
})(window);
