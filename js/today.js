/* Virtual Pike — Today view (timeline + tray + event/task modals)
 *
 * Public:
 *   Pike.today.init()     — wire DOM listeners (run once on boot)
 *   Pike.today.render()   — re-render the timeline + tray (run on state change & every minute)
 */

(function (global) {
  'use strict';

  // ===== Config =====
  const HOUR_HEIGHT_PX = 64;        // must match --hour-h in today.css
  const SNAP_MINUTES   = 15;        // drag-drop snaps to this grid

  // ===== Date/time helpers =====
  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayKey(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function parseHHMM(s) {
    if (!s) return null;
    const [h, m] = s.split(':').map(Number);
    if (Number.isFinite(h) && Number.isFinite(m)) return h * 60 + m;
    return null;
  }
  function fmtHHMM(totalMinutes) {
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${pad2(h)}:${pad2(m)}`;
  }
  function fmtClock(totalMinutes) {
    let h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return `${h}:${pad2(m)} ${ampm}`;
  }
  function fmtDuration(mins) {
    if (mins == null || mins <= 0) return '';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }
  function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Parse a duration string entered by the user.
   * Accepts: "75", "75m", "1h", "1h15", "1h 15m", "1.5h", "1:15"
   * Returns minutes (number) or null if unparseable.
   */
  function parseDuration(input) {
    if (input == null) return null;
    const s = String(input).trim().toLowerCase();
    if (!s) return null;

    // "1:15" -> 75
    const colon = s.match(/^(\d{1,2}):(\d{1,2})$/);
    if (colon) return Number(colon[1]) * 60 + Number(colon[2]);

    // pure number -> minutes
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) ? Math.round(n) : null;
    }

    // "1h", "1.5h", "1h15", "1h15m", "30m"
    let total = 0;
    let matched = false;
    const hMatch = s.match(/(\d+(?:\.\d+)?)\s*h/);
    if (hMatch) { total += Math.round(Number(hMatch[1]) * 60); matched = true; }
    const mMatch = s.match(/(\d+)\s*m\b/);
    if (mMatch) { total += Number(mMatch[1]); matched = true; }
    // trailing bare minutes after "1h 15"
    if (matched) {
      const trailing = s.match(/h\s*(\d+)\s*$/);
      if (trailing && !mMatch) total += Number(trailing[1]);
      return total;
    }
    return null;
  }

  /**
   * Parse a flexible time string entered by the user.
   * Accepts: "2:30 PM", "14:30", "2:30", "2:30pm", "1430", "10"
   * Returns HH:MM string (24-hour) or null if unparseable.
   */
  function parseFlexTime(input) {
    if (!input) return null;
    const s = String(input).trim().toLowerCase().replace(/\s+/g, '').replace(/([ap])$/, '$1m');
    if (!s) return null;

    // "2:30pm", "14:30", "2:30"
    const colonMatch = s.match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
    if (colonMatch) {
      let h = parseInt(colonMatch[1], 10);
      const m = parseInt(colonMatch[2], 10);
      const ap = colonMatch[3];
      if (ap === 'pm' && h !== 12) h += 12;
      else if (ap === 'am' && h === 12) h = 0;
      if (h >= 0 && h < 24 && m >= 0 && m < 60) return `${pad2(h)}:${pad2(m)}`;
      return null;
    }

    // "1430", "230" (no colon)
    const bareMatch = s.match(/^(\d{3,4})(am|pm)?$/);
    if (bareMatch) {
      const digits = bareMatch[1];
      const ap = bareMatch[2];
      let h, m;
      if (digits.length === 4) { h = parseInt(digits.slice(0, 2), 10); m = parseInt(digits.slice(2), 10); }
      else { h = parseInt(digits.slice(0, 1), 10); m = parseInt(digits.slice(1), 10); }
      if (ap === 'pm' && h !== 12) h += 12;
      else if (ap === 'am' && h === 12) h = 0;
      if (h >= 0 && h < 24 && m >= 0 && m < 60) return `${pad2(h)}:${pad2(m)}`;
      return null;
    }

    // Bare hour: "2pm", "10am", "14"
    const hourMatch = s.match(/^(\d{1,2})(am|pm)?$/);
    if (hourMatch) {
      let h = parseInt(hourMatch[1], 10);
      const ap = hourMatch[2];
      if (ap === 'pm' && h !== 12) h += 12;
      else if (ap === 'am' && h === 12) h = 0;
      if (h >= 0 && h < 24) return `${pad2(h)}:00`;
      return null;
    }

    return null;
  }

  // Format a stored HH:MM value for display in a text input (e.g. "14:30" → "2:30 PM")
  function fmtTimeInput(hhmm) {
    if (!hhmm) return '';
    const mins = parseHHMM(hhmm);
    if (mins == null) return hhmm;
    return fmtClock(mins);
  }

  // ===== State accessors =====
  function getData() { return global.Pike.state.data; }
  function getTimelineRange() {
    const settings = getData().settings || {};
    const startMin = parseHHMM(settings.dayStart) ?? 5 * 60;
    const endMin   = parseHHMM(settings.dayEnd)   ?? 23 * 60;
    return { startMin, endMin };
  }
  function minutesToPx(totalMinutes) {
    const { startMin } = getTimelineRange();
    return ((totalMinutes - startMin) / 60) * HOUR_HEIGHT_PX;
  }

  // ===== Render =====
  function render() {
    renderTimeline();
    renderTray();
    renderTodayRhythms();
    if (global.Pike.travel) global.Pike.travel.renderTripPrepForToday();
  }

  function renderTodayRhythms() {
    const wrap = document.querySelector('.today-timeline-wrap');
    if (!wrap) return;

    const existing = wrap.querySelector('.today-rhythm-list-wrap');
    if (existing) existing.remove();

    if (!global.Pike.rhythms) return;

    const today = new Date();
    const todayDayName = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][today.getDay()];
    const isWeekend = today.getDay() === 0 || today.getDay() === 6;

    // Note: 'daily' rhythms are NOT shown here — they are daily-default tasks
    // that live in the Flexible tray (auto-populated by recurrence.runDailyDefaults).
    const rhythms = (getData().rhythms || []).filter((r) => {
      if (!r.active || !r.schedule) return false;
      const s = r.schedule;
      if (s.type === 'weekdays') return !isWeekend;
      if (s.type === 'weekends') return isWeekend;
      if (s.type === 'weekly')   return s.day === todayDayName;
      return false;
    });

    if (!rhythms.length) return;

    const container = document.createElement('div');
    container.className = 'today-rhythm-list-wrap';

    const list = document.createElement('ul');
    list.className = 'today-rhythm-list';

    // Helper: build a single list item with check, title, duration, drag + schedule button
    function buildRhythmLi({ isDone, title, estimateMinutes, onDone, rhythmRef }) {
      const li = document.createElement('li');
      li.className = 'today-rhythm-item' + (isDone ? ' is-done' : '');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'today-rhythm-check';
      btn.setAttribute('aria-label', isDone ? title + ' done' : 'Mark ' + title + ' done');
      btn.setAttribute('aria-pressed', isDone ? 'true' : 'false');
      if (isDone) btn.textContent = '✓';

      const titleEl = document.createElement('span');
      titleEl.className = 'today-rhythm-title';
      titleEl.textContent = title;

      li.appendChild(btn);
      li.appendChild(titleEl);

      if (estimateMinutes && !isDone) {
        const dur = document.createElement('span');
        dur.className = 'today-rhythm-dur';
        dur.textContent = fmtDuration(estimateMinutes);
        li.appendChild(dur);
      }

      if (!isDone) {
        btn.addEventListener('click', onDone);

        // Draggable — drag straight onto the timeline
        li.draggable = true;
        li.addEventListener('dragstart', (e) => {
          li.classList.add('is-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', JSON.stringify({ rhythmRef }));
        });
        li.addEventListener('dragend', () => li.classList.remove('is-dragging'));

        // Schedule button — click to pick a time without dragging
        const schedBtn = document.createElement('button');
        schedBtn.type = 'button';
        schedBtn.className = 'today-rhythm-sched-btn';
        schedBtn.setAttribute('aria-label', 'Schedule on timeline');
        schedBtn.textContent = '→';
        schedBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openRhythmScheduleModal(rhythmRef);
        });
        li.appendChild(schedBtn);
      }

      return li;
    }

    rhythms.forEach((r) => {
      if (r.subtasks && r.subtasks.length) {
        const allocated = global.Pike.rhythms.getAllocatedSubtasksForDay(r, today);
        if (allocated === null) {
          // Not planned yet — show a nudge button
          const li = document.createElement('li');
          li.className = 'today-rhythm-item today-rhythm-nudge';
          const planBtn = document.createElement('button');
          planBtn.type = 'button';
          planBtn.className = 'today-rhythm-plan-btn';
          planBtn.textContent = 'Plan ' + r.title;
          planBtn.addEventListener('click', () => global.Pike.rhythms.openPlanWeekendModal(r));
          li.appendChild(planBtn);
          list.appendChild(li);
        } else {
          allocated.forEach((sub) => {
            const isDone = global.Pike.rhythms.isSubtaskDone(r, sub.id, today);
            list.appendChild(buildRhythmLi({
              isDone,
              title: sub.title,
              estimateMinutes: sub.estimateMinutes,
              onDone: () => global.Pike.rhythms.markSubtaskDone(r.id, sub.id, today),
              rhythmRef: { rhythmId: r.id, subtaskId: sub.id, title: sub.title, estimateMinutes: sub.estimateMinutes || 30 },
            }));
          });
        }
      } else {
        // Regular atomic rhythm (daily, weekly, etc.)
        const isDone = global.Pike.rhythms.isRhythmDoneThisPeriod(r, today);
        list.appendChild(buildRhythmLi({
          isDone,
          title: r.title,
          estimateMinutes: r.estimateMinutes,
          onDone: () => global.Pike.rhythms.markRhythmDone(r.id, today),
          rhythmRef: { rhythmId: r.id, subtaskId: null, title: r.title, estimateMinutes: r.estimateMinutes || 30 },
        }));
      }
    });

    container.appendChild(list);
    wrap.appendChild(container);
  }

  function renderTimeline() {
    const root = document.getElementById('today-timeline');
    if (!root) return;

    const { startMin, endMin } = getTimelineRange();
    const totalHours = Math.max(1, (endMin - startMin) / 60);
    root.style.height = (totalHours * HOUR_HEIGHT_PX) + 'px';

    // Clear and rebuild
    root.innerHTML = '';

    // Hour rows
    for (let m = startMin; m < endMin; m += 60) {
      const row = document.createElement('div');
      row.className = 'tl-hour-row';
      row.dataset.minutes = String(m);
      row.dataset.label = fmtClock(m).replace(':00 ', ' ');  // "5 AM" instead of "5:00 AM"
      root.appendChild(row);
    }

    // Track (events + scheduled tasks render onto this)
    const track = document.createElement('div');
    track.className = 'tl-track';
    root.appendChild(track);

    // Workday-start marker (skipped on weekends unless an override exists)
    const data = getData();
    const tk = todayKey();
    const override = (data.dailyOverrides || {})[tk] || null;
    const hasOverride = !!(override && override.workdayStart);
    const todayDate = new Date();
    const isWknd = todayDate.getDay() === 0 || todayDate.getDay() === 6;
    const workdayStart = hasOverride
      ? override.workdayStart
      : (isWknd ? null : data.settings.defaultWorkdayStart);
    const wsMin = parseHHMM(workdayStart);
    if (wsMin != null && wsMin >= startMin && wsMin <= endMin) {
      const ws = document.createElement('div');
      ws.className = 'tl-workstart';
      ws.style.top = minutesToPx(wsMin) + 'px';
      const wsLabel = document.createElement('div');
      wsLabel.className = 'tl-workstart-label';
      wsLabel.textContent = `Workday · ${fmtClock(wsMin)}`;
      ws.appendChild(wsLabel);
      root.appendChild(ws);
    }

    // Build the list of blocks for today (events + scheduled tasks)
    const blocks = collectTodayBlocks();
    blocks.forEach((b) => track.appendChild(renderBlock(b)));

    // Empty hint
    if (blocks.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'tl-empty-hint';
      hint.innerHTML = 'Nothing scheduled. Tap <strong>+ Event</strong> to add one, or drag a task in from the right.';
      root.appendChild(hint);
    }

    // Now-line
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin >= startMin && nowMin <= endMin) {
      const nl = document.createElement('div');
      nl.className = 'tl-now';
      nl.style.top = minutesToPx(nowMin) + 'px';
      const lbl = document.createElement('div');
      lbl.className = 'tl-now-label';
      lbl.textContent = fmtClock(nowMin);
      nl.appendChild(lbl);
      root.appendChild(nl);
    }

    // Wire drag-and-drop drop targets
    wireDropTarget(root);
  }

  function collectTodayBlocks() {
    const data = getData();
    const tk = todayKey();
    const out = [];

    (data.events || []).forEach((e) => {
      if (e.date !== tk) return;
      const sm = parseHHMM(e.start);
      const em = parseHHMM(e.end);
      if (sm == null || em == null || em <= sm) return;
      out.push({ kind: 'event', id: e.id, title: e.title, startMin: sm, endMin: em, raw: e });
    });

    // Google Calendar events
    (data.calendarEvents || []).forEach((e) => {
      if (e.date !== tk || e.isAllDay || !e.start || !e.end) return;
      const sm = parseHHMM(e.start);
      const em = parseHHMM(e.end);
      if (sm == null || em == null || em <= sm) return;
      out.push({ kind: 'gcal', id: e.id, title: e.title, startMin: sm, endMin: em, source: e.source, raw: e });
    });

    (data.tasks || []).forEach((t) => {
      if (t.scheduledDate !== tk) return;
      if (!t.scheduledStart) return;  // unscheduled tasks live in the tray
      const sm = parseHHMM(t.scheduledStart);
      if (sm == null) return;
      const em = sm + Math.max(15, t.estimateMinutes || 30);
      out.push({ kind: 'task', id: t.id, title: t.title, startMin: sm, endMin: em, completed: !!t.completedAt, raw: t });
    });

    out.sort((a, b) => a.startMin - b.startMin);
    return out;
  }

  function renderBlock(b) {
    const el = document.createElement('div');
    if (b.kind === 'event')      el.className = 'tl-block tl-block-event';
    else if (b.kind === 'gcal')  el.className = 'tl-block tl-block-gcal';
    else                         el.className = 'tl-block tl-block-task';
    if (b.completed) el.classList.add('is-completed');
    if (b.source)    el.dataset.source = b.source;

    const top = minutesToPx(b.startMin);
    const height = Math.max(28, (b.endMin - b.startMin) / 60 * HOUR_HEIGHT_PX);
    el.style.top = top + 'px';
    el.style.height = height + 'px';

    el.dataset.kind = b.kind;
    el.dataset.id = b.id;

    const title = document.createElement('div');
    title.className = 'tl-block-title';
    title.textContent = b.title;
    el.appendChild(title);

    if (height >= 36) {
      const time = document.createElement('div');
      time.className = 'tl-block-time';
      time.textContent = `${fmtClock(b.startMin)} – ${fmtClock(b.endMin)}`;
      el.appendChild(time);
    }

    if (b.kind === 'gcal') {
      // Read-only — show a source badge, no click-to-edit
      const srcDef = global.Pike.gcal?.SOURCES?.[b.source];
      if (srcDef && height >= 32) {
        const badge = document.createElement('div');
        badge.className = 'tl-block-src-badge';
        badge.textContent = srcDef.label;
        el.appendChild(badge);
      }
    } else {
      el.addEventListener('click', () => {
        if (b.kind === 'event') openEventModal(b.raw);
        else openTaskModal(b.raw);
      });
      // Draggable for rescheduling — preserve duration, move start
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        el.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', JSON.stringify({
          reschedule: { kind: b.kind, id: b.id, durationMinutes: b.endMin - b.startMin }
        }));
      });
      el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
    }

    return el;
  }

  function renderTray() {
    const list = document.getElementById('today-tray-list');
    const empty = document.getElementById('today-tray-empty');
    if (!list) return;

    list.innerHTML = '';

    const data = getData();
    const tk = todayKey();
    const tasks = (data.tasks || []).filter((t) =>
      t.scheduledDate === tk && !t.scheduledStart && !t.completedAt
    );

    if (tasks.length === 0) {
      if (empty) empty.hidden = false;
      return;
    }
    if (empty) empty.hidden = true;

    tasks.forEach((t) => list.appendChild(renderTrayTask(t)));
  }

  function renderTrayTask(task) {
    const el = document.createElement('div');
    el.className = 'tray-task';
    el.draggable = true;
    el.dataset.id = task.id;

    const title = document.createElement('div');
    title.className = 'tray-task-title';
    title.textContent = task.title;
    el.appendChild(title);

    if (task.estimateMinutes) {
      const meta = document.createElement('div');
      meta.className = 'tray-task-meta';
      meta.textContent = fmtDuration(task.estimateMinutes);
      el.appendChild(meta);
    }

    el.addEventListener('click', () => openTaskModal(task));

    el.addEventListener('dragstart', (e) => {
      el.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', JSON.stringify({ taskId: task.id }));
    });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));

    return el;
  }

  // ===== Drag and drop =====
  function wireDropTarget(root) {
    let indicator = null;
    function ensureIndicator() {
      if (indicator && indicator.parentNode === root) return indicator;
      indicator = document.createElement('div');
      indicator.className = 'tl-drop-indicator';
      root.appendChild(indicator);
      return indicator;
    }
    function removeIndicator() {
      if (indicator && indicator.parentNode) indicator.parentNode.removeChild(indicator);
      indicator = null;
    }

    function snappedMinutesFromEvent(e) {
      const rect = root.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const { startMin } = getTimelineRange();
      const rawMin = startMin + (y / HOUR_HEIGHT_PX) * 60;
      const snapped = Math.round(rawMin / SNAP_MINUTES) * SNAP_MINUTES;
      return snapped;
    }

    root.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      root.classList.add('is-drop-target');
      const min = snappedMinutesFromEvent(e);
      const ind = ensureIndicator();
      ind.style.top = minutesToPx(min) + 'px';
    });

    root.addEventListener('dragleave', (e) => {
      // only clear if we left the timeline element itself (not children)
      if (!root.contains(e.relatedTarget)) {
        root.classList.remove('is-drop-target');
        removeIndicator();
      }
    });

    root.addEventListener('drop', (e) => {
      e.preventDefault();
      root.classList.remove('is-drop-target');
      removeIndicator();
      let payload;
      try { payload = JSON.parse(e.dataTransfer.getData('text/plain') || '{}'); }
      catch (_) { payload = {}; }
      const min = snappedMinutesFromEvent(e);
      if (payload.taskId) {
        scheduleTaskAt(payload.taskId, min);
      } else if (payload.rhythmRef) {
        scheduleRhythmRefAt(payload.rhythmRef, min);
      } else if (payload.reschedule) {
        rescheduleBlock(payload.reschedule, min);
      }
    });
  }

  function scheduleTaskAt(taskId, startMinutes) {
    global.Pike.state.commit((d) => {
      const t = (d.tasks || []).find((x) => x.id === taskId);
      if (!t) return;
      t.scheduledDate = todayKey();
      t.scheduledStart = fmtHHMM(startMinutes);
    });
  }

  // Schedule a rhythm item (subtask or atomic) onto the timeline by creating a task entry
  function scheduleRhythmRefAt(ref, startMinutes) {
    const tk = todayKey();
    global.Pike.state.commit((d) => {
      d.tasks = d.tasks || [];
      // If already scheduled today for this ref, just update the time
      const existing = d.tasks.find(
        (t) => t.isRhythmRef && t.rhythmId === ref.rhythmId &&
               (t.subtaskId || null) === (ref.subtaskId || null) &&
               t.scheduledDate === tk
      );
      if (existing) {
        existing.scheduledStart = fmtHHMM(startMinutes);
      } else {
        d.tasks.push({
          id: uid('tsk'),
          title: ref.title,
          estimateMinutes: ref.estimateMinutes || 30,
          scheduledDate: tk,
          scheduledStart: fmtHHMM(startMinutes),
          completedAt: null,
          isRhythmRef: true,
          rhythmId: ref.rhythmId,
          subtaskId: ref.subtaskId || null,
          category: 'self',
        });
      }
    });
  }

  // Move an already-scheduled block to a new start time (preserves duration)
  function rescheduleBlock(info, startMinutes) {
    global.Pike.state.commit((d) => {
      if (info.kind === 'task') {
        const t = (d.tasks || []).find((x) => x.id === info.id);
        if (t) t.scheduledStart = fmtHHMM(startMinutes);
      } else if (info.kind === 'event') {
        const ev = (d.events || []).find((x) => x.id === info.id);
        if (ev) {
          const oldStart = parseHHMM(ev.start);
          const oldEnd   = parseHHMM(ev.end);
          const duration = (oldStart != null && oldEnd != null)
            ? (oldEnd - oldStart)
            : info.durationMinutes;
          ev.start = fmtHHMM(startMinutes);
          ev.end   = fmtHHMM(startMinutes + duration);
        }
      }
    });
  }

  // Modal to pick a time before scheduling a rhythm item
  function openRhythmScheduleModal(ref) {
    const form = document.createElement('form');
    form.innerHTML = `
      <p class="tasks-schedule-hint">
        Scheduling: <strong>${escapeAttr(ref.title)}</strong>${ref.estimateMinutes ? ` · ${fmtDuration(ref.estimateMinutes)}` : ''}
      </p>
      <label>
        <span>Start time</span>
        <input type="text" class="input" name="time" autocomplete="off"
               placeholder="e.g. 10:00 AM" required autofocus>
      </label>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">Add to timeline</button>
      </div>
    `;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const timeStr = parseFlexTime(String(new FormData(form).get('time') || '').trim());
      if (!timeStr) { alertInlineError(form, 'Enter a valid time, e.g. 10:00 AM.'); return; }
      const startMin = parseHHMM(timeStr);
      if (startMin == null) return;
      scheduleRhythmRefAt(ref, startMin);
      global.Pike.modal.close();
    });
    global.Pike.modal.open({ title: 'Schedule on timeline', body: form });
  }

  // ===== Modals: event / task =====
  function openEventModal(existing = null, defaultDate = null) {
    const isEdit = !!existing;
    const tk = defaultDate || todayKey();
    const initial = existing || { id: uid('evt'), title: '', date: tk, start: '', end: '' };

    const form = document.createElement('form');
    form.id = 'today-event-form';
    form.innerHTML = `
      <label>
        <span>Title</span>
        <input type="text" class="input" name="title" required maxlength="80" value="${escapeAttr(initial.title)}" autocomplete="off">
      </label>
      <label>
        <span>Date</span>
        <input type="date" class="input" name="date" required value="${escapeAttr(initial.date || tk)}">
      </label>
      <div class="row" style="gap: var(--space-3);">
        <label style="flex:1;">
          <span>Start</span>
          <input type="text" class="input" name="start" required autocomplete="off"
            placeholder="e.g. 10:00 AM"
            value="${escapeAttr(fmtTimeInput(initial.start))}">
        </label>
        <label style="flex:1;">
          <span>End</span>
          <input type="text" class="input" name="end" required autocomplete="off"
            placeholder="e.g. 11:30 AM"
            value="${escapeAttr(fmtTimeInput(initial.end))}">
        </label>
      </div>
      <div class="pike-modal-actions">
        ${isEdit ? '<button type="button" class="btn btn-danger" data-action="delete">Delete</button>' : ''}
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add event'}</button>
      </div>
    `;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const title = String(fd.get('title') || '').trim();
      const date  = String(fd.get('date')  || tk);
      const start = parseFlexTime(String(fd.get('start') || ''));
      const end   = parseFlexTime(String(fd.get('end')   || ''));
      if (!title) return;
      if (!start) { alertInlineError(form, 'Enter a start time, e.g. 10:00 AM or 14:00.'); return; }
      if (!end)   { alertInlineError(form, 'Enter an end time, e.g. 11:30 AM or 15:00.'); return; }
      const sm = parseHHMM(start);
      const em = parseHHMM(end);
      if (sm == null || em == null || em <= sm) {
        alertInlineError(form, 'End time must be after start time.');
        return;
      }
      global.Pike.state.commit((d) => {
        d.events = d.events || [];
        if (isEdit) {
          const idx = d.events.findIndex((x) => x.id === initial.id);
          if (idx >= 0) d.events[idx] = { ...d.events[idx], title, date, start, end };
        } else {
          d.events.push({ id: initial.id, title, date, start, end, fixed: true, source: 'manual' });
        }
      });
      global.Pike.modal.close();
    });

    form.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      if (!confirm('Delete this event?')) return;
      global.Pike.state.commit((d) => {
        d.events = (d.events || []).filter((x) => x.id !== initial.id);
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: isEdit ? 'Edit event' : 'New event', body: form });
  }

  function openTaskModal(existing = null) {
    const isEdit = !!existing;
    const tk = todayKey();
    const initial = existing || {
      id: uid('tsk'),
      title: '',
      estimateMinutes: 30,
      scheduledDate: tk,
      scheduledStart: null,
      completedAt: null,
    };

    const form = document.createElement('form');
    form.id = 'today-task-form';

    const isScheduled = !!initial.scheduledStart;

    const library = !isEdit && global.Pike.recurrence
      ? global.Pike.recurrence.manualRecurrences()
      : [];
    const libraryHTML = library.length ? `
      <div class="task-library">
        <div class="task-library-eyebrow">Or pull from your library</div>
        <div class="task-library-list">
          ${library.map((r) => `
            <button type="button" class="task-library-item" data-library-id="${escapeAttr(r.id)}">
              <span class="task-library-title">${escapeAttr(r.title)}</span>
              <span class="task-library-mins">${escapeAttr(fmtDuration(r.estimateMinutes) || '')}</span>
            </button>
          `).join('')}
        </div>
      </div>
    ` : '';

    form.innerHTML = `
      <label>
        <span>What needs doing?</span>
        <input type="text" class="input" name="title" required maxlength="120" value="${escapeAttr(initial.title)}" autocomplete="off" placeholder="e.g. Gym, Wash hair, Sniff walk">
      </label>
      <label>
        <span>Estimate</span>
        <input type="text" class="input" name="estimate" required value="${escapeAttr(fmtDuration(initial.estimateMinutes) || '30m')}" placeholder="30m, 1h, 1h15">
      </label>
      ${isEdit ? `
      <label>
        <span>Scheduled time today (optional)</span>
        <input type="text" class="input" name="scheduledStart" autocomplete="off" placeholder="e.g. 2:30 PM" value="${escapeAttr(fmtTimeInput(initial.scheduledStart))}">
      </label>
      <label class="row" style="flex-direction: row; gap: var(--space-2); align-items: center;">
        <input type="checkbox" name="completed" ${initial.completedAt ? 'checked' : ''}>
        <span style="text-transform: none; letter-spacing: 0; font-size: var(--fs-sm); color: var(--text);">Completed</span>
      </label>
      ` : ''}
      ${libraryHTML}
      <div class="pike-modal-actions">
        ${isEdit ? '<button type="button" class="btn btn-danger" data-action="delete">Delete</button>' : ''}
        ${isEdit && isScheduled ? '<button type="button" class="btn btn-ghost" data-action="move-to-tray">Move to tray</button>' : ''}
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add task'}</button>
      </div>
    `;

    // Wire library quick-add buttons
    form.querySelectorAll('.task-library-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.libraryId;
        if (id && global.Pike.recurrence.quickAddFromLibrary(id)) {
          global.Pike.modal.close();
        }
      });
    });

    // Wire "Move to tray" — clears scheduledStart, keeps scheduledDate so it stays in today's tray
    form.querySelector('[data-action="move-to-tray"]')?.addEventListener('click', () => {
      global.Pike.state.commit((d) => {
        const t = (d.tasks || []).find((x) => x.id === initial.id);
        if (t) t.scheduledStart = null;
      });
      global.Pike.modal.close();
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const title = String(fd.get('title') || '').trim();
      const estimateRaw = String(fd.get('estimate') || '');
      const estimate = parseDuration(estimateRaw);
      if (!title) return;
      if (estimate == null || estimate <= 0) {
        alertInlineError(form, 'Estimate should look like "30m", "1h", or "1h15".');
        return;
      }
      const scheduledStartRaw = isEdit ? String(fd.get('scheduledStart') || '').trim() : null;
      if (isEdit && scheduledStartRaw && !parseFlexTime(scheduledStartRaw)) {
        alertInlineError(form, 'Enter a valid time, e.g. 2:30 PM or 14:30.');
        return;
      }
      const scheduledStart = isEdit
        ? (scheduledStartRaw ? parseFlexTime(scheduledStartRaw) : null)
        : (initial.scheduledStart || null);
      const completed = isEdit ? !!fd.get('completed') : !!initial.completedAt;

      global.Pike.state.commit((d) => {
        d.tasks = d.tasks || [];
        const next = {
          id: initial.id,
          title,
          estimateMinutes: estimate,
          scheduledDate: initial.scheduledDate || tk,
          scheduledStart,
          completedAt: completed ? (initial.completedAt || new Date().toISOString()) : null,
          recurrenceId: initial.recurrenceId || null,
          category: initial.category || 'self',
          isRhythmRef: initial.isRhythmRef || false,
          rhythmId: initial.rhythmId || null,
          subtaskId: initial.subtaskId || null,
          isLibrary: initial.isLibrary || false,
          librarySourceId: initial.librarySourceId || null,
        };
        if (isEdit) {
          const idx = d.tasks.findIndex((x) => x.id === initial.id);
          if (idx >= 0) d.tasks[idx] = next; else d.tasks.push(next);
        } else {
          d.tasks.push(next);
        }
      });

      // If completing a rhythm-linked timeline task, also mark the rhythm/subtask done
      if (isEdit && completed && !initial.completedAt && initial.isRhythmRef && global.Pike.rhythms) {
        const dateObj = new Date();
        if (initial.subtaskId && global.Pike.rhythms.markSubtaskDone) {
          global.Pike.rhythms.markSubtaskDone(initial.rhythmId, initial.subtaskId, dateObj);
        } else if (global.Pike.rhythms.markRhythmDone) {
          global.Pike.rhythms.markRhythmDone(initial.rhythmId, dateObj);
        }
      }

      global.Pike.modal.close();
    });

    form.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      if (!confirm('Delete this task?')) return;
      global.Pike.state.commit((d) => {
        d.tasks = (d.tasks || []).filter((x) => x.id !== initial.id);
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: isEdit ? 'Edit task' : 'New task', body: form });
  }

  // ===== + Task modal (library-picker) =====
  function openAddTaskModal() {
    const data = getData();
    const tk = todayKey();

    // Other library tasks (not daily defaults)
    const otherTasks = (data.tasks || []).filter((t) => t.isLibrary && !t.isDefaultDaily);

    // Weekend rhythms (for "add as subtask" option)
    const weekendRhythms = (data.rhythms || []).filter(
      (r) => r.schedule?.type === 'weekends' && r.active
    );

    const container = document.createElement('div');
    container.className = 'task-picker';

    const libraryHTML = !otherTasks.length
      ? `<p class="task-picker-empty">Your library is empty. Use <strong>Create new</strong> to add tasks.</p>`
      : `<div class="task-picker-list" id="task-picker-list"></div>`;

    const rhythmRadioHTML = weekendRhythms.length ? `
      <label class="task-picker-bucket-option">
        <input type="radio" name="bucket" value="rhythm">
        <span>
          <strong>Weekend Rhythm subtask</strong>
          <span class="task-picker-bucket-desc">Adds to your weekend routine checklist</span>
        </span>
      </label>` : '';

    const rhythmSelectHTML = weekendRhythms.length ? `
      <div class="task-picker-rhythm-select" hidden>
        <label>
          <span>Add to which rhythm</span>
          <select class="input" name="rhythmId">
            ${weekendRhythms.map((r) => `<option value="${escapeAttr(r.id)}">${escapeAttr(r.title)}</option>`).join('')}
          </select>
        </label>
      </div>` : '';

    container.innerHTML = `
      <div class="task-picker-tabs">
        <button type="button" class="task-picker-tab is-active" data-tab="library">From library</button>
        <button type="button" class="task-picker-tab" data-tab="new">Create new</button>
      </div>

      <div class="task-picker-panel" data-panel="library">
        ${libraryHTML}
      </div>

      <div class="task-picker-panel" data-panel="new" hidden>
        <form id="task-picker-form">
          <label>
            <span>Task name</span>
            <input type="text" class="input" name="title" required maxlength="120" autocomplete="off"
              placeholder="e.g. Wash car, Order groceries">
          </label>
          <label>
            <span>Duration</span>
            <input type="text" class="input" name="estimate" placeholder="30m, 1h, 1h 30m">
          </label>
          <fieldset class="task-picker-buckets">
            <legend>Save to</legend>
            <label class="task-picker-bucket-option">
              <input type="radio" name="bucket" value="other" checked>
              <span>
                <strong>Other</strong>
                <span class="task-picker-bucket-desc">Library task — add to today manually when needed</span>
              </span>
            </label>
            <label class="task-picker-bucket-option">
              <input type="radio" name="bucket" value="daily">
              <span>
                <strong>Daily Default</strong>
                <span class="task-picker-bucket-desc">Auto-shows in your Flexible tray every day</span>
              </span>
            </label>
            ${rhythmRadioHTML}
          </fieldset>
          ${rhythmSelectHTML}
          <label class="task-picker-add-today" id="task-picker-add-today-wrap">
            <input type="checkbox" name="addToday">
            <span>Also add to today's tray</span>
          </label>
          <div class="pike-modal-actions">
            <button type="button" class="btn" data-modal-close="1">Cancel</button>
            <button type="submit" class="btn btn-primary">Save to library</button>
          </div>
        </form>
      </div>
    `;

    // ── Populate library list ──
    if (otherTasks.length) {
      const listEl = container.querySelector('#task-picker-list');
      otherTasks.forEach((t) => {
        const item = document.createElement('div');
        item.className = 'task-picker-item';

        const info = document.createElement('div');
        info.className = 'task-picker-item-info';
        const titleSpan = document.createElement('span');
        titleSpan.className = 'task-picker-item-title';
        titleSpan.textContent = t.title;
        info.appendChild(titleSpan);
        if (t.estimateMinutes) {
          const durSpan = document.createElement('span');
          durSpan.className = 'task-picker-item-dur';
          durSpan.textContent = fmtDuration(t.estimateMinutes);
          info.appendChild(durSpan);
        }

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn btn-ghost btn-sm';

        const alreadyAdded = (data.tasks || []).some(
          (x) => x.librarySourceId === t.id && x.scheduledDate === tk && !x.completedAt
        );
        if (alreadyAdded) {
          addBtn.textContent = '✓ In tray';
          addBtn.disabled = true;
        } else {
          addBtn.textContent = 'Add to today';
          addBtn.addEventListener('click', () => {
            global.Pike.state.commit((d) => {
              d.tasks = d.tasks || [];
              d.tasks.push({
                id: uid('tsk'),
                title: t.title,
                estimateMinutes: t.estimateMinutes || 30,
                scheduledDate: tk,
                scheduledStart: null,
                completedAt: null,
                isLibrary: false,
                librarySourceId: t.id,
                category: t.category || 'self',
              });
            });
            addBtn.textContent = '✓ Added';
            addBtn.disabled = true;
          });
        }

        item.appendChild(info);
        item.appendChild(addBtn);
        listEl.appendChild(item);
      });
    }

    // ── Tab switching ──
    container.querySelectorAll('.task-picker-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        container.querySelectorAll('.task-picker-tab').forEach((t) => t.classList.remove('is-active'));
        tab.classList.add('is-active');
        const target = tab.dataset.tab;
        container.querySelectorAll('.task-picker-panel').forEach((p) => {
          p.hidden = p.dataset.panel !== target;
        });
      });
    });

    // ── Create-new form logic ──
    const form = container.querySelector('#task-picker-form');
    if (form) {
      const rhythmSelectWrap = form.querySelector('.task-picker-rhythm-select');
      const addTodayWrap = form.querySelector('#task-picker-add-today-wrap');

      form.querySelectorAll('[name="bucket"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          const v = form.querySelector('[name="bucket"]:checked')?.value;
          if (rhythmSelectWrap) rhythmSelectWrap.hidden = v !== 'rhythm';
          // Daily defaults auto-populate; rhythm subtasks go to the rhythm
          if (addTodayWrap) addTodayWrap.hidden = v !== 'other';
        });
      });

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const title = String(fd.get('title') || '').trim();
        if (!title) return;
        const estimate = parseDuration(String(fd.get('estimate') || '')) || null;
        const bucket = fd.get('bucket') || 'other';
        const addToday = !!fd.get('addToday') && bucket === 'other';
        const rhythmId = fd.get('rhythmId');

        if (bucket === 'rhythm') {
          global.Pike.state.commit((d) => {
            const rhythm = (d.rhythms || []).find((r) => r.id === rhythmId);
            if (!rhythm) return;
            if (!rhythm.subtasks) rhythm.subtasks = [];
            rhythm.subtasks.push({ id: uid('sub'), title, estimateMinutes: estimate });
          });
        } else {
          const libId = uid('lib');
          global.Pike.state.commit((d) => {
            d.tasks = d.tasks || [];
            d.tasks.push({
              id: libId,
              title,
              estimateMinutes: estimate,
              scheduledDate: null,
              scheduledStart: null,
              completedAt: null,
              isLibrary: true,
              isDefaultDaily: bucket === 'daily',
              category: 'self',
            });
            if (addToday) {
              d.tasks.push({
                id: uid('tsk'),
                title,
                estimateMinutes: estimate || 30,
                scheduledDate: tk,
                scheduledStart: null,
                completedAt: null,
                isLibrary: false,
                librarySourceId: libId,
                category: 'self',
              });
            }
          });
        }

        global.Pike.modal.close();
      });
    }

    global.Pike.modal.open({ title: 'Add task', body: container });
  }

  // ===== Helpers =====
  function escapeAttr(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function alertInlineError(formEl, message) {
    let err = formEl.querySelector('.form-error');
    if (!err) {
      err = document.createElement('div');
      err.className = 'form-error';
      err.style.cssText = 'color:var(--accent-strong); font-size:var(--fs-sm); margin-top:var(--space-2);';
      const actions = formEl.querySelector('.pike-modal-actions');
      formEl.insertBefore(err, actions);
    }
    err.textContent = message;
  }

  function init() {
    document.getElementById('today-add-event')?.addEventListener('click', () => openEventModal(null));
    document.getElementById('today-add-task')?.addEventListener('click', () => openAddTaskModal());
  }

  global.Pike = global.Pike || {};
  global.Pike.today = { init, render, openEventModal };
})(window);
