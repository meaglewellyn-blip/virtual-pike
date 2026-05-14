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
    personal: { label: 'Personal', color: '#C9A6A1' },
    work:     { label: 'Work',     color: '#A8B4A0' },
  };

  // ── Edge Function helper ────────────────────────────────────────────────────
  // Contract: ALWAYS returns { status, body }. Never throws on a known HTTP
  // response — the caller is responsible for interpreting status and body.
  // Throws only on network-level failure (no response received).
  async function callEdge(params) {
    const url = new URL(EDGE_URL);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    let res;
    try {
      res = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${ANON_KEY}` },
      });
    } catch (netErr) {
      return { status: 0, body: { error: 'network_unreachable', detail: String(netErr) } };
    }
    let body = null;
    try { body = await res.json(); } catch (_) { body = { error: 'malformed_response' }; }
    return { status: res.status, body: body || {} };
  }

  // ── Connect: open Google OAuth popup ───────────────────────────────────────
  function connect(source) {
    // Open the popup synchronously on the click event so browsers allow it.
    // Then navigate it to the Google URL once the Edge Function responds.
    const popup = window.open('', 'gcal-auth', 'width=520,height=640,left=200,top=100');

    callEdge({ action: 'auth-url', source })
      .then(({ status, body }) => {
        const url = body && body.url;
        if (status !== 200 || !url) { popup?.close(); console.warn('Pike: gcal auth-url failed', { status, body }); return; }
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

  // ── Disconnect — explicit user action; intentionally clears that source's events
  function disconnect(source) {
    callEdge({ action: 'disconnect', source });   // fire-and-forget; new helper doesn't throw
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
  // Only commits if the status call succeeded. On failure we leave
  // calendarSources untouched so previously-known state survives.
  async function refreshStatus() {
    const { status, body } = await callEdge({ action: 'status' });
    if (status !== 200 || !Array.isArray(body && body.tokens)) {
      console.warn('Pike[telemetry]: gcal-status-failed', { status, body });
      return;
    }
    const tokens = body.tokens;
    Pike.state.commit((d) => {
      if (!d.calendarSources) d.calendarSources = {};
      Object.keys(SOURCES).forEach((src) => {
        if (!d.calendarSources[src]) d.calendarSources[src] = { connected: false };
      });
      // Preserve fields we don't replace (e.g. lastError, lastSynced) so a
      // status refresh doesn't wipe error/sync metadata from a previous fetch.
      tokens.forEach((t) => {
        const prev = d.calendarSources[t.id] || {};
        d.calendarSources[t.id] = {
          ...prev,
          connected: true,
          email: t.email,
          updatedAt: t.updated_at,
        };
      });
    });
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

  // ── Sync events for one source — STRICT COMMIT SAFETY ─────────────────────
  // GUARDRAIL (May 14 calendar regression fix): existing calendarEvents must
  // survive ALL failed auth, failed refresh, failed fetch, timeout, malformed
  // response, or reconnect-required states. Stale-but-valid historical
  // calendar data is preferable to accidental clearing.
  //
  // The events array is only REPLACED when:
  //   (a) the Edge Function returned HTTP 200, AND
  //   (b) the body has a top-level `events` field that is an Array
  // Anything else only updates calendarSources[source].lastError /
  // reconnectRequired / lastErrorAt — calendarEvents is left untouched.
  async function syncSource(source) {
    const { status, body } = await callEdge({ action: 'events', source });

    // ── Error paths: record error, NEVER touch calendarEvents ─────────────
    const isHardError =
      status !== 200 ||
      !body ||
      body.error != null ||
      !Array.isArray(body.events);

    if (isHardError) {
      const reason = (body && body.error) || `http_${status || 'unknown'}`;
      const reconnectRequired = !!(body && body.reconnectRequired) || status === 401;
      console.warn('Pike[telemetry]: gcal-sync-failed', {
        source, status, reason, reconnectRequired, detail: body && body.detail,
      });
      Pike.state.commit((d) => {
        if (!d.calendarSources) d.calendarSources = {};
        if (!d.calendarSources[source]) d.calendarSources[source] = {};
        d.calendarSources[source].lastError        = reason;
        d.calendarSources[source].lastErrorAt      = new Date().toISOString();
        d.calendarSources[source].reconnectRequired = reconnectRequired;
        // Crucially we do NOT touch d.calendarEvents here.
      });
      return { ok: false, reason, reconnectRequired };
    }

    // ── Success path: events is a valid array → replace ONLY this source ──
    const normalized = body.events
      .filter((e) => {
        if (e.status === 'cancelled') return false;
        const selfAttendee = (e.attendees || []).find((a) => a.self === true);
        if (selfAttendee && selfAttendee.responseStatus === 'declined') return false;
        return true;
      })
      .map((e) => normalizeEvent(e, source));

    Pike.state.commit((d) => {
      if (!d.calendarEvents) d.calendarEvents = [];
      // Replace events for THIS source only — events from other sources untouched
      d.calendarEvents = d.calendarEvents.filter((e) => e.source !== source);
      d.calendarEvents.push(...normalized);
      if (!d.calendarSources) d.calendarSources = {};
      if (!d.calendarSources[source]) d.calendarSources[source] = {};
      d.calendarSources[source].lastSynced = new Date().toISOString();
      d.calendarSources[source].connected  = true;
      // Clear error state on success
      delete d.calendarSources[source].lastError;
      delete d.calendarSources[source].lastErrorAt;
      delete d.calendarSources[source].reconnectRequired;
    });
    console.info('Pike[telemetry]: gcal-sync-success', { source, eventCount: normalized.length });
    return { ok: true, eventCount: normalized.length };
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
  // Surfaces sync state including error / reconnect-required states so
  // failures are never silent (the May 14 regression).
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function errorLabel(code) {
    switch (code) {
      case 'token_expired':       return 'Google access expired — reconnect needed.';
      case 'not_connected':       return 'Not connected.';
      case 'fetch_failed':        return 'Google API didn’t respond cleanly. Existing events preserved.';
      case 'network_unreachable': return 'Couldn’t reach the sync service. Existing events preserved.';
      case 'malformed_response':  return 'Sync service returned an unexpected response. Existing events preserved.';
      default:                    return 'Sync failed (' + code + '). Existing events preserved.';
    }
  }

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
      const hasError       = !!s.lastError;
      const needsReconnect = !!s.reconnectRequired;
      const errorMsg       = hasError ? errorLabel(s.lastError) : '';

      // Reconnect mode: the source was previously connected but its token is
      // dead. Show the same OAuth flow via a "Reconnect" button.
      const showReconnect = connected && needsReconnect;
      const showSyncOnly  = connected && !needsReconnect;

      return `
        <div class="gcal-source-row${hasError ? ' is-errored' : ''}">
          <div class="gcal-source-info">
            <span class="gcal-dot" style="background:${def.color}"></span>
            <div>
              <div class="gcal-source-label">${escapeHtml(def.label)}</div>
              ${s.email ? `<div class="gcal-source-email">${escapeHtml(s.email)}</div>` : ''}
              ${lastSync ? `<div class="gcal-source-sync">Synced ${escapeHtml(lastSync)}</div>` : ''}
              ${hasError ? `<div class="gcal-source-error">${escapeHtml(errorMsg)}</div>` : ''}
            </div>
          </div>
          <div class="gcal-source-btns">
            ${showReconnect
              ? `<button class="btn btn-primary btn-sm" data-gcal-connect="${id}" type="button">Reconnect</button>
                 <button class="btn btn-ghost btn-sm gcal-btn-disconnect" data-gcal-disc="${id}" type="button">Disconnect</button>`
              : showSyncOnly
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
    // Guard at the OUTER level — the previous version called Pike.state.commit
    // unconditionally and only checked field presence inside the mutator,
    // which still fired a push on every boot. That contributed to the
    // May 11 wipe (boot push of stale state). Only commit when truly needed.
    const data = Pike.state.data || {};
    if (!data.calendarEvents || !data.calendarSources) {
      Pike.state.commit((d) => {
        if (!d.calendarEvents)  d.calendarEvents  = [];
        if (!d.calendarSources) d.calendarSources = {};
      });
    }

    // Check who's connected, then pull their events
    refreshStatus().then(() => syncAll());

    // Auto-sync every 15 minutes
    setInterval(() => syncAll(), 15 * 60 * 1000);
  }

  Pike.gcal = { init, render, syncAll, syncSource, connect, disconnect, SOURCES, normalizeEvent };
})(window);
