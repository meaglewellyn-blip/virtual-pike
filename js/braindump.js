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
    { id: 'movies',          label: 'Movies' },
    { id: 'books',           label: 'Books' },
    { id: 'podcasts',        label: 'Podcasts' },
    { id: 'writing',         label: 'Writing' },
    { id: 'claude-projects', label: 'Claude Projects' },
    { id: 'places',          label: 'Places' },
    { id: 'other',           label: 'Other' },
    { id: 'dont-forget',     label: "Don't Forget" },
  ];

  // ─── Module state ─────────────────────────────────────────────────────────────

  let activeFilter = 'all';
  let _shortcutWired = false;

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

    // ── Input row: text input + submit button ──
    const inputRow = document.createElement('div');
    inputRow.className = 'bd-capture-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bd-capture-input';
    input.id = 'braindump-input';
    input.placeholder = "What's on your mind?";
    input.maxLength = 500;
    input.autocomplete = 'off';

    const submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.className = 'bd-capture-submit';
    submitBtn.setAttribute('aria-label', 'Save');
    submitBtn.textContent = '→';

    inputRow.appendChild(input);
    inputRow.appendChild(submitBtn);

    // ── Category pills ──
    const catRow = document.createElement('div');
    catRow.className = 'bd-capture-cats';

    let selectedCat = null;

    CATEGORIES.forEach((cat) => {
      if (cat.id === 'uncategorized') return;
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

    // ── Expand toggle ──
    let expanded = false;
    const expandToggle = document.createElement('button');
    expandToggle.type = 'button';
    expandToggle.className = 'bd-expand-toggle';
    expandToggle.textContent = '+ details';

    // ── Expanded section: notes, link, checklist ──
    const expandedSection = document.createElement('div');
    expandedSection.className = 'bd-expanded';
    expandedSection.hidden = true;

    // Notes
    const notesTextarea = document.createElement('textarea');
    notesTextarea.className = 'input bd-expanded-textarea';
    notesTextarea.placeholder = 'Additional context…';
    notesTextarea.rows = 2;
    notesTextarea.setAttribute('aria-label', 'Notes');

    // Link
    const linkInput = document.createElement('input');
    linkInput.type = 'url';
    linkInput.className = 'input';
    linkInput.placeholder = 'Paste a link… (https://…)';
    linkInput.setAttribute('aria-label', 'Link');

    // Checklist builder
    const clWrap = document.createElement('div');
    clWrap.className = 'bd-checklist-builder';

    const clList = document.createElement('div');
    clList.className = 'bd-cl-list';

    const clAddRow = document.createElement('div');
    clAddRow.className = 'bd-cl-add-row';
    const clInput = document.createElement('input');
    clInput.type = 'text';
    clInput.className = 'input';
    clInput.placeholder = 'Add checklist item…';
    const clAddBtn = document.createElement('button');
    clAddBtn.type = 'button';
    clAddBtn.className = 'btn btn-ghost btn-sm';
    clAddBtn.textContent = '+';
    clAddRow.appendChild(clInput);
    clAddRow.appendChild(clAddBtn);

    clWrap.appendChild(clList);
    clWrap.appendChild(clAddRow);

    // In-memory checklist items for this capture session
    const captureChecklist = [];

    function renderCaptureClList() {
      clList.innerHTML = '';
      captureChecklist.forEach((ci, idx) => {
        const row = document.createElement('div');
        row.className = 'bd-cl-item';
        const labelEl = document.createElement('span');
        labelEl.textContent = ci.text;
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'bd-cl-remove';
        removeBtn.setAttribute('aria-label', 'Remove item');
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
          captureChecklist.splice(idx, 1);
          renderCaptureClList();
        });
        row.appendChild(labelEl);
        row.appendChild(removeBtn);
        clList.appendChild(row);
      });
    }

    function addCaptureClItem() {
      const text = clInput.value.trim();
      if (!text) return;
      captureChecklist.push({ id: `ci_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`, text });
      clInput.value = '';
      renderCaptureClList();
    }

    clAddBtn.addEventListener('click', addCaptureClItem);
    clInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addCaptureClItem(); }
    });

    expandedSection.appendChild(notesTextarea);
    expandedSection.appendChild(linkInput);
    expandedSection.appendChild(clWrap);

    expandToggle.addEventListener('click', () => {
      expanded = !expanded;
      expandedSection.hidden = !expanded;
      expandToggle.textContent = expanded ? '− details' : '+ details';
      if (expanded) notesTextarea.focus();
    });

    // ── Save logic ──
    function saveCapture() {
      const text = input.value.trim();
      if (!text) return;

      const notes = notesTextarea.value.trim();
      const link  = linkInput.value.trim();
      const checklist = captureChecklist.length
        ? captureChecklist.map((ci) => ({ id: ci.id, text: ci.text, done: false }))
        : [];

      global.Pike.state.commit((d) => {
        if (!d.brainDump) d.brainDump = [];
        d.brainDump.unshift({
          id: uid(),
          text,
          category: selectedCat || 'uncategorized',
          createdAt: new Date().toISOString(),
          status: 'active',
          promotedTo: null,
          notes,
          link,
          checklist,
        });
      });

      // Reset capture state
      input.value = '';
      notesTextarea.value = '';
      linkInput.value = '';
      captureChecklist.length = 0;
      renderCaptureClList();
      selectedCat = null;
      catRow.querySelectorAll('.bd-cat-pill').forEach((b) => b.classList.remove('is-selected'));

      // Collapse details after save
      if (expanded) {
        expanded = false;
        expandedSection.hidden = true;
        expandToggle.textContent = '+ details';
      }

      input.focus();
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveCapture(); }
    });
    submitBtn.addEventListener('click', saveCapture);

    wrap.appendChild(inputRow);
    wrap.appendChild(catRow);
    wrap.appendChild(expandToggle);
    wrap.appendChild(expandedSection);
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
        ? 'Nothing here yet. Type something above to save it.'
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

    // Main text
    const textEl = document.createElement('p');
    textEl.className = 'bd-item-text';
    textEl.textContent = item.text;
    body.appendChild(textEl);

    // Notes
    if (item.notes) {
      const notesEl = document.createElement('p');
      notesEl.className = 'bd-item-notes';
      notesEl.textContent = item.notes;
      body.appendChild(notesEl);
    }

    // Link
    if (item.link) {
      const linkEl = document.createElement('a');
      linkEl.className = 'bd-item-link';
      linkEl.href = item.link;
      linkEl.target = '_blank';
      linkEl.rel = 'noopener noreferrer';
      try {
        linkEl.textContent = new URL(item.link).hostname.replace(/^www\./, '');
      } catch (_) {
        linkEl.textContent = item.link;
      }
      body.appendChild(linkEl);
    }

    // Checklist (interactive — toggle done/undone directly on the card)
    if (item.checklist && item.checklist.length) {
      const clWrap = document.createElement('div');
      clWrap.className = 'bd-item-checklist';
      item.checklist.forEach((ci) => {
        const row = document.createElement('div');
        row.className = 'bd-item-cl-row' + (ci.done ? ' is-done' : '');

        const checkBtn = document.createElement('button');
        checkBtn.type = 'button';
        checkBtn.className = 'bd-item-cl-check';
        checkBtn.setAttribute('aria-label', ci.done ? 'Mark undone' : 'Mark done');
        checkBtn.addEventListener('click', () => {
          global.Pike.state.commit((d) => {
            const bdItem = (d.brainDump || []).find((x) => x.id === item.id);
            if (!bdItem) return;
            const clItem = (bdItem.checklist || []).find((x) => x.id === ci.id);
            if (clItem) clItem.done = !clItem.done;
          });
        });

        const labelEl = document.createElement('span');
        labelEl.textContent = ci.text;
        row.appendChild(checkBtn);
        row.appendChild(labelEl);
        clWrap.appendChild(row);
      });
      body.appendChild(clWrap);
    }

    // Meta row: category badge + date + promoted badge
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
    form.className = 'bd-edit-form';
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
      <label>
        <span>Notes</span>
        <textarea class="input bd-edit-textarea" name="notes" rows="2" placeholder="Additional context…">${esc(item.notes || '')}</textarea>
      </label>
      <label>
        <span>Link</span>
        <input type="url" class="input" name="link" placeholder="https://…" value="${esc(item.link || '')}">
      </label>
      <div class="bd-edit-checklist-wrap">
        <span class="bd-edit-cl-label">Checklist</span>
        <div id="bd-edit-cl-list" class="bd-cl-list"></div>
        <div class="bd-cl-add-row">
          <input type="text" class="input" id="bd-edit-cl-input" placeholder="Add item…">
          <button type="button" class="btn btn-ghost btn-sm" id="bd-edit-cl-add">+</button>
        </div>
      </div>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    `;

    // Work with a mutable copy of the checklist
    const checklist = (item.checklist || []).map((ci) => ({ ...ci }));

    function refreshEditClList() {
      const listEl = form.querySelector('#bd-edit-cl-list');
      listEl.innerHTML = '';
      checklist.forEach((ci, idx) => {
        const row = document.createElement('div');
        row.className = 'bd-cl-item';

        const textInput = document.createElement('input');
        textInput.type = 'text';
        textInput.className = 'input bd-cl-item-input';
        textInput.value = ci.text;
        textInput.addEventListener('input', () => { ci.text = textInput.value; });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'bd-cl-remove';
        removeBtn.setAttribute('aria-label', 'Remove item');
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', () => {
          checklist.splice(idx, 1);
          refreshEditClList();
        });

        row.appendChild(textInput);
        row.appendChild(removeBtn);
        listEl.appendChild(row);
      });
    }
    refreshEditClList();

    function addEditClItem() {
      const clInput = form.querySelector('#bd-edit-cl-input');
      const text = clInput.value.trim();
      if (!text) return;
      checklist.push({ id: `ci_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,6)}`, text, done: false });
      clInput.value = '';
      refreshEditClList();
    }

    form.querySelector('#bd-edit-cl-add').addEventListener('click', addEditClItem);
    form.querySelector('#bd-edit-cl-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addEditClItem(); }
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const text = String(fd.get('text') || '').trim();
      if (!text) return;
      const category = String(fd.get('category') || 'uncategorized');
      const notes    = String(fd.get('notes') || '').trim();
      const link     = String(fd.get('link') || '').trim();

      global.Pike.state.commit((d) => {
        const bdItem = (d.brainDump || []).find((x) => x.id === item.id);
        if (bdItem) {
          bdItem.text = text;
          bdItem.category = category;
          bdItem.notes = notes;
          bdItem.link = link;
          bdItem.checklist = checklist.filter((ci) => ci.text.trim());
        }
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: 'Edit idea', body: form });
  }

  // ─── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    // Wire keyboard shortcut once only — this function is called on every state change
    if (!_shortcutWired) {
      _shortcutWired = true;
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'b' && e.key !== 'B') return;
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const tag = document.activeElement?.tagName?.toLowerCase();
        if (tag && ['input', 'textarea', 'select'].includes(tag)) return;
        if (document.activeElement?.isContentEditable) return;
        const modal = document.getElementById('pike-modal');
        if (modal && !modal.hidden) return;
        location.hash = '#braindump';
        if (global.Pike.router) global.Pike.router.activate('braindump');
        setTimeout(() => {
          const input = document.getElementById('braindump-input');
          if (input) input.focus();
        }, 60);
      });
    }

    // ── One-time media import (flag: brainDumpImportV1) ──────────────────────────
    if (!global.Pike.state.data.brainDumpImportV1) {
      const now = new Date().toISOString();
      function mkEntry(text, category, notes) {
        return { id: uid(), text, category, createdAt: now, status: 'active', promotedTo: null, notes: notes || '', link: '', checklist: [] };
      }
      const entries = [
        // Movies
        mkEntry('The Imitation Game',   'movies'),
        mkEntry('Maleficent',           'movies'),
        mkEntry('Gifted',               'movies'),
        mkEntry('Byzantium',            'movies'),
        mkEntry('Love & Other Drugs',   'movies'),
        mkEntry('Blindness',            'movies'),
        // Shows
        mkEntry('Grief',                                          'shows'),
        mkEntry('Behind Her Eyes',                                'shows'),
        mkEntry('Paradise',                                       'shows', 'Hulu'),
        mkEntry('The Pendragon Cycle: Rise of the Merlin',        'shows', '2026'),
        mkEntry("It's All Her Fault",                             'shows', 'Peacock'),
        mkEntry('Nikita',                                         'shows'),
        mkEntry('Revenge',                                        'shows'),
        mkEntry('The Night Manager',                              'shows'),
        mkEntry('The Madison',                                    'shows'),
        mkEntry('Scarpetta',                                      'shows'),
        mkEntry('Poldark',                                        'shows'),
        mkEntry('The Lioness',                                    'shows'),
      ];
      global.Pike.state.commit((d) => {
        if (!d.brainDump) d.brainDump = [];
        d.brainDump.unshift(...entries);
        d.brainDumpImportV1 = true;
      });
    }
  }

  global.Pike = global.Pike || {};
  global.Pike.braindump = { init, render };

})(window);
