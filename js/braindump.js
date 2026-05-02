/* Virtual Pike — Brain Dump
 *
 * A calm parking lot for ideas. No pressure to process.
 * Capture → categorize (optional) → promote when ready.
 *
 * Public:
 *   Pike.braindump.init()    — wire global 'b' shortcut (once on boot)
 *   Pike.braindump.render()  — re-render the section
 */

(function (global) {
  'use strict';

  // ─── Categories ───────────────────────────────────────────────────────────────

  const CATEGORIES = [
    { id: 'uncategorized',   label: 'Uncategorized' },
    { id: 'shows',           label: 'Shows' },
    { id: 'books',           label: 'Books' },
    { id: 'podcasts',        label: 'Podcasts' },
    { id: 'writing',         label: 'Writing' },
    { id: 'claude-projects', label: 'Claude Projects' },
    { id: 'places',          label: 'Places' },
    { id: 'other',           label: 'Other' },
  ];

  // ─── Module state ─────────────────────────────────────────────────────────────

  let activeFilter = 'all';

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function uid() {
    return `bd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function getData() { return global.Pike.state.data; }

  function catLabel(id) {
    return CATEGORIES.find((c) => c.id === id)?.label || 'Uncategorized';
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
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

  // ─── Render ───────────────────────────────────────────────────────────────────

  function render() {
    const el = document.getElementById('braindump-content');
    if (!el) return;
    el.innerHTML = '';
    el.appendChild(buildCapture());
    el.appendChild(buildFilterBar());
    el.appendChild(buildList());
  }

  // ─── Capture row ──────────────────────────────────────────────────────────────

  function buildCapture() {
    const wrap = document.createElement('div');
    wrap.className = 'bd-capture';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bd-capture-input';
    input.id = 'braindump-input';
    input.placeholder = 'What\'s on your mind? Press Enter to save.';
    input.maxLength = 500;
    input.autocomplete = 'off';

    // Category pills (optional — defaults to uncategorized)
    const catRow = document.createElement('div');
    catRow.className = 'bd-capture-cats';

    let selectedCat = null;

    CATEGORIES.forEach((cat) => {
      if (cat.id === 'uncategorized') return; // default; not shown in picker
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bd-cat-pill';
      btn.dataset.catId = cat.id;
      btn.textContent = cat.label;
      btn.addEventListener('click', () => {
        if (selectedCat === cat.id) {
          selectedCat = null;
          btn.classList.remove('is-selected');
        } else {
          selectedCat = cat.id;
          catRow.querySelectorAll('.bd-cat-pill').forEach((b) => b.classList.remove('is-selected'));
          btn.classList.add('is-selected');
        }
      });
      catRow.appendChild(btn);
    });

    function saveCapture() {
      const text = input.value.trim();
      if (!text) return;
      global.Pike.state.commit((d) => {
        if (!d.brainDump) d.brainDump = [];
        d.brainDump.unshift({
          id: uid(),
          text,
          category: selectedCat || 'uncategorized',
          createdAt: new Date().toISOString(),
          status: 'active',
          promotedTo: null,
        });
      });
      input.value = '';
      selectedCat = null;
      catRow.querySelectorAll('.bd-cat-pill').forEach((b) => b.classList.remove('is-selected'));
      // Keep focus in input for rapid capture
      input.focus();
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveCapture(); }
    });

    wrap.appendChild(input);
    wrap.appendChild(catRow);
    return wrap;
  }

  // ─── Filter bar ───────────────────────────────────────────────────────────────

  function buildFilterBar() {
    const bar = document.createElement('div');
    bar.className = 'bd-filters';

    const all = document.createElement('button');
    all.type = 'button';
    all.className = 'bd-filter-pill' + (activeFilter === 'all' ? ' is-active' : '');
    all.textContent = 'All';
    all.addEventListener('click', () => { activeFilter = 'all'; render(); });
    bar.appendChild(all);

    CATEGORIES.forEach((cat) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'bd-filter-pill' + (activeFilter === cat.id ? ' is-active' : '');
      btn.textContent = cat.label;
      btn.addEventListener('click', () => { activeFilter = cat.id; render(); });
      bar.appendChild(btn);
    });

    return bar;
  }

  // ─── Items list ───────────────────────────────────────────────────────────────

  function buildList() {
    const wrap = document.createElement('div');
    wrap.className = 'bd-list';

    const items = (getData().brainDump || []).filter((item) => {
      if (item.status === 'archived') return false;
      if (activeFilter === 'all') return true;
      return item.category === activeFilter;
    });

    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'bd-empty';
      empty.textContent = activeFilter === 'all'
        ? 'Nothing here yet. Type something above and press Enter to save it.'
        : 'Nothing in this category yet.';
      wrap.appendChild(empty);
      return wrap;
    }

    items.forEach((item) => wrap.appendChild(buildItem(item)));
    return wrap;
  }

  function buildItem(item) {
    const el = document.createElement('div');
    el.className = 'bd-item' + (item.promotedTo ? ' is-promoted' : '');

    const body = document.createElement('div');
    body.className = 'bd-item-body';

    const textEl = document.createElement('p');
    textEl.className = 'bd-item-text';
    textEl.textContent = item.text;
    body.appendChild(textEl);

    const metaRow = document.createElement('div');
    metaRow.className = 'bd-item-meta';

    const badge = document.createElement('span');
    badge.className = `bd-cat-badge bd-cat-${item.category || 'uncategorized'}`;
    badge.textContent = catLabel(item.category || 'uncategorized');
    metaRow.appendChild(badge);

    const dateEl = document.createElement('span');
    dateEl.className = 'bd-item-date';
    dateEl.textContent = fmtDate(item.createdAt);
    metaRow.appendChild(dateEl);

    if (item.promotedTo) {
      const promoBadge = document.createElement('span');
      promoBadge.className = 'bd-promoted-badge';
      promoBadge.textContent = '→ ' + (item.promotedTo.label || 'Tasks');
      metaRow.appendChild(promoBadge);
    }

    body.appendChild(metaRow);

    // ── Actions ──
    const actions = document.createElement('div');
    actions.className = 'bd-item-actions';

    if (!item.promotedTo) {
      const promoteBtn = document.createElement('button');
      promoteBtn.type = 'button';
      promoteBtn.className = 'bd-action-btn';
      promoteBtn.textContent = 'Promote';
      promoteBtn.addEventListener('click', () => openPromoteModal(item));
      actions.appendChild(promoteBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'bd-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openEditModal(item));
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'bd-action-btn bd-action-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      if (!confirm(`Delete "${item.text.slice(0, 60)}${item.text.length > 60 ? '…' : ''}"?`)) return;
      global.Pike.state.commit((d) => {
        d.brainDump = (d.brainDump || []).filter((x) => x.id !== item.id);
      });
    });
    actions.appendChild(deleteBtn);

    el.appendChild(body);
    el.appendChild(actions);
    return el;
  }

  // ─── Promote modal ────────────────────────────────────────────────────────────
  // Future-friendly: "promote to" currently means task system.
  // The promotedTo object uses { type, label, targetId } so other destinations
  // (e.g. People, Travel) can be added later without a data migration.

  function openPromoteModal(item) {
    const weekendRhythms = (getData().rhythms || []).filter(
      (r) => r.schedule?.type === 'weekends' && r.active
    );

    const rhythmRadioHTML = weekendRhythms.length ? `
      <label class="task-picker-bucket-option">
        <input type="radio" name="bucket" value="rhythm">
        <span>
          <strong>Weekend Rhythm subtask</strong>
          <span class="task-picker-bucket-desc">Adds to your weekend routine checklist</span>
        </span>
      </label>` : '';

    const rhythmSelectHTML = weekendRhythms.length ? `
      <div id="promote-rhythm-select" hidden>
        <label>
          <span>Add to which rhythm</span>
          <select class="input" name="rhythmId">
            ${weekendRhythms.map((r) => `<option value="${esc(r.id)}">${esc(r.title)}</option>`).join('')}
          </select>
        </label>
      </div>` : '';

    const form = document.createElement('form');
    form.innerHTML = `
      <p class="bd-promote-source">${esc(item.text)}</p>
      <fieldset class="task-picker-buckets">
        <legend>Promote to</legend>
        <label class="task-picker-bucket-option">
          <input type="radio" name="bucket" value="other" checked>
          <span>
            <strong>Task Library</strong>
            <span class="task-picker-bucket-desc">Saved to your library — add to today when ready</span>
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
      <label>
        <span>Duration (optional)</span>
        <input type="text" class="input" name="estimate" placeholder="30m, 1h, 1h 30m">
      </label>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">Promote</button>
      </div>
    `;

    if (weekendRhythms.length) {
      form.querySelectorAll('[name="bucket"]').forEach((radio) => {
        radio.addEventListener('change', () => {
          const v = form.querySelector('[name="bucket"]:checked')?.value;
          form.querySelector('#promote-rhythm-select').hidden = v !== 'rhythm';
        });
      });
    }

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const bucket = fd.get('bucket') || 'other';
      const estimate = parseDuration(String(fd.get('estimate') || '')) || null;
      const rhythmId = fd.get('rhythmId');

      let promotedLabel = 'Task Library';
      let targetId = null;

      global.Pike.state.commit((d) => {
        d.tasks = d.tasks || [];
        d.rhythms = d.rhythms || [];

        if (bucket === 'rhythm') {
          const rhythm = (d.rhythms).find((r) => r.id === rhythmId);
          if (rhythm) {
            if (!rhythm.subtasks) rhythm.subtasks = [];
            const subId = `sub_${Date.now().toString(36)}`;
            rhythm.subtasks.push({
              id: subId,
              title: item.text,
              estimateMinutes: estimate,
              brainDumpId: item.id,
            });
            promotedLabel = rhythm.title;
            targetId = subId;
          }
        } else {
          targetId = `lib_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
          d.tasks.push({
            id: targetId,
            title: item.text,
            estimateMinutes: estimate,
            scheduledDate: null,
            scheduledStart: null,
            completedAt: null,
            isLibrary: true,
            isDefaultDaily: bucket === 'daily',
            category: 'self',
            brainDumpId: item.id,
          });
          promotedLabel = bucket === 'daily' ? 'Daily Defaults' : 'Task Library';
        }

        // Mark the brain dump entry as promoted — original stays visible
        const bdItem = (d.brainDump || []).find((x) => x.id === item.id);
        if (bdItem) {
          bdItem.promotedTo = { type: 'task', targetId, label: promotedLabel };
        }
      });

      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: 'Promote idea', body: form });
  }

  // ─── Edit modal ───────────────────────────────────────────────────────────────

  function openEditModal(item) {
    const catOptionsHTML = CATEGORIES.map((cat) =>
      `<option value="${esc(cat.id)}"${item.category === cat.id ? ' selected' : ''}>${esc(cat.label)}</option>`
    ).join('');

    const form = document.createElement('form');
    form.innerHTML = `
      <label>
        <span>Idea</span>
        <textarea class="input bd-edit-textarea" name="text" required maxlength="500" rows="3">${esc(item.text)}</textarea>
      </label>
      <label>
        <span>Category</span>
        <select class="input" name="category">
          ${catOptionsHTML}
        </select>
      </label>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    `;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const text = String(fd.get('text') || '').trim();
      if (!text) return;
      const category = String(fd.get('category') || 'uncategorized');
      global.Pike.state.commit((d) => {
        const bdItem = (d.brainDump || []).find((x) => x.id === item.id);
        if (bdItem) { bdItem.text = text; bdItem.category = category; }
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: 'Edit idea', body: form });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    // Global 'b' shortcut — focus capture input without hijacking typing elsewhere
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'b' && e.key !== 'B') return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag && ['input', 'textarea', 'select'].includes(tag)) return;
      if (document.activeElement?.isContentEditable) return;
      // Don't activate while a modal is open
      const modal = document.getElementById('pike-modal');
      if (modal && !modal.hidden) return;
      // Navigate to Brain Dump section and focus the input
      location.hash = '#braindump';
      if (global.Pike.router) global.Pike.router.activate('braindump');
      setTimeout(() => {
        const input = document.getElementById('braindump-input');
        if (input) input.focus();
      }, 60);
    });
  }

  global.Pike = global.Pike || {};
  global.Pike.braindump = { init, render };

})(window);
