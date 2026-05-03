/* Virtual Pike — Reminders
 *
 * A time-bound list for things with a deadline.
 * Unlike Brain Dump (open-ended capture), every new reminder requires a due date.
 * Legacy items migrated from Brain Dump may have dueDate: null and are shown
 * with a "Needs date" treatment but are excluded from Today's reminders card.
 *
 * Public:
 *   Pike.reminders.init()   — one-time migration + initial render
 *   Pike.reminders.render() — re-render the section
 */

(function (global) {
  'use strict';

  let activeFilter = 'active'; // 'active' | 'done' | 'all'

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  function uid() {
    return `rem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getData() { return global.Pike.state.data; }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayKey(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function fmtDueLabel(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const due = new Date(y, m - 1, d);
    due.setHours(0, 0, 0, 0);
    const now = new Date();
    now.setHours(0, 0, 0, 0);
    const diff = Math.round((due - now) / 86400000);
    if (diff < 0) return `Overdue by ${Math.abs(diff)} day${Math.abs(diff) !== 1 ? 's' : ''}`;
    if (diff === 0) return 'Due today';
    if (diff === 1) return 'Due tomorrow';
    if (diff <= 7) return `Due in ${diff} days`;
    return 'Due ' + due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function isOverdue(isoDate) {
    if (!isoDate) return false;
    return isoDate < todayKey();
  }

  // ─── Render ───────────────────────────────────────────────────────────────────

  function render() {
    const el = document.getElementById('reminders-content');
    if (!el) return;
    el.innerHTML = '';
    el.appendChild(buildCapture());
    el.appendChild(buildFilterBar());
    el.appendChild(buildList());
  }

  // ─── Capture form ─────────────────────────────────────────────────────────────

  function buildCapture() {
    const wrap = document.createElement('div');
    wrap.className = 'rem-capture';

    const form = document.createElement('form');
    form.className = 'rem-capture-form';
    form.autocomplete = 'off';

    // Text input
    const textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.className = 'rem-capture-text';
    textInput.placeholder = 'What do you need to remember?';
    textInput.maxLength = 500;
    textInput.required = true;

    // Date row (required)
    const dateRow = document.createElement('div');
    dateRow.className = 'rem-capture-date-row';

    const dateLabel = document.createElement('label');
    dateLabel.className = 'rem-capture-date-label';

    const dateLabelText = document.createElement('span');
    dateLabelText.textContent = 'Due by';

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.className = 'input rem-capture-date-input';
    dateInput.required = true;
    dateInput.setAttribute('aria-label', 'Due date (required)');

    dateLabel.appendChild(dateLabelText);
    dateLabel.appendChild(dateInput);
    dateRow.appendChild(dateLabel);

    // Optional notes (collapsed)
    let expanded = false;
    const expandToggle = document.createElement('button');
    expandToggle.type = 'button';
    expandToggle.className = 'rem-expand-toggle';
    expandToggle.textContent = '+ notes';

    const notesWrap = document.createElement('div');
    notesWrap.className = 'rem-capture-notes';
    notesWrap.hidden = true;

    const notesInput = document.createElement('textarea');
    notesInput.className = 'input';
    notesInput.rows = 2;
    notesInput.placeholder = 'Additional context…';
    notesInput.setAttribute('aria-label', 'Notes');
    notesWrap.appendChild(notesInput);

    expandToggle.addEventListener('click', () => {
      expanded = !expanded;
      notesWrap.hidden = !expanded;
      expandToggle.textContent = expanded ? '− notes' : '+ notes';
      if (expanded) notesInput.focus();
    });

    // Submit button
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary rem-capture-submit';
    submitBtn.textContent = 'Add reminder';

    form.appendChild(textInput);
    form.appendChild(dateRow);
    form.appendChild(expandToggle);
    form.appendChild(notesWrap);
    form.appendChild(submitBtn);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const text    = textInput.value.trim();
      const dueDate = dateInput.value;
      if (!text || !dueDate) return;
      const notes = notesInput.value.trim() || null;

      global.Pike.state.commit((d) => {
        if (!d.reminders) d.reminders = [];
        d.reminders.push({
          id: uid(),
          text,
          notes,
          dueDate,
          completedAt: null,
          archivedAt:  null,
          createdAt:   new Date().toISOString(),
        });
      });

      // Reset
      textInput.value = '';
      dateInput.value = '';
      notesInput.value = '';
      if (expanded) {
        expanded = false;
        notesWrap.hidden = true;
        expandToggle.textContent = '+ notes';
      }
      textInput.focus();
    });

    wrap.appendChild(form);
    return wrap;
  }

  // ─── Filter bar ───────────────────────────────────────────────────────────────

  function buildFilterBar() {
    const bar = document.createElement('div');
    bar.className = 'rem-filters';

    [
      { id: 'active', label: 'Active' },
      { id: 'done',   label: 'Done'   },
      { id: 'all',    label: 'All'    },
    ].forEach(({ id, label }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rem-filter-pill' + (activeFilter === id ? ' is-active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => { activeFilter = id; render(); });
      bar.appendChild(btn);
    });

    return bar;
  }

  // ─── Items list ───────────────────────────────────────────────────────────────

  function buildList() {
    const wrap = document.createElement('div');
    wrap.className = 'rem-list';

    const all = getData().reminders || [];

    let items;
    if (activeFilter === 'active') {
      items = all.filter((r) => !r.completedAt && !r.archivedAt);
    } else if (activeFilter === 'done') {
      items = all.filter((r) => !!r.completedAt);
    } else {
      // 'all' = active + done; archived items are not shown in any filter
      items = all.filter((r) => !r.archivedAt);
    }

    // Sort: active before done; within active: overdue first then by date asc;
    // null-date items go to end of their group
    items.sort((a, b) => {
      const aDone = !!a.completedAt;
      const bDone = !!b.completedAt;
      if (aDone !== bDone) return aDone ? 1 : -1;
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });

    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'rem-empty';
      empty.textContent = activeFilter === 'done'
        ? 'No completed reminders yet.'
        : 'No reminders yet. Add one above.';
      wrap.appendChild(empty);
      return wrap;
    }

    items.forEach((item) => wrap.appendChild(buildItem(item)));
    return wrap;
  }

  // ─── Item card ────────────────────────────────────────────────────────────────

  function buildItem(item) {
    const isDone    = !!item.completedAt;
    const overdue   = item.dueDate && isOverdue(item.dueDate) && !isDone;
    const needsDate = !item.dueDate;

    const el = document.createElement('div');
    el.className = [
      'rem-item',
      isDone     ? 'is-done'     : '',
      overdue    ? 'is-overdue'  : '',
      needsDate  ? 'needs-date'  : '',
    ].filter(Boolean).join(' ');

    // ── Body ──
    const body = document.createElement('div');
    body.className = 'rem-item-body';

    const textEl = document.createElement('span');
    textEl.className = 'rem-item-text';
    textEl.textContent = item.text;
    body.appendChild(textEl);

    if (item.notes) {
      const notesEl = document.createElement('p');
      notesEl.className = 'rem-item-notes';
      notesEl.textContent = item.notes;
      body.appendChild(notesEl);
    }

    // ── Meta row ──
    const meta = document.createElement('div');
    meta.className = 'rem-item-meta';

    if (needsDate) {
      const badge = document.createElement('span');
      badge.className = 'rem-needs-date-badge';
      badge.textContent = 'Needs date';
      meta.appendChild(badge);
    } else {
      const dueEl = document.createElement('span');
      dueEl.className = 'rem-item-due' + (overdue ? ' is-overdue' : '');
      dueEl.textContent = fmtDueLabel(item.dueDate);
      meta.appendChild(dueEl);
    }

    if (isDone && item.completedAt) {
      const doneLabel = document.createElement('span');
      doneLabel.className = 'rem-item-done-label';
      doneLabel.textContent = 'Done ' + new Date(item.completedAt).toLocaleDateString(
        undefined, { month: 'short', day: 'numeric' }
      );
      meta.appendChild(doneLabel);
    }

    body.appendChild(meta);

    // ── Actions ──
    const actions = document.createElement('div');
    actions.className = 'rem-item-actions';

    if (!isDone) {
      const doneBtn = document.createElement('button');
      doneBtn.type = 'button';
      doneBtn.className = 'rem-action-btn rem-action-done';
      doneBtn.textContent = '✓ Done';
      doneBtn.addEventListener('click', () => {
        global.Pike.state.commit((d) => {
          const r = (d.reminders || []).find((x) => x.id === item.id);
          if (r) r.completedAt = new Date().toISOString();
        });
      });
      actions.appendChild(doneBtn);
    } else {
      const undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'rem-action-btn';
      undoBtn.textContent = 'Undo';
      undoBtn.addEventListener('click', () => {
        global.Pike.state.commit((d) => {
          const r = (d.reminders || []).find((x) => x.id === item.id);
          if (r) r.completedAt = null;
        });
      });
      actions.appendChild(undoBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'rem-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openEditModal(item));
    actions.appendChild(editBtn);

    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'rem-action-btn rem-action-archive';
    archiveBtn.textContent = 'Archive';
    archiveBtn.addEventListener('click', () => {
      global.Pike.state.commit((d) => {
        const r = (d.reminders || []).find((x) => x.id === item.id);
        if (r) r.archivedAt = new Date().toISOString();
      });
    });
    actions.appendChild(archiveBtn);

    el.appendChild(body);
    el.appendChild(actions);
    return el;
  }

  // ─── Edit modal ───────────────────────────────────────────────────────────────

  function openEditModal(item) {
    const form = document.createElement('form');
    form.innerHTML = `
      <label>
        <span>Reminder</span>
        <textarea class="input" name="text" required maxlength="500" rows="2">${esc(item.text)}</textarea>
      </label>
      <label>
        <span>Due date</span>
        <input type="date" class="input" name="dueDate" value="${esc(item.dueDate || '')}">
      </label>
      <label>
        <span>Notes (optional)</span>
        <textarea class="input" name="notes" rows="2" placeholder="Additional context…">${esc(item.notes || '')}</textarea>
      </label>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    `;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd      = new FormData(form);
      const text    = String(fd.get('text')    || '').trim();
      const dueDate = String(fd.get('dueDate') || '').trim() || null;
      const notes   = String(fd.get('notes')   || '').trim() || null;
      if (!text) return;

      global.Pike.state.commit((d) => {
        const r = (d.reminders || []).find((x) => x.id === item.id);
        if (r) { r.text = text; r.dueDate = dueDate; r.notes = notes; }
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: 'Edit reminder', body: form });
  }

  // ─── Init + one-time migration ────────────────────────────────────────────────

  function init() {
    const data = global.Pike.state.data;

    if (!data.remindersV1Migrated) {
      let migratedCount = 0;
      let nullDateCount = 0;

      global.Pike.state.commit((d) => {
        if (!d.reminders) d.reminders = [];
        const now = new Date().toISOString();

        // Collect brainDump items to migrate (deduped by ID):
        //   · category === 'dont-forget'  (time-bound intent, even without a date)
        //   · dueDate set (any category)
        const seen = new Set();
        const toMigrate = (d.brainDump || []).filter((item) => {
          if (seen.has(item.id)) return false;
          const match = item.category === 'dont-forget' || !!item.dueDate;
          if (match) seen.add(item.id);
          return match;
        });

        toMigrate.forEach((item) => {
          d.reminders.push({
            id:          item.id,
            text:        item.text,
            notes:       item.notes  || null,
            dueDate:     item.dueDate || null,
            completedAt: item.promotedTo            ? now : null,
            archivedAt:  item.status === 'archived' ? now : null,
            createdAt:   item.createdAt || now,
          });
          if (!item.dueDate) nullDateCount++;
          migratedCount++;
        });

        // Remove migrated items from brainDump
        const migratedIds = new Set(toMigrate.map((i) => i.id));
        d.brainDump = (d.brainDump || []).filter((i) => !migratedIds.has(i.id));

        d.remindersV1Migrated = true;
      });

      console.info(
        `[Pike] Reminders migration complete — moved ${migratedCount} item(s) from Brain Dump.` +
        (nullDateCount > 0 ? ` ${nullDateCount} item(s) have no due date (shown with "Needs date").` : '')
      );
    }

    render();
  }

  global.Pike = global.Pike || {};
  global.Pike.reminders = { init, render };

})(window);
