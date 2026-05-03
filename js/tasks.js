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
        item.innerHTML = `
          <div class="tasks-item-info">
            <div class="tasks-item-title">${esc(sub.title)}</div>
            ${sub.estimateMinutes ? `<div class="tasks-item-duration">${esc(fmtDuration(sub.estimateMinutes))}</div>` : ''}
          </div>
        `;
        list.appendChild(item);
      });

      wrap.appendChild(list);
    });

    return wrap;
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
      addBtn2.addEventListener('click', () => addToToday(t, addBtn2));

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

  // ─── Add library task to today's tray ────────────────────────────────────────

  function addToToday(libraryTask, btnEl) {
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
    // Brief visual confirmation on the button
    if (btnEl) {
      const orig = btnEl.textContent;
      btnEl.textContent = '✓ Added';
      btnEl.disabled = true;
      setTimeout(() => {
        btnEl.textContent = orig;
        btnEl.disabled = false;
      }, 1500);
    }
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
