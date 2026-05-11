/* Virtual Pike — Supabase wiring (mirrors Triage pattern)
 *
 * - Single row in `app_state` table, id = "meagan", column `data` is jsonb.
 * - Push: debounced upsert.
 * - Pull: realtime subscription writes incoming changes to localStorage and Pike.state.
 * - If SUPABASE_URL/KEY are placeholders, app runs in local-only mode (still functional, no sync).
 */

(function (global) {
  'use strict';

  // === Supabase config ===
  const SUPABASE_URL = 'https://oenxkfheadicpixkywtz.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9lbnhrZmhlYWRpY3BpeGt5d3R6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MDYzMzEsImV4cCI6MjA5MzI4MjMzMX0.bfVyJ0ysEoKn8Dr0suDAN1ftrJ6uq4JncIoK8FdFBtM';
  // =======================

  const PUSH_DEBOUNCE_MS = 600;
  // Window during which incoming realtime broadcasts are ignored after a
  // local commit. Belt-and-suspenders guard against the realtime echo of our
  // own push stomping on an edit the user is mid-way through.
  const REALTIME_IGNORE_AFTER_LOCAL_COMMIT_MS = 10000;

  // localStorage key that records the updated_at of the Supabase row the last
  // time this device successfully pulled or pushed.  Using the server-generated
  // updated_at (an ISO string) as the cross-device freshness source means the
  // comparison is authoritative: it comes from one clock (Supabase), not from
  // independent per-device wall clocks.
  const SYNC_KEY = 'pike.sync.last_at';

  let client = null;
  let pushTimer = null;
  let lastPushedJson = null;
  let lastPushedAt = null;   // ISO string; set after each successful upsert
  let mode = 'local';  // 'local' | 'syncing' | 'online'

  function isConfigured() {
    return !!SUPABASE_URL && !!SUPABASE_ANON_KEY
      && SUPABASE_URL !== 'REPLACE_WITH_YOUR_SUPABASE_URL'
      && SUPABASE_ANON_KEY !== 'REPLACE_WITH_YOUR_SUPABASE_ANON_KEY';
  }

  function setMode(next) {
    mode = next;
    document.dispatchEvent(new CustomEvent('pike:syncmode', { detail: { mode } }));
  }

  function init() {
    if (client) return;  // already initialised — prevent duplicate subscriptions
    if (!isConfigured()) {
      console.info('Pike: Supabase not configured — running in local-only mode.');
      setMode('local');
      // Allow commits to proceed when there is no remote sync target.
      global.Pike.state.markHydrated('local-only');
      return;
    }
    if (!global.supabase || typeof global.supabase.createClient !== 'function') {
      console.warn('Pike: supabase-js not loaded; falling back to local-only mode.');
      setMode('local');
      global.Pike.state.markHydrated('local-only');
      return;
    }
    try {
      client = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 5 } },
      });
      setMode('online');
    } catch (e) {
      console.warn('Pike: Supabase init failed', e);
      setMode('local');
      global.Pike.state.markHydrated('failed');
      return;
    }
    // pullOnce signals hydration when it resolves. subscribe() runs in parallel.
    pullOnce();
    subscribe();

    // Flush any pending push immediately when the PWA goes to the background or
    // the page is about to unload.  Without this, a change made within
    // PUSH_DEBOUNCE_MS of switching apps never reaches Supabase; on the next
    // boot pullOnce() finds remoteAt > lastAt (the push that would have updated
    // lastAt never ran) and calls state.replace() — overwriting the mobile edit.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
        push(global.Pike.state.data);
      }
    });
    window.addEventListener('pagehide', () => {
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
        push(global.Pike.state.data);
      }
    });
  }

  async function pullOnce() {
    if (!client) { global.Pike.state.markHydrated('failed'); return; }
    const rowId = global.Pike.state.rowId;
    try {
      const { data, error } = await client
        .from('app_state')
        .select('data, updated_at')
        .eq('id', rowId)
        .maybeSingle();
      if (error) {
        console.warn('Pike: pull failed', error);
        global.Pike.state.markHydrated('failed');
        return;
      }
      if (data && data.data) {
        // Cross-device staleness guard using the server's updated_at timestamp.
        let lastAt = '';
        try { lastAt = localStorage.getItem(SYNC_KEY) || ''; } catch(_) {}
        const remoteAt = data.updated_at || '';
        if (lastAt && remoteAt && remoteAt <= lastAt) {
          console.info('Pike: pullOnce skipped — remote row not newer than last sync',
            { lastAt, remoteAt });
        } else {
          global.Pike.state.replace(data.data);
          try { localStorage.setItem(SYNC_KEY, remoteAt); } catch(_) {}
        }
        // Either way we now have an authoritative-or-newer state in memory.
        // Seed the shrinkage baseline from what we just observed and signal
        // hydration so queued init commits can flush.
        global.Pike.state.setBaselineSizes(global.Pike.state.getCurrentSizes(global.Pike.state.data));
        global.Pike.state.markHydrated('hydrated');
      } else {
        // Row genuinely does not exist yet — first boot on a brand-new project.
        // Allow init seeds to proceed and create the row on first push.
        console.info('Pike: pullOnce found no remote row — first-boot mode');
        global.Pike.state.setBaselineSizes(global.Pike.state.getCurrentSizes(global.Pike.state.data));
        global.Pike.state.markHydrated('no-row');
      }
    } catch (e) {
      console.warn('Pike: pull threw', e);
      global.Pike.state.markHydrated('failed');
    }
  }

  function subscribe() {
    if (!client) return;
    const rowId = global.Pike.state.rowId;
    client
      .channel('pike-app-state')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'app_state', filter: `id=eq.${rowId}` },
        (payload) => {
          if (!payload || !payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          // Echo of our own push — already represented in state.
          if (incoming === lastPushedJson) return;
          // Primary staleness check: if this broadcast's row timestamp is at or
          // before our last successful push, it's either our own echo or a delayed
          // broadcast of an older state — ignore it in both cases.
          if (lastPushedAt && payload.new.updated_at && payload.new.updated_at <= lastPushedAt) return;
          // Secondary guard: the user has unsaved/in-flight local edits within
          // the ignore window — skip to avoid stomping on an edit that hasn't
          // been pushed yet.
          const sinceLocal = Date.now() - (global.Pike.state.lastLocalCommitAt || 0);
          if (sinceLocal < REALTIME_IGNORE_AFTER_LOCAL_COMMIT_MS) return;
          global.Pike.state.replace(payload.new.data);
        })
      .subscribe();
  }

  function schedulePush(data) {
    if (!client) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push(data), PUSH_DEBOUNCE_MS);
  }

  async function push(data) {
    if (!client) return;

    // ── Shrinkage guard ───────────────────────────────────────────────────
    // Pre-flight sanity check. If a tracked collection just dropped from
    // non-zero to zero (or shrank by >70%), refuse to push unless the user
    // has explicitly overridden. This is defence in depth against the class
    // of bug that caused the May 11 wipe: boot-time init commits running
    // before pullOnce hydrated, then pushing a near-empty payload.
    if (!global.Pike.state.shouldOverrideShrink()) {
      const safety = global.Pike.state.evaluatePushSafety(data);
      if (!safety.ok) {
        console.error('Pike: PUSH REFUSED — local state has shrunk unexpectedly.',
          'Open the recovery banner to override. Reasons:', safety.reasons);
        document.dispatchEvent(new CustomEvent('pike:push-refused', { detail: { reasons: safety.reasons } }));
        setMode('online');
        return;
      }
    }

    setMode('syncing');
    const rowId = global.Pike.state.rowId;
    const serialized = JSON.stringify(data);
    const pushedAt = new Date().toISOString();
    try {
      const { error } = await client
        .from('app_state')
        .upsert({ id: rowId, data, updated_at: pushedAt });
      if (error) { console.warn('Pike: push failed', error); setMode('online'); return; }
      lastPushedJson = serialized;
      lastPushedAt   = pushedAt;
      // Advance the local sync marker so the next pullOnce() doesn't re-apply
      // our own data as if it were a foreign change.
      try { localStorage.setItem(SYNC_KEY, pushedAt); } catch(_) {}
      // Refresh the shrinkage baseline so the next push compares against
      // what we just successfully pushed — not the pre-push snapshot.
      global.Pike.state.setBaselineSizes(global.Pike.state.getCurrentSizes(data));
      setMode('online');
    } catch (e) {
      console.warn('Pike: push threw', e);
      setMode('online');
    }
  }

  global.Pike = global.Pike || {};
  global.Pike.db = {
    init,
    isConfigured,
    schedulePush,
    pullOnce,
    getMode: () => mode,
  };
})(window);
