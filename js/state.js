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
      console.warn('Pike: hydration timeout — flushing pending commits without remote sync');
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
  };

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
