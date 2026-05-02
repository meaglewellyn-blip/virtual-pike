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

    // Workday-start marker
    const data = getData();
    const tk = todayKey();
    const override = (data.dailyOverrides || {})[tk] || null;
    const workdayStart = (override && override.workdayStart) || data.settings.defaultWorkdayStart;
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
    el.className = 'tl-block ' + (b.kind === 'event' ? 'tl-block-event' : 'tl-block-task');
    if (b.completed) el.classList.add('is-completed');

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

    el.addEventListener('click', () => {
      if (b.kind === 'event') openEventModal(b.raw);
      else openTaskModal(b.raw);
    });

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
      if (!payload.taskId) return;
      const min = snappedMinutesFromEvent(e);
      scheduleTaskAt(payload.taskId, min);
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

  // ===== Modals: event / task =====
  function openEventModal(existing = null) {
    const isEdit = !!existing;
    const tk = todayKey();
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
          <input type="time" class="input" name="start" step="60" required value="${escapeAttr(initial.start)}">
        </label>
        <label style="flex:1;">
          <span>End</span>
          <input type="time" class="input" name="end" step="60" required value="${escapeAttr(initial.end)}">
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
      const start = String(fd.get('start') || '');
      const end   = String(fd.get('end')   || '');
      if (!title || !date || !start || !end) return;
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
        <input type="time" class="input" name="scheduledStart" step="60" value="${escapeAttr(initial.scheduledStart || '')}">
      </label>
      <label class="row" style="flex-direction: row; gap: var(--space-2); align-items: center;">
        <input type="checkbox" name="completed" ${initial.completedAt ? 'checked' : ''}>
        <span style="text-transform: none; letter-spacing: 0; font-size: var(--fs-sm); color: var(--text);">Completed</span>
      </label>
      ` : ''}
      ${libraryHTML}
      <div class="pike-modal-actions">
        ${isEdit ? '<button type="button" class="btn btn-danger" data-action="delete">Delete</button>' : ''}
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
      const scheduledStart = isEdit ? (String(fd.get('scheduledStart') || '') || null) : (initial.scheduledStart || null);
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
        };
        if (isEdit) {
          const idx = d.tasks.findIndex((x) => x.id === initial.id);
          if (idx >= 0) d.tasks[idx] = next; else d.tasks.push(next);
        } else {
          d.tasks.push(next);
        }
      });
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
    document.getElementById('today-add-task')?.addEventListener('click', () => openTaskModal(null));
  }

  global.Pike = global.Pike || {};
  global.Pike.today = { init, render };
})(window);
