/* Virtual Pike — Google Calendar Integration
 *
 * Public:
 *   Pike.gcal.init()         — init state keys, check status, start auto-sync
 *   Pike.gcal.render()       — re-render the settings UI
 *   Pike.gcal.syncAll()      — fetch events for all connected sources
 *   Pike.gcal.SOURCES        — source definitions { personal, work }
 *   Pike.gcal.normalizeEvent — convert a raw gcal event to Pike's shape
 */

(function (global) {
  'use strict';

  const Pike = global.Pike || (global.Pike = {});

  const EDGE_URL  = 'https://oenxkfheadicpixkywtz.supabase.co/functions/v1/gcal-proxy';
  const ANON_KEY  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9lbnhrZmhlYWRpY3BpeGt5d3R6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MDYzMzEsImV4cCI6MjA5MzI4MjMzMX0.bfVyJ0ysEoKn8Dr0suDAN1ftrJ6uq4JncIoK8FdFBtM';

  const SOURCES = {
    personal: { label: 'Personal', color: '#9b87d1' },
    work:     { label: 'Work',     color: '#5ba3b0' },
  };

  // ── Edge Function helper ────────────────────────────────────────────────────
  async function callEdge(params) {
    const url = new URL(EDGE_URL);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${ANON_KEY}` },
    });
    if (!res.ok && res.status !== 401) throw new Error(`Edge error ${res.status}`);
    return res.json();
  }

  // ── Connect: open Google OAuth popup ───────────────────────────────────────
  function connect(source) {
    // Open the popup synchronously on the click event so browsers allow it.
    // Then navigate it to the Google URL once the Edge Function responds.
    const popup = window.open('', 'gcal-auth', 'width=520,height=640,left=200,top=100');

    callEdge({ action: 'auth-url', source })
      .then(({ url }) => {
        if (!url) { popup?.close(); return; }
        popup.location.href = url;

        // Listen for postMessage from the success page
        function onMessage(e) {
          if (e.data?.type !== 'gcal-connected') return;
          window.removeEventListener('message', onMessage);
          clearInterval(poll);
          const src = e.data.source || source;
          syncSource(src).then(() => render());
        }
        window.addEventListener('message', onMessage);

        // Fallback: if popup closes without the message
        const poll = setInterval(() => {
          if (popup && popup.closed) {
            clearInterval(poll);
            window.removeEventListener('message', onMessage);
            refreshStatus().then(() => render());
          }
        }, 1000);
      })
      .catch((e) => { popup?.close(); console.warn('Pike: gcal connect error', e); });
  }

  // ── Disconnect ──────────────────────────────────────────────────────────────
  function disconnect(source) {
    callEdge({ action: 'disconnect', source }).catch(() => {});
    Pike.state.commit((d) => {
      if (d.calendarSources?.[source]) {
        d.calendarSources[source] = { connected: false, email: null };
      }
      if (d.calendarEvents) {
        d.calendarEvents = d.calendarEvents.filter((e) => e.source !== source);
      }
    });
    render();
  }

  // ── Check which sources have tokens in Supabase ─────────────────────────────
  async function refreshStatus() {
    try {
      const { tokens } = await callEdge({ action: 'status' });
      Pike.state.commit((d) => {
        if (!d.calendarSources) d.calendarSources = {};
        Object.keys(SOURCES).forEach((src) => {
          if (!d.calendarSources[src]) d.calendarSources[src] = { connected: false };
        });
        (tokens || []).forEach((t) => {
          d.calendarSources[t.id] = { connected: true, email: t.email, updatedAt: t.updated_at };
        });
      });
    } catch (e) {
      console.warn('Pike: gcal status check failed', e);
    }
  }

  // ── Normalize a raw Google Calendar event to Pike's shape ─────────────────
  function normalizeEvent(gcalEvent, source) {
    const startRaw = gcalEvent.start?.dateTime || gcalEvent.start?.date;
    const endRaw   = gcalEvent.end?.dateTime   || gcalEvent.end?.date;
    const isAllDay  = !gcalEvent.start?.dateTime;
    return {
      id:       `gcal-${source}-${gcalEvent.id}`,
      title:    gcalEvent.summary || '(No title)',
      date:     startRaw ? startRaw.slice(0, 10) : null,
      start:    isAllDay ? null : startRaw?.slice(11, 16),
      end:      isAllDay ? null : endRaw?.slice(11, 16),
      isAllDay,
      fixed:    true,
      source,
      gcalId:   gcalEvent.id,
    };
  }

  // ── Sync events for one source ──────────────────────────────────────────────
  async function syncSource(source) {
    try {
      const { events, error } = await callEdge({ action: 'events', source });
      if (error === 'not_connected') return;
      const normalized = (events || []).map((e) => normalizeEvent(e, source));
      Pike.state.commit((d) => {
        if (!d.calendarEvents) d.calendarEvents = [];
        d.calendarEvents = d.calendarEvents.filter((e) => e.source !== source);
        d.calendarEvents.push(...normalized);
        if (!d.calendarSources) d.calendarSources = {};
        if (!d.calendarSources[source]) d.calendarSources[source] = {};
        d.calendarSources[source].lastSynced = new Date().toISOString();
        d.calendarSources[source].connected  = true;
      });
    } catch (e) {
      console.warn(`Pike: gcal sync failed for ${source}`, e);
    }
  }

  // ── Sync all connected sources ──────────────────────────────────────────────
  async function syncAll() {
    const sources = Pike.state.data.calendarSources || {};
    await Promise.all(
      Object.entries(sources)
        .filter(([, v]) => v.connected)
        .map(([src]) => syncSource(src))
    );
  }

  // ── Render the settings UI ──────────────────────────────────────────────────
  function render() {
    const container = document.getElementById('gcal-settings');
    if (!container) return;

    const sources = Pike.state.data.calendarSources || {};

    container.innerHTML = Object.entries(SOURCES).map(([id, def]) => {
      const s         = sources[id] || {};
      const connected = s.connected;
      const lastSync  = s.lastSynced
        ? new Date(s.lastSynced).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : null;

      return `
        <div class="gcal-source-row">
          <div class="gcal-source-info">
            <span class="gcal-dot" style="background:${def.color}"></span>
            <div>
              <div class="gcal-source-label">${def.label}</div>
              ${s.email ? `<div class="gcal-source-email">${s.email}</div>` : ''}
              ${lastSync ? `<div class="gcal-source-sync">Synced ${lastSync}</div>` : ''}
            </div>
          </div>
          <div class="gcal-source-btns">
            ${connected
              ? `<button class="btn btn-ghost btn-sm" data-gcal-sync="${id}" type="button">Sync now</button>
                 <button class="btn btn-ghost btn-sm gcal-btn-disconnect" data-gcal-disc="${id}" type="button">Disconnect</button>`
              : `<button class="btn btn-primary btn-sm" data-gcal-connect="${id}" type="button">Connect</button>`}
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('[data-gcal-connect]').forEach((btn) => {
      btn.addEventListener('click', () => connect(btn.dataset.gcalConnect));
    });
    container.querySelectorAll('[data-gcal-disc]').forEach((btn) => {
      btn.addEventListener('click', () => disconnect(btn.dataset.gcalDisc));
    });
    container.querySelectorAll('[data-gcal-sync]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.textContent = 'Syncing…';
        btn.disabled = true;
        await syncSource(btn.dataset.gcalSync);
        render();
      });
    });
  }

  // ── Init ────────────────────────────────────────────────────────────────────
  function init() {
    Pike.state.commit((d) => {
      if (!d.calendarEvents)  d.calendarEvents  = [];
      if (!d.calendarSources) d.calendarSources = {};
    });

    // Check who's connected, then pull their events
    refreshStatus().then(() => syncAll());

    // Auto-sync every 15 minutes
    setInterval(() => syncAll(), 15 * 60 * 1000);
  }

  Pike.gcal = { init, render, syncAll, syncSource, connect, disconnect, SOURCES, normalizeEvent };
})(window);
