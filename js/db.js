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

  let client = null;
  let pushTimer = null;
  let lastPushedJson = null;
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
    if (!isConfigured()) {
      console.info('Pike: Supabase not configured — running in local-only mode.');
      setMode('local');
      return;
    }
    if (!global.supabase || typeof global.supabase.createClient !== 'function') {
      console.warn('Pike: supabase-js not loaded; falling back to local-only mode.');
      setMode('local');
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
      return;
    }
    pullOnce();
    subscribe();
  }

  async function pullOnce() {
    if (!client) return;
    const rowId = global.Pike.state.rowId;
    try {
      const { data, error } = await client
        .from('app_state')
        .select('data, updated_at')
        .eq('id', rowId)
        .maybeSingle();
      if (error) { console.warn('Pike: pull failed', error); return; }
      if (data && data.data) {
        global.Pike.state.replace(data.data);
      }
    } catch (e) {
      console.warn('Pike: pull threw', e);
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
          if (payload && payload.new && payload.new.data) {
            const incoming = JSON.stringify(payload.new.data);
            if (incoming !== lastPushedJson) {
              global.Pike.state.replace(payload.new.data);
            }
          }
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
    setMode('syncing');
    const rowId = global.Pike.state.rowId;
    const serialized = JSON.stringify(data);
    try {
      const { error } = await client
        .from('app_state')
        .upsert({ id: rowId, data, updated_at: new Date().toISOString() });
      if (error) { console.warn('Pike: push failed', error); setMode('online'); return; }
      lastPushedJson = serialized;
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
