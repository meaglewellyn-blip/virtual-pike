/* Virtual Pike — boot sequence
 *
 * Order:
 *   1. Initialize state (already done by state.js IIFE)
 *   2. Initialize DB (Supabase if configured; otherwise local-only)
 *   3. Initialize router
 *   4. Render the active section
 *   5. Wire global UI: sync indicator, today greeting/anchor placeholder, time tick
 *   6. Register service worker for PWA install
 */

(function () {
  'use strict';

  const Pike = window.Pike || {};

  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayKey(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function fmtTime(d = new Date()) {
    let h = d.getHours();
    const m = pad2(d.getMinutes());
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  }
  function parseHHMM(s) {
    const [h, m] = (s || '').split(':').map(Number);
    if (Number.isFinite(h) && Number.isFinite(m)) return { h, m };
    return null;
  }
  function minutesUntil(targetHHMM, from = new Date()) {
    const t = parseHHMM(targetHHMM);
    if (!t) return null;
    const target = new Date(from);
    target.setHours(t.h, t.m, 0, 0);
    return Math.round((target - from) / 60000);
  }
  function fmtDuration(mins) {
    if (mins == null) return '';
    if (mins <= 0) return 'now';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }
  function greeting(d = new Date()) {
    const h = d.getHours();
    if (h < 5)  return 'Late night';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 21) return 'Good evening';
    return 'Quiet night';
  }

  function isWeekend(d) {
    const day = d.getDay();
    return day === 0 || day === 6;
  }

  function weekendDayName(d) {
    return d.getDay() === 6 ? 'Saturday' : 'Sunday';
  }

  function renderTodayPlaceholder() {
    const data = Pike.state.data;
    const now = new Date();
    const key = todayKey(now);

    const greetEl = document.getElementById('today-greeting');
    const subEl   = document.getElementById('today-subgreeting');
    const timeEl  = document.getElementById('today-anchor-time');
    const textEl  = document.getElementById('today-anchor-text');
    const inputEl = document.getElementById('today-workday-start');
    const inputLabel = document.querySelector('.today-anchor-input label[for="today-workday-start"]');

    if (greetEl) greetEl.textContent = greeting(now) + '.';
    if (subEl) {
      const dateLabel = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      subEl.textContent = dateLabel;
    }
    if (timeEl) timeEl.textContent = fmtTime(now);

    const override = (data.dailyOverrides && data.dailyOverrides[key]) || null;
    const hasOverride = !!(override && override.workdayStart);
    const weekend = isWeekend(now);

    // On weekends, skip the default workday — only honor an explicit override.
    const workdayStart = hasOverride
      ? override.workdayStart
      : (weekend ? null : data.settings.defaultWorkdayStart);

    if (inputEl) inputEl.value = workdayStart || '';
    if (inputLabel) {
      inputLabel.textContent = weekend && !hasOverride
        ? 'Working today? Set a start time'
        : 'Starting work today at';
    }

    // Toggle a class so CSS can style the weekend-with-no-override state distinctly
    const anchorInputRow = document.querySelector('.today-anchor-input');
    if (anchorInputRow) {
      anchorInputRow.classList.toggle('is-weekend-open', weekend && !hasOverride);
    }

    if (textEl) {
      if (weekend && !hasOverride) {
        const dayName = weekendDayName(now);
        textEl.innerHTML = `It's <strong>${dayName}</strong> — open hours, no workday on the books.`;
      } else if (!workdayStart) {
        textEl.innerHTML = `Set a workday start time below to see how much open time you have.`;
      } else {
        const mins = minutesUntil(workdayStart, now);
        if (mins == null) {
          textEl.innerHTML = `Workday starts at <strong>${workdayStart}</strong>.`;
        } else if (mins > 0) {
          textEl.innerHTML = `You're starting work at <strong>${workdayStart}</strong> — that's <strong>${fmtDuration(mins)}</strong> of open time before then.`;
        } else if (mins === 0) {
          textEl.innerHTML = `You're starting work <strong>now</strong>.`;
        } else {
          textEl.innerHTML = `Your workday started at <strong>${workdayStart}</strong> (${fmtDuration(-mins)} ago).`;
        }
      }
    }
  }

  function wireWorkdayInput() {
    const inputEl = document.getElementById('today-workday-start');
    if (!inputEl) return;

    inputEl.addEventListener('change', () => {
      const value = inputEl.value;
      const key = todayKey();
      Pike.state.commit((d) => {
        if (!d.dailyOverrides) d.dailyOverrides = {};
        if (!value) {
          delete d.dailyOverrides[key];
        } else {
          d.dailyOverrides[key] = { ...(d.dailyOverrides[key] || {}), workdayStart: value };
        }
      });
      renderTodayPlaceholder();
    });
  }

  function wireSyncIndicator() {
    const dot = document.getElementById('sync-dot');
    const label = document.getElementById('sync-label');
    function update(mode) {
      if (!dot || !label) return;
      dot.classList.remove('is-online', 'is-syncing', 'is-local');
      if (mode === 'online')  { dot.classList.add('is-online');  label.textContent = 'Synced'; }
      else if (mode === 'syncing') { dot.classList.add('is-syncing'); label.textContent = 'Syncing…'; }
      else                    { dot.classList.add('is-local');   label.textContent = 'Local only'; }
    }
    update(Pike.db && Pike.db.getMode ? Pike.db.getMode() : 'local');
    document.addEventListener('pike:syncmode', (e) => update(e.detail.mode));
  }

  function tick() {
    renderTodayPlaceholder();
    if (Pike.today) Pike.today.render();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol === 'file:') return;  // SW won't register on file://
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch((e) => {
        console.info('Pike: service worker registration skipped', e);
      });
    });
  }

  function boot() {
    if (Pike.auth) Pike.auth.init();
    if (Pike.db) Pike.db.init();
    if (Pike.router) Pike.router.init();
    if (Pike.modal) Pike.modal.init();
    if (Pike.today) Pike.today.init();
    if (Pike.week) Pike.week.init();
    if (Pike.rhythms) Pike.rhythms.init();
    if (Pike.travel) Pike.travel.init();
    if (Pike.people) Pike.people.init();
    if (Pike.tasks) Pike.tasks.init();
    if (Pike.braindump) Pike.braindump.init();
    if (Pike.quotes) Pike.quotes.init();
    if (Pike.gcal) Pike.gcal.init();

    wireSyncIndicator();
    wireWorkdayInput();
    renderTodayPlaceholder();
    // Migrations (idempotent — run once, no-op after):
    // 1. daily rhythms → isDefaultDaily library tasks
    // 2. daily/everyWeekend recurrences → pruned/promoted (new bucket model)
    if (Pike.recurrence) Pike.recurrence.migrateDailyRhythmsToDefaults();
    if (Pike.recurrence) Pike.recurrence.migrateLegacyRecurrences();
    if (Pike.recurrence) Pike.recurrence.run();
    if (Pike.recurrence) Pike.recurrence.runDailyDefaults();
    if (Pike.today) Pike.today.render();
    if (Pike.week) Pike.week.render();
    if (Pike.rhythms) Pike.rhythms.render();
    if (Pike.travel) Pike.travel.render();
    if (Pike.people) Pike.people.render();
    if (Pike.tasks) Pike.tasks.render();
    if (Pike.braindump) Pike.braindump.render();
    if (Pike.quotes) { Pike.quotes.render(); Pike.quotes.initLibrary(); }
    if (Pike.gcal) Pike.gcal.render();
    if (Pike.weather) Pike.weather.load();

    Pike.state.on(() => {
      renderTodayPlaceholder();
      // Run recurrence engine on every state change. It's idempotent — most
      // calls are a quick no-op once today's tasks are already generated.
      if (Pike.recurrence) Pike.recurrence.migrateDailyRhythmsToDefaults();
      if (Pike.recurrence) Pike.recurrence.migrateLegacyRecurrences();
      if (Pike.recurrence) Pike.recurrence.run();
      if (Pike.recurrence) Pike.recurrence.runDailyDefaults();
      if (Pike.today) Pike.today.render();
      // quotes.init() is idempotent — seeds only if quotes array is missing or empty.
      // Running it here ensures quotes survive a db pullOnce replacing state.
      if (Pike.week) Pike.week.render();
      if (Pike.rhythms) { Pike.rhythms.init(); Pike.rhythms.render(); }
      if (Pike.travel) Pike.travel.render();
      if (Pike.people) { Pike.people.init(); Pike.people.render(); }
      if (Pike.tasks) Pike.tasks.render();
      if (Pike.braindump) { Pike.braindump.init(); Pike.braindump.render(); }
      if (Pike.quotes) { Pike.quotes.init(); Pike.quotes.render(); Pike.quotes.renderLibrary(); }
      if (Pike.gcal) Pike.gcal.render();
    });

    setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
