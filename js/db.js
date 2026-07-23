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
  let pullRetryTimer = null;
  let pullRetryCount = 0;
  let hadSuccessfulPull = false;

  // ── Plain-fetch REST fallback ─────────────────────────────────────────────
  // supabase-js requests have failed on at least one device (2026-07-23:
  // iPhone frozen on stale data with current code) while plain fetch to the
  // same host kept working — the Plaid balance calls proved it every launch.
  // Every critical read/write therefore has a bare-fetch fallback, and the
  // diagnostics below use bare fetch exclusively so they survive whatever
  // kills the SDK.
  const REST_HEADERS = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
    'Content-Type': 'application/json',
  };

  async function restSelectRow(rowId) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?id=eq.${encodeURIComponent(rowId)}&select=data,updated_at`,
      { headers: REST_HEADERS }
    );
    if (!res.ok) throw new Error('rest-select http ' + res.status);
    const rows = await res.json();
    return rows && rows[0] ? rows[0] : null;
  }

  async function restUpsertRow(rowId, data, pushedAt) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?id=eq.${encodeURIComponent(rowId)}`,
      {
        method: 'PATCH',
        headers: Object.assign({ 'Prefer': 'return=minimal' }, REST_HEADERS),
        body: JSON.stringify({ data, updated_at: pushedAt }),
      }
    );
    if (!res.ok) throw new Error('rest-upsert http ' + res.status);
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out after ' + ms + 'ms')), ms)),
    ]);
  }

  // ── Remote diagnostics ────────────────────────────────────────────────────
  // Fire-and-forget rows into public.client_log so a misbehaving device can
  // be diagnosed from anywhere instead of guessing at its console. Uses bare
  // fetch, never throws, silently no-ops if the table doesn't exist yet.
  function deviceId() {
    try {
      let id = localStorage.getItem('pike.device.id');
      if (!id) {
        id = 'dev-' + Math.random().toString(36).slice(2, 10);
        localStorage.setItem('pike.device.id', id);
      }
      return id;
    } catch (_) {
      return 'ephemeral-' + Math.random().toString(36).slice(2, 8);
    }
  }
  let cachedVer = '';
  function telemetry(event, detail) {
    const send = (ver) => {
      try {
        fetch(`${SUPABASE_URL}/rest/v1/client_log`, {
          method: 'POST',
          headers: Object.assign({ 'Prefer': 'return=minimal' }, REST_HEADERS),
          body: JSON.stringify({
            device: deviceId(),
            ver: ver || '',
            event,
            detail: Object.assign({ ua: (navigator.userAgent || '').slice(0, 140) }, detail || {}),
          }),
        }).catch(() => {});
      } catch (_) {}
    };
    if (cachedVer) { send(cachedVer); return; }
    try {
      caches.keys().then((keys) => {
        cachedVer = keys.filter((k) => /^pike-v\d+$/.test(k))
          .sort((a, b) => parseInt(a.slice(6), 10) - parseInt(b.slice(6), 10)).pop() || 'no-sw-cache';
        send(cachedVer);
      }).catch(() => send('cache-err'));
    } catch (_) { send('cache-err'); }
  }

  function localProfile() {
    try {
      const d = global.Pike.state.data || {};
      const txs = (d.budget || {}).transactions || [];
      let lastAt = '', localDataAt = '';
      try { lastAt = localStorage.getItem(SYNC_KEY) || ''; } catch (_) {}
      try { localDataAt = localStorage.getItem(LOCAL_DATA_AT_KEY) || ''; } catch (_) {}
      let storage = 'ok';
      try {
        localStorage.setItem('pike.storage.test', '1');
        if (localStorage.getItem('pike.storage.test') !== '1') storage = 'readback-failed';
        localStorage.removeItem('pike.storage.test');
      } catch (e) { storage = 'write-failed: ' + (e && e.name); }
      const rachel = (d.people || []).find((p) => /rachel/i.test(p && p.name || ''));
      return {
        txns: txs.length,
        maxTxDate: txs.reduce((m, t) => (t.date > m ? t.date : m), ''),
        quotes: (d.quotes || []).length,
        brainDump: (d.brainDump || []).length,
        rachelSobriety: rachel ? (rachel.sobrietyDate || null) : 'no-rachel',
        lastAt, localDataAt, storage,
        // Recent brain-dump texts ride along so items stranded on a device
        // that could never push are recoverable from the log.
        recentDumps: (d.brainDump || []).slice(-25).map((x) => ({
          id: x && x.id, text: String(x && (x.text || x.title) || '').slice(0, 200), at: x && (x.createdAt || x.at),
        })),
      };
    } catch (e) {
      return { profileError: String(e).slice(0, 200) };
    }
  }

  function isConfigured() {
    return !!SUPABASE_URL && !!SUPABASE_ANON_KEY
      && SUPABASE_URL !== 'REPLACE_WITH_YOUR_SUPABASE_URL'
      && SUPABASE_ANON_KEY !== 'REPLACE_WITH_YOUR_SUPABASE_ANON_KEY';
  }

  function setMode(next) {
    mode = next;
    document.dispatchEvent(new CustomEvent('pike:syncmode', { detail: { mode } }));
  }

  // Pull retries: one failed boot pull must never condemn a session to stale
  // data (the 12s hydration failsafe used to do exactly that, quietly).
  function schedulePullRetry(reason) {
    if (pullRetryTimer) return;
    const delays = [10000, 30000, 60000, 120000];
    const delay = delays[Math.min(pullRetryCount, delays.length - 1)];
    pullRetryCount += 1;
    if (!hadSuccessfulPull) setMode('degraded');
    telemetry('pull-retry-scheduled', { reason: String(reason).slice(0, 120), attempt: pullRetryCount, delayMs: delay });
    pullRetryTimer = setTimeout(() => { pullRetryTimer = null; pullOnce(); }, delay);
  }

  // Read the row through whatever transport works: SDK first (8s cap),
  // bare REST on any SDK failure.
  async function fetchRowAnyTransport(rowId, selectCols) {
    if (client) {
      try {
        const { data, error } = await withTimeout(
          client.from('app_state').select(selectCols || 'data, updated_at').eq('id', rowId).maybeSingle(),
          8000, 'sdk-select');
        if (error) throw new Error('sdk-select: ' + (error.message || JSON.stringify(error)));
        return { row: data, transport: 'sdk' };
      } catch (e) {
        const row = await restSelectRow(rowId);
        telemetry('pull-sdk-failed-rest-ok', { sdkError: String(e).slice(0, 200) });
        return { row, transport: 'rest-fallback' };
      }
    }
    return { row: await restSelectRow(rowId), transport: 'rest' };
  }

  let syncStarted = false;
  function startSyncOnce() {
    if (syncStarted) return;
    syncStarted = true;
    telemetry('boot', { local: localProfile() });
    setMode('syncing');
    pullOnce();

    // If the hydration gate opens any way other than a successful pull
    // (12s failsafe, error path), the screen is showing an old local copy —
    // say so loudly and keep retrying until a pull lands.
    document.addEventListener('pike:hydrated', (e) => {
      const outcome = e && e.detail && e.detail.outcome;
      if (outcome !== 'hydrated' && outcome !== 'local-only' && !hadSuccessfulPull) {
        setMode('degraded');
        telemetry('hydration-degraded', { outcome, local: localProfile() });
        schedulePullRetry('hydrated:' + outcome);
      }
    });

    // Flush any pending push immediately when the PWA goes to the background
    // or the page is about to unload; pull on every return to foreground.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
        push(global.Pike.state.data);
      }
      if (!document.hidden) pullOnce();
    });
    window.addEventListener('pageshow', (e) => {
      if (e.persisted) pullOnce();
    });
    window.addEventListener('pagehide', () => {
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
        push(global.Pike.state.data);
      }
    });
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
      console.warn(`Pike: supabase-js not loaded (attempt ${initAttempts}) — syncing over bare REST, retrying SDK.`);
      // Data sync does not wait for the SDK — it runs over bare REST now.
      // The SDK only adds the realtime channel, so keep retrying it quietly.
      startSyncOnce();
      if (initAttempts < 10) setTimeout(init, 3000);
      else telemetry('sdk-load-gave-up', {});
      return;
    }
    try {
      client = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
        realtime: { params: { eventsPerSecond: 5 } },
      });
    } catch (e) {
      // The SDK objected on this browser. Sync proceeds over bare REST —
      // only the realtime channel is lost. The old behavior (silent
      // local-only bail-out) is how a device lived on frozen data for days.
      client = null;
      console.warn('Pike: Supabase client init failed — continuing on bare REST', e);
      telemetry('createclient-threw', { error: String(e).slice(0, 200) });
    }
    if (client) subscribe();
    startSyncOnce();
  }

  async function pullOnce() {
    console.info('Pike[telemetry]: hydration-start');
    const rowId = global.Pike.state.rowId;
    try {
      const { row, transport } = await fetchRowAnyTransport(rowId);
      const data = row;
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
        hadSuccessfulPull = true;
        pullRetryCount = 0;
        if (pullRetryTimer) { clearTimeout(pullRetryTimer); pullRetryTimer = null; }
        setMode('online');
        console.info('Pike[telemetry]: hydration-success', { remoteAt, transport });
        telemetry('pull-ok', { transport, remoteAt, sameVersion, local: localProfile() });
        // Take a snapshot of the newly-hydrated state so we always have at
        // least one fresh good copy in the ring after each successful sync.
        try { global.Pike.state.createSnapshot('pull'); } catch (_) {}
      } else {
        // No row came back. On a brand-new project that's first boot; on an
        // established install (this one) it means the read path is lying —
        // NEVER open first-boot seeding against real local data.
        const prof = localProfile();
        const looksFirstBoot = !prof.txns && !prof.quotes && !prof.brainDump;
        telemetry('pull-no-row', { transport, looksFirstBoot, local: prof });
        if (looksFirstBoot) {
          console.info('Pike[telemetry]: hydration-no-row (first-boot mode)');
          global.Pike.state.setBaselineSizes(global.Pike.state.getCurrentSizes(global.Pike.state.data));
          global.Pike.state.markHydrated('no-row');
        } else {
          console.warn('Pike[telemetry]: hydration-no-row on an established install — treating as failure');
          global.Pike.state.markHydrated('failed');
          schedulePullRetry('no-row');
        }
      }
    } catch (e) {
      console.warn('Pike[telemetry]: hydration-threw', e);
      telemetry('pull-failed', { error: String(e).slice(0, 300) });
      global.Pike.state.markHydrated('failed');
      schedulePullRetry(e);
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
    if (!isConfigured()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => push(data), PUSH_DEBOUNCE_MS);
  }

  async function push(data) {
    if (!isConfigured()) return;

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
        let headAt = null;
        try {
          const { row } = await fetchRowAnyTransport(rowId, 'updated_at');
          headAt = row && row.updated_at;
        } catch (_) { /* transient — the upsert below will surface it */ }
        if (headAt && headAt > lastAt) {
          console.warn('Pike[telemetry]: push-refused — remote row is newer than this device\'s last sync. Pulling fresh state; redo the last edit if it disappears.');
          telemetry('push-refused-remote-newer', { lastAt, headAt });
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
    let transport = 'sdk';
    try {
      let sdkErr = null;
      if (client) {
        try {
          const { error } = await withTimeout(
            client.from('app_state').upsert({ id: rowId, data, updated_at: pushedAt }),
            10000, 'sdk-upsert');
          if (error) sdkErr = new Error(error.message || JSON.stringify(error));
        } catch (e) { sdkErr = e; }
      } else {
        sdkErr = new Error('no sdk client');
      }
      if (sdkErr) {
        transport = 'rest-fallback';
        try {
          await restUpsertRow(rowId, data, pushedAt);
          telemetry('push-sdk-failed-rest-ok', { sdkError: String(sdkErr).slice(0, 200) });
        } catch (e2) {
          console.warn('Pike[telemetry]: push-network-failed', sdkErr, e2);
          telemetry('push-failed', { sdk: String(sdkErr).slice(0, 200), rest: String(e2).slice(0, 200) });
          setMode('online');
          return;
        }
      }
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
      console.info('Pike[telemetry]: push-accepted', { pushedAt, bytes: serialized.length, transport });
      telemetry('push-accepted', { pushedAt, bytes: serialized.length, transport });
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
