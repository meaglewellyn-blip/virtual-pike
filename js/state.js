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

  const state = {
    data: loadFromLocal() || defaultState(),
    rowId: ROW_ID,
    storageKey: STORAGE_KEY,
    // Tracks the last time we made a local change. Used by db.js to ignore
    // stale realtime broadcasts that would otherwise stomp on in-flight edits.
    lastLocalCommitAt: 0,

    // Mutate state, save locally, push to remote, broadcast change.
    commit(mutator) {
      if (typeof mutator === 'function') {
        mutator(state.data);
      }
      state.lastLocalCommitAt = Date.now();
      saveToLocal(state.data);
      emit();
      if (global.Pike && global.Pike.db && typeof global.Pike.db.schedulePush === 'function') {
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
  };

  function mergeWithDefaults(incoming) {
    const def = defaultState();
    return {
      ...def,
      ...incoming,
      settings: { ...def.settings, ...(incoming.settings || {}) },
      workoutSequence: { ...def.workoutSequence, ...(incoming.workoutSequence || {}) },
      dailyOverrides: incoming.dailyOverrides || {},
    };
  }

  global.Pike = global.Pike || {};
  global.Pike.state = state;
})(window);
