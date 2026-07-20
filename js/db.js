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
  // Companion to SYNC_KEY: the updated_at of the state that was actually
  // PERSISTED to localStorage. The boot pull may only be skipped when this
  // matches the sync marker — a fresh marker over stale/poisoned local data
  // (the 2026-07 reseed incidents) otherwise resurrects old state forever.
  const LOCAL_DATA_AT_KEY = 'pike.local.data_at';

  let client = null;
  let pushTimer = null;
  let lastPushedJson = null;
  let lastPushedAt = null;   // ISO string; set after each successful upsert
  let mode = 'local';  // 'local' | 'syncing' | 'online' | 'degraded'
  let initAttempts = 0;

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
      // The sync library failed to load. The old behavior — silently dropping
      // to local-only and rendering whatever stale copy localStorage holds —
      // is exactly how a device ends up living in the past for days (the
      // 2026-07-20 "everything reset to July 10" incident). Instead: warn
      // loudly, keep the hydration gate closed so nothing stale can commit or
      // push, and keep retrying.
      initAttempts += 1;
      console.warn(`Pike: supabase-js not loaded (attempt ${initAttempts}) — retrying.`);
      setMode('degraded');
      if (initAttempts < 10) setTimeout(init, 3000);
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
      // Coming BACK to the foreground: a resumed PWA holds frozen in-memory
      // state, its realtime socket is often dead, and its next commit would
      // push that stale snapshot over everything newer (the 2026-07-12
      // morning wipe). Pull first — pullOnce() is a no-op when the remote
      // row isn't newer, so this is cheap on every wake.
      if (!document.hidden) pullOnce();
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) pullOnce();  // bfcache restore = same stale-resume risk
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
    console.info('Pike[telemetry]: hydration-start');
    if (!client) { global.Pike.state.markHydrated('failed'); console.warn('Pike[telemetry]: hydration-failed (no client)'); return; }
    const rowId = global.Pike.state.rowId;
    try {
      const { data, error } = await client
        .from('app_state')
        .select('data, updated_at')
        .eq('id', rowId)
        .maybeSingle();
      if (error) {
        console.warn('Pike[telemetry]: hydration-failed', error);
        global.Pike.state.markHydrated('failed');
        return;
      }
      if (data && data.data) {
        // ALWAYS adopt the server's copy. The old marker-based skip
        // ("remote not newer than my last sync") trusted timestamps that
        // devices wrote from their own wall clocks — one bad clock, or one
        // poisoned localStorage marker, froze a device on stale data forever.
        // The server row is the single source of truth; adopting it on every
        // boot/wake costs one small fetch and kills that entire bug class.
        // Sole exception: an edit committed seconds ago on THIS device that
        // the debounced push hasn't flushed yet — don't stomp it with what
        // would just be our own pre-edit state echoing back.
        const remoteAt = data.updated_at || '';
        const sinceLocalCommit = Date.now() - (global.Pike.state.lastLocalCommitAt || 0);
        // Identical-version check: only skip when the server row is the EXACT
        // version this device already adopted (millisecond-equal timestamps —
        // formats differ, so compare parsed times, never strings). Unlike the
        // old "remote not newer" inequality, a poisoned/future marker can
        // never satisfy equality, so a frozen device always re-adopts.
        let localDataAt = '';
        try { localDataAt = localStorage.getItem(LOCAL_DATA_AT_KEY) || ''; } catch(_) {}
        const sameVersion = !!remoteAt && !!localDataAt
          && Date.parse(remoteAt) === Date.parse(localDataAt);
        if (sameVersion) {
          console.info('Pike: pullOnce — already on this exact row version', { remoteAt });
        } else if (sinceLocalCommit < REALTIME_IGNORE_AFTER_LOCAL_COMMIT_MS) {
          console.info('Pike: pullOnce deferred — local edit in flight', { remoteAt });
        } else {
          global.Pike.state.replace(data.data);
          try { localStorage.setItem(SYNC_KEY, remoteAt); } catch(_) {}
          try { localStorage.setItem(LOCAL_DATA_AT_KEY, remoteAt); } catch(_) {}
        }
        // Either way we now have an authoritative-or-newer state in memory.
        // Seed the shrinkage baseline from what we just observed and signal
        // hydration so queued init commits can flush.
        global.Pike.state.setBaselineSizes(global.Pike.state.getCurrentSizes(global.Pike.state.data));
        global.Pike.state.markHydrated('hydrated');
        console.info('Pike[telemetry]: hydration-success', { remoteAt, sizes: global.Pike.state.getCurrentSizes(global.Pike.state.data) });
        // Take a snapshot of the newly-hydrated state so we always have at
        // least one fresh good copy in the ring after each successful sync.
        try { global.Pike.state.createSnapshot('pull'); } catch (_) {}
      } else {
        // Row genuinely does not exist yet — first boot on a brand-new project.
        // Allow init seeds to proceed and create the row on first push.
        console.info('Pike[telemetry]: hydration-no-row (first-boot mode)');
        global.Pike.state.setBaselineSizes(global.Pike.state.getCurrentSizes(global.Pike.state.data));
        global.Pike.state.markHydrated('no-row');
      }
    } catch (e) {
      console.warn('Pike[telemetry]: hydration-threw', e);
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
          // Advance the freshness marker — this device is now current, so the
          // push guard below must not refuse its next push.
          try {
            if (payload.new.updated_at) {
              localStorage.setItem(SYNC_KEY, payload.new.updated_at);
              localStorage.setItem(LOCAL_DATA_AT_KEY, payload.new.updated_at);
            }
          } catch (_) {}
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
        console.error('Pike[telemetry]: push-refused — local state has shrunk unexpectedly.',
          'Reasons:', safety.reasons);
        document.dispatchEvent(new CustomEvent('pike:push-refused', { detail: { reasons: safety.reasons } }));
        setMode('online');
        return;
      }
    }

    setMode('syncing');
    const rowId = global.Pike.state.rowId;

    // ── Freshness guard ───────────────────────────────────────────────────
    // Every push writes the WHOLE blob. If the remote row changed since this
    // device last synced, pushing would silently erase those changes (the
    // repeated stale-device wipes of 2026-07-11/12). Refuse and pull instead —
    // the cost is redoing one local edit; the alternative is losing a day.
    try {
      let lastAt = '';
      try { lastAt = localStorage.getItem(SYNC_KEY) || ''; } catch (_) {}
      if (lastAt) {
        const { data: head } = await client
          .from('app_state')
          .select('updated_at')
          .eq('id', rowId)
          .maybeSingle();
        if (head && head.updated_at && head.updated_at > lastAt) {
          console.warn('Pike[telemetry]: push-refused — remote row is newer than this device\'s last sync. Pulling fresh state; redo the last edit if it disappears.');
          document.dispatchEvent(new CustomEvent('pike:push-refused', { detail: { reasons: ['remote-newer-than-local-sync'] } }));
          setMode('online');
          await pullOnce();
          return;
        }
      }
    } catch (_) { /* offline or transient — the upsert below will surface it */ }

    const pushedAt = new Date().toISOString();
    // Stamp the blob itself with when (and roughly what) pushed it. The
    // server-side guard rejects any write whose stamp is missing or old —
    // which permanently locks out stale devices running frozen cached code,
    // the root cause of every 2026-07 wipe. Old clients can't fake a field
    // their code has never heard of.
    data.meta = Object.assign({}, data.meta, {
      pushStamp: pushedAt,
      pushedBy: (navigator.userAgent || 'unknown').slice(0, 120),
    });
    const serialized = JSON.stringify(data);
    try {
      const { error } = await client
        .from('app_state')
        .upsert({ id: rowId, data, updated_at: pushedAt });
      if (error) { console.warn('Pike[telemetry]: push-network-failed', error); setMode('online'); return; }
      lastPushedJson = serialized;
      lastPushedAt   = pushedAt;
      // Advance the local sync marker so the next pullOnce() doesn't re-apply
      // our own data as if it were a foreign change.
      try { localStorage.setItem(SYNC_KEY, pushedAt); } catch(_) {}
      try { localStorage.setItem(LOCAL_DATA_AT_KEY, pushedAt); } catch(_) {}
      // Refresh the shrinkage baseline so the next push compares against
      // what we just successfully pushed — not the pre-push snapshot.
      global.Pike.state.setBaselineSizes(global.Pike.state.getCurrentSizes(data));
      setMode('online');
      console.info('Pike[telemetry]: push-accepted', { pushedAt, bytes: serialized.length });
      // Snapshot after every successful push so the ring always reflects the
      // last known good remote-confirmed state.
      try { global.Pike.state.createSnapshot('push'); } catch (_) {}
    } catch (e) {
      console.warn('Pike[telemetry]: push-threw', e);
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
