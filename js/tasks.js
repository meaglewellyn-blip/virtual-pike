/* Virtual Pike — Tasks library
 *
 * Three groups, all visible in the Tasks section:
 *   Weekend Rhythm  — subtasks from everyWeekend rhythms (managed in Rhythms; read-only here)
 *   Daily           — daily rhythm items (managed in Rhythms; read-only here)
 *   Other           — isLibrary tasks in data.tasks (full CRUD; "Add to today" sends to tray)
 *
 * Public:
 *   Pike.tasks.init()
 *   Pike.tasks.render()
 */

(function (global) {
  'use strict';

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function pad2(n) { return String(n).padStart(2, '0'); }

  function uid(prefix = 'id') {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function todayKey(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function fmtDuration(mins) {
    if (!mins || mins <= 0) return '';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
  }

  function parseDuration(input) {
    if (!input) return null;
    const s = String(input).trim().toLowerCase();
    if (!s) return null;
    const colon = s.match(/^(\d{1,2}):(\d{1,2})$/);
    if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s));
    let total = 0, matched = false;
    const hMatch = s.match(/(\d+(?:\.\d+)?)\s*h/);
    if (hMatch) { total += Math.round(Number(hMatch[1]) * 60); matched = true; }
    const mMatch = s.match(/(\d+)\s*m\b/);
    if (mMatch) { total += Number(mMatch[1]); matched = true; }
    if (matched) {
      const trailing = s.match(/h\s*(\d+)\s*$/);
      if (trailing && !mMatch) total += Number(trailing[1]);
      return total;
    }
    return null;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function getData() { return global.Pike.state.data; }

  // ─── Time helpers (for "Add to planner" scheduling flow) ─────────────────────

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

  // Mirrors today.js parseFlexTime — accepts 9a, 915p, 1030pm, 2:30 PM, 1430, etc.
  function parseFlexTime(input) {
    if (!input) return null;
    const s = String(input).trim().toLowerCase().replace(/\s+/g, '').replace(/([ap])$/, '$1m');
    if (!s) return null;
    const colonMatch = s.match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
    if (colonMatch) {
      let h = parseInt(colonMatch[1], 10), m = parseInt(colonMatch[2], 10);
      const ap = colonMatch[3];
      if (ap === 'pm' && h !== 12) h += 12; else if (ap === 'am' && h === 12) h = 0;
      if (h >= 0 && h < 24 && m >= 0 && m < 60) return `${pad2(h)}:${pad2(m)}`;
      return null;
    }
    const bareMatch = s.match(/^(\d{3,4})(am|pm)?$/);
    if (bareMatch) {
      const digits = bareMatch[1], ap = bareMatch[2];
      let h = digits.length === 4 ? parseInt(digits.slice(0,2),10) : parseInt(digits[0],10);
      let m = digits.length === 4 ? parseInt(digits.slice(2),10) : parseInt(digits.slice(1),10);
      if (ap === 'pm' && h !== 12) h += 12; else if (ap === 'am' && h === 12) h = 0;
      if (h >= 0 && h < 24 && m >= 0 && m < 60) return `${pad2(h)}:${pad2(m)}`;
      return null;
    }
    const hourMatch = s.match(/^(\d{1,2})(am|pm)?$/);
    if (hourMatch) {
      let h = parseInt(hourMatch[1], 10);
      const ap = hourMatch[2];
      if (ap === 'pm' && h !== 12) h += 12; else if (ap === 'am' && h === 12) h = 0;
      if (h >= 0 && h < 24) return `${pad2(h)}:00`;
      return null;
    }
    return null;
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  function render() {
    const el = document.getElementById('tasks-content');
    if (!el) return;
    el.innerHTML = '';
    el.appendChild(buildWeekendSection());
    el.appendChild(buildDailySection());
    el.appendChild(buildOtherSection());
  }

  // ─── Weekend Rhythm section ───────────────────────────────────────────────────

  function buildWeekendSection() {
    const wrap = document.createElement('div');
    wrap.className = 'tasks-group';

    const header = document.createElement('div');
    header.className = 'tasks-group-header';
    header.innerHTML = `
      <h2 class="tasks-group-title">Weekend Rhythm</h2>
      <span class="tasks-group-hint">Edit subtasks in Rhythms</span>
    `;
    wrap.appendChild(header);

    const rhythms = (getData().rhythms || []).filter(
      (r) => r.active && r.schedule?.type === 'weekends' && r.subtasks?.length
    );

    if (!rhythms.length) {
      const empty = document.createElement('p');
      empty.className = 'tasks-empty';
      empty.textContent = 'No weekend routine set up yet. Add subtasks to a weekend rhythm in Rhythms.';
      wrap.appendChild(empty);
      return wrap;
    }

    rhythms.forEach((r) => {
      const routineLabel = document.createElement('div');
      routineLabel.className = 'tasks-routine-label';
      routineLabel.textContent = r.title;
      wrap.appendChild(routineLabel);

      const list = document.createElement('div');
      list.className = 'tasks-list';

      r.subtasks.forEach((sub) => {
        const item = document.createElement('div');
        item.className = 'tasks-item tasks-item-rhythm';

        const info = document.createElement('div');
        info.className = 'tasks-item-info';
        info.innerHTML = `
          <div class="tasks-item-title">${esc(sub.title)}</div>
          ${sub.estimateMinutes ? `<div class="tasks-item-duration">${esc(fmtDuration(sub.estimateMinutes))}</div>` : ''}
        `;

        const actions = document.createElement('div');
        actions.className = 'tasks-item-actions';

        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'btn btn-ghost btn-xs tasks-add-today-btn';
        // Pre-flight duplicate check so the label reflects current state.
        const alreadyToday = isWeekendSubtaskAlreadyInToday(r.id, sub.id);
        if (alreadyToday) {
          addBtn.textContent = 'Already in Today';
          addBtn.disabled = true;
        } else {
          addBtn.textContent = 'Add to today';
          addBtn.addEventListener('click', () => addWeekendSubtaskToToday(r, sub, addBtn));
        }

        actions.appendChild(addBtn);
        item.appendChild(info);
        item.appendChild(actions);
        list.appendChild(item);
      });

      wrap.appendChild(list);
    });

    return wrap;
  }

  // ─── Weekend Rhythm subtask → one-off Today task ─────────────────────────────
  // Creates a non-library Today task that mirrors the subtask's title/estimate
  // but is independent of weekend rhythm allocation/completion. Completing it
  // marks only the task instance, never the rhythm. Available any day.

  function isWeekendSubtaskAlreadyInToday(rhythmId, subtaskId) {
    const tk = todayKey();
    return (getData().tasks || []).some(
      (t) =>
        t.scheduledDate === tk &&
        !t.isLibrary &&
        t.sourceType === 'rhythm-subtask-oneoff' &&
        t.rhythmId === rhythmId &&
        t.subtaskId === subtaskId
    );
  }

  function addWeekendSubtaskToToday(rhythm, subtask, btnEl) {
    // Re-check at click time — state may have changed since render
    if (isWeekendSubtaskAlreadyInToday(rhythm.id, subtask.id)) {
      flashBtn(btnEl, 'Already in Today', 2500);
      return;
    }

    const tk = todayKey();
    global.Pike.state.commit((d) => {
      d.tasks = d.tasks || [];
      d.tasks.push({
        id: uid('tsk'),
        title: subtask.title,
        estimateMinutes: subtask.estimateMinutes || null,
        scheduledDate: tk,
        scheduledStart: null,
        completedAt: null,
        isLibrary: false,
        // Marker that this is a one-off mirror of a Weekend Rhythm subtask.
        // NOT the same as isRhythmRef (which would auto-mark the subtask done
        // on completion). This one-off is fully independent of rhythm tracking.
        sourceType: 'rhythm-subtask-oneoff',
        rhythmId: rhythm.id,
        subtaskId: subtask.id,
        category: 'self',
        createdAt: new Date().toISOString(),
      });
    });
    flashBtn(btnEl, '✓ Added');
  }

  // ─── Daily Defaults section ───────────────────────────────────────────────────
  // These tasks auto-populate in the Flexible tray every day.
  // They are NOT rhythms — no tracking, no completion ring, just always available.

  function buildDailySection() {
    const wrap = document.createElement('div');
    wrap.className = 'tasks-group';

    const header = document.createElement('div');
    header.className = 'tasks-group-header';

    const titleEl = document.createElement('h2');
    titleEl.className = 'tasks-group-title';
    titleEl.textContent = 'Daily Defaults';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-ghost btn-sm';
    addBtn.textContent = '+ Add';
    addBtn.addEventListener('click', () => openDailyDefaultModal(null));

    header.appendChild(titleEl);
    header.appendChild(addBtn);
    wrap.appendChild(header);

    const desc = document.createElement('p');
    desc.className = 'tasks-group-desc';
    desc.textContent = 'These show up in your Flexible tray automatically each day.';
    wrap.appendChild(desc);

    const defaults = (getData().tasks || []).filter((t) => t.isDefaultDaily && t.isLibrary);

    if (!defaults.length) {
      const empty = document.createElement('p');
      empty.className = 'tasks-empty';
      empty.textContent = 'No daily defaults yet. Tap + Add to create one.';
      wrap.appendChild(empty);
      return wrap;
    }

    const list = document.createElement('div');
    list.className = 'tasks-list';

    defaults.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'tasks-item tasks-item-daily';

      const info = document.createElement('div');
      info.className = 'tasks-item-info';
      info.innerHTML = `
        <div class="tasks-item-title">${esc(t.title)}</div>
        ${t.estimateMinutes ? `<div class="tasks-item-duration">${esc(fmtDuration(t.estimateMinutes))}</div>` : ''}
      `;

      const actions = document.createElement('div');
      actions.className = 'tasks-item-actions';

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-ghost btn-xs';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openDailyDefaultModal(t));

      actions.appendChild(editBtn);
      item.appendChild(info);
      item.appendChild(actions);
      list.appendChild(item);
    });

    wrap.appendChild(list);
    return wrap;
  }

  function openDailyDefaultModal(existing) {
    const isEdit = !!existing;
    const form = document.createElement('form');

    form.innerHTML = `
      <label>
        <span>Task name</span>
        <input type="text" class="input" name="title" required maxlength="120"
          value="${esc(existing?.title || '')}" autocomplete="off"
          placeholder="e.g. Gym, Meditate, Walk Ro">
      </label>
      <label>
        <span>Duration</span>
        <input type="text" class="input" name="estimate"
          value="${esc(existing?.estimateMinutes ? fmtDuration(existing.estimateMinutes) : '')}"
          placeholder="30m, 1h, 1h 15m">
      </label>
      <div class="pike-modal-actions">
        ${isEdit ? '<button type="button" class="btn btn-danger" data-action="delete">Remove</button>' : ''}
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add daily default'}</button>
      </div>
    `;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const title = String(fd.get('title') || '').trim();
      if (!title) return;
      const estimate = parseDuration(String(fd.get('estimate') || '')) || null;

      global.Pike.state.commit((d) => {
        d.tasks = d.tasks || [];
        if (isEdit) {
          const idx = d.tasks.findIndex((x) => x.id === existing.id);
          if (idx >= 0) d.tasks[idx] = { ...d.tasks[idx], title, estimateMinutes: estimate };
        } else {
          d.tasks.push({
            id: uid('lib'),
            title,
            estimateMinutes: estimate,
            scheduledDate: null,
            scheduledStart: null,
            completedAt: null,
            isLibrary: true,
            isDefaultDaily: true,
            category: 'self',
          });
        }
      });
      global.Pike.modal.close();
    });

    form.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      if (!confirm(`Remove "${existing.title}" from daily defaults?`)) return;
      global.Pike.state.commit((d) => {
        d.tasks = (d.tasks || []).filter((x) => x.id !== existing.id);
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({
      title: isEdit ? 'Edit daily default' : 'New daily default',
      body: form,
    });
  }

  // ─── Other (library) section ──────────────────────────────────────────────────

  function buildOtherSection() {
    const wrap = document.createElement('div');
    wrap.className = 'tasks-group';

    const header = document.createElement('div');
    header.className = 'tasks-group-header';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-ghost btn-sm';
    addBtn.textContent = '+ Add task';
    addBtn.addEventListener('click', () => openOtherTaskModal(null));
    const titleEl = document.createElement('h2');
    titleEl.className = 'tasks-group-title';
    titleEl.textContent = 'Other';
    header.appendChild(titleEl);
    header.appendChild(addBtn);
    wrap.appendChild(header);

    const libraryTasks = (getData().tasks || []).filter((t) => t.isLibrary === true && !t.isDefaultDaily);

    if (!libraryTasks.length) {
      const empty = document.createElement('p');
      empty.className = 'tasks-empty';
      empty.textContent = 'No library tasks yet. Tap + Add task to build your collection.';
      wrap.appendChild(empty);
      return wrap;
    }

    const list = document.createElement('div');
    list.className = 'tasks-list';

    libraryTasks.forEach((t) => {
      const item = document.createElement('div');
      item.className = 'tasks-item tasks-item-other';

      const info = document.createElement('div');
      info.className = 'tasks-item-info';
      info.innerHTML = `
        <div class="tasks-item-title">${esc(t.title)}</div>
        ${t.estimateMinutes ? `<div class="tasks-item-duration">${esc(fmtDuration(t.estimateMinutes))}</div>` : ''}
      `;

      const actions = document.createElement('div');
      actions.className = 'tasks-item-actions';

      const addBtn2 = document.createElement('button');
      addBtn2.type = 'button';
      addBtn2.className = 'btn btn-ghost btn-xs tasks-add-today-btn';
      addBtn2.textContent = 'Add to today';
      addBtn2.addEventListener('click', () => promptAddToToday(t, addBtn2));

      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn btn-ghost btn-xs';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => openOtherTaskModal(t));

      actions.appendChild(addBtn2);
      actions.appendChild(editBtn);
      item.appendChild(info);
      item.appendChild(actions);
      list.appendChild(item);
    });

    wrap.appendChild(list);
    return wrap;
  }

  // ─── Add library task to today — two-step choice flow ────────────────────────

  // Returns true if this library task already has an unfinished instance today
  function isAlreadyInToday(libraryTask) {
    const tk = todayKey();
    return (getData().tasks || []).some(
      (t) => t.librarySourceId === libraryTask.id && t.scheduledDate === tk && !t.completedAt
    );
  }

  function flashBtn(btnEl, text, ms = 2000) {
    if (!btnEl) return;
    const orig = btnEl.textContent;
    btnEl.textContent = text;
    btnEl.disabled = true;
    setTimeout(() => { btnEl.textContent = orig; btnEl.disabled = false; }, ms);
  }

  // Commit a tray instance (no scheduledStart)
  function addToTray(libraryTask) {
    const tk = todayKey();
    global.Pike.state.commit((d) => {
      d.tasks = d.tasks || [];
      d.tasks.push({
        id: uid('tsk'),
        title: libraryTask.title,
        estimateMinutes: libraryTask.estimateMinutes || 30,
        scheduledDate: tk,
        scheduledStart: null,
        completedAt: null,
        isLibrary: false,
        librarySourceId: libraryTask.id,
        category: libraryTask.category || 'self',
      });
    });
  }

  // Swap the open modal to the "pick a time" form for Add to planner
  function showPlannerTimeForm(libraryTask, btnEl) {
    const label = libraryTask.title +
      (libraryTask.estimateMinutes ? ` · ${fmtDuration(libraryTask.estimateMinutes)}` : '');

    const form = document.createElement('form');
    form.innerHTML = `
      <p class="task-add-label">${esc(label)}</p>
      <label>
        <span>Start time</span>
        <input type="text" class="input" name="time" autocomplete="off"
               placeholder="e.g. 9a, 2:30 PM, 1430" required>
      </label>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">Add to timeline</button>
      </div>
    `;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const rawTime = String(new FormData(form).get('time') || '').trim();
      const timeStr = parseFlexTime(rawTime);
      if (!timeStr) {
        let errEl = form.querySelector('.task-add-error');
        if (!errEl) {
          errEl = document.createElement('p');
          errEl.className = 'task-add-error';
          form.querySelector('.pike-modal-actions').before(errEl);
        }
        errEl.textContent = 'Enter a valid time — try 9a, 10:30, or 2 PM.';
        return;
      }
      const tk = todayKey();
      global.Pike.state.commit((d) => {
        d.tasks = d.tasks || [];
        d.tasks.push({
          id: uid('tsk'),
          title: libraryTask.title,
          estimateMinutes: libraryTask.estimateMinutes || 30,
          scheduledDate: tk,
          scheduledStart: timeStr,
          completedAt: null,
          isLibrary: false,
          librarySourceId: libraryTask.id,
          category: libraryTask.category || 'self',
        });
      });
      global.Pike.modal.close();
      flashBtn(btnEl, '✓ Added');
    });

    // Replace modal body and title in place
    const modalBody  = document.getElementById('pike-modal-body');
    const modalTitle = document.getElementById('pike-modal-title');
    if (modalBody)  modalBody.replaceChildren(form);
    if (modalTitle) modalTitle.textContent = 'Schedule on timeline';
    form.querySelector('input[name="time"]')?.focus();
  }

  function promptAddToToday(libraryTask, btnEl) {
    // 1. Duplicate guard — show "Already in Today" and bail
    if (isAlreadyInToday(libraryTask)) {
      flashBtn(btnEl, 'Already in Today', 2500);
      return;
    }

    // 2. Choice modal
    const label = libraryTask.title +
      (libraryTask.estimateMinutes ? ` · ${fmtDuration(libraryTask.estimateMinutes)}` : '');

    const container = document.createElement('div');
    container.className = 'task-add-choice';
    container.innerHTML = `
      <p class="task-add-label">${esc(label)}</p>
      <div class="task-add-btns">
        <button type="button" class="btn btn-primary task-add-choice-btn" data-choice="planner">
          Add to planner
          <span class="task-add-choice-hint">Schedule a time on today's timeline</span>
        </button>
        <button type="button" class="btn task-add-choice-btn" data-choice="dock">
          Add to Today dock
          <span class="task-add-choice-hint">Drop into the Flexible tray, unscheduled</span>
        </button>
      </div>
    `;

    container.querySelector('[data-choice="dock"]').addEventListener('click', () => {
      addToTray(libraryTask);
      global.Pike.modal.close();
      flashBtn(btnEl, '✓ Added');
    });

    container.querySelector('[data-choice="planner"]').addEventListener('click', () => {
      showPlannerTimeForm(libraryTask, btnEl);
    });

    global.Pike.modal.open({ title: 'Add to today', body: container });
  }

  // ─── Other task modal (add / edit) ────────────────────────────────────────────

  function openOtherTaskModal(existing) {
    const isEdit = !!existing;
    const form = document.createElement('form');

    form.innerHTML = `
      <label>
        <span>Task name</span>
        <input type="text" class="input" name="title" required maxlength="120"
          value="${esc(existing?.title || '')}" autocomplete="off"
          placeholder="e.g. Wash car, Order groceries">
      </label>
      <label>
        <span>Duration</span>
        <input type="text" class="input" name="estimate"
          value="${esc(existing?.estimateMinutes ? fmtDuration(existing.estimateMinutes) : '')}"
          placeholder="30m, 1h, 1h 30m">
      </label>
      <div class="pike-modal-actions">
        ${isEdit ? '<button type="button" class="btn btn-danger" data-action="delete">Delete</button>' : ''}
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add to library'}</button>
      </div>
    `;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const title = String(fd.get('title') || '').trim();
      if (!title) return;
      const estimate = parseDuration(String(fd.get('estimate') || '')) || null;

      global.Pike.state.commit((d) => {
        d.tasks = d.tasks || [];
        if (isEdit) {
          const idx = d.tasks.findIndex((x) => x.id === existing.id);
          if (idx >= 0) {
            d.tasks[idx] = { ...d.tasks[idx], title, estimateMinutes: estimate };
          }
        } else {
          d.tasks.push({
            id: uid('tsk'),
            title,
            estimateMinutes: estimate,
            scheduledDate: null,
            scheduledStart: null,
            completedAt: null,
            isLibrary: true,
            category: 'self',
          });
        }
      });
      global.Pike.modal.close();
    });

    form.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      if (!confirm(`Delete "${existing.title}" from your library?`)) return;
      global.Pike.state.commit((d) => {
        d.tasks = (d.tasks || []).filter((x) => x.id !== existing.id);
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: isEdit ? 'Edit library task' : 'New library task', body: form });
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────────

  function init() {}

  global.Pike = global.Pike || {};
  global.Pike.tasks = { init, render };
})(window);
