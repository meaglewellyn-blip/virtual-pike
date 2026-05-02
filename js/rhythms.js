/* Virtual Pike — Rhythms module
 * Manages the 4-day workout sequence and weekly routine rhythms.
 */

(function (global) {
  'use strict';

  const WORKOUT_ORDER = [
    {
      id: 'shoulders-back',
      label: 'Shoulders / Back',
      exercises: [
        'Lateral raises',
        'Lat pull downs',
        'Seated rows',
        'Strict press',
        'Cable bar pull down / straight arms',
      ],
    },
    {
      id: 'glutes-hams',
      label: 'Glutes / Hams',
      exercises: [
        'Abduction',
        'Adduction',
        'Bulgarian split squats',
        'Hip thrusts',
        'Leg press (high foot position)',
      ],
    },
    {
      id: 'chest-bi-tri',
      label: 'Chest / Bicep / Triceps',
      exercises: [
        'Chest press',
        'Chest flys',
        'Dumbbell curls',
        'V-bar tricep extensions',
        'Hammer curls',
      ],
    },
    {
      id: 'legs-abs',
      label: 'Legs / Abs',
      exercises: [
        'Leg extensions',
        'Seated leg curls',
        'Elevated front-foot split squats',
        'Curtsy lunges or step-ups',
        'Deep core exercises',
      ],
    },
  ];

  const CARDIO_FINISHER = '15–20 min cardio (jog, elliptical, stair master)';

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function uid(prefix) {
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function parseTimeInput(s) {
    if (!s) return '';
    const t = s.trim().toLowerCase().replace(/\s+/g, '');
    const full = t.match(/^(\d{1,2}):(\d{2})(am|pm)?$/);
    if (full) {
      let h = parseInt(full[1], 10), m = parseInt(full[2], 10);
      if (full[3] === 'pm' && h !== 12) h += 12;
      else if (full[3] === 'am' && h === 12) h = 0;
      if (h >= 0 && h < 24 && m >= 0 && m < 60)
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    const bare = t.match(/^(\d{1,2})(am|pm)$/);
    if (bare) {
      let h = parseInt(bare[1], 10);
      if (bare[2] === 'pm' && h !== 12) h += 12;
      else if (bare[2] === 'am' && h === 12) h = 0;
      if (h >= 0 && h < 24) return `${String(h).padStart(2, '0')}:00`;
    }
    return '';
  }

  function fmtTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  function fmtSchedule(schedule) {
    if (!schedule) return '';
    const dayName = schedule.day
      ? DAYS.find((d) => d.toLowerCase() === schedule.day) || schedule.day
      : '';
    const timePart = schedule.time ? ` · ${fmtTime(schedule.time)}` : '';
    if (schedule.type === 'weekly')   return `Every ${dayName}${timePart}`;
    if (schedule.type === 'daily')    return `Every day${timePart}`;
    if (schedule.type === 'weekdays') return `Every weekday${timePart}`;
    if (schedule.type === 'weekends') return `Every weekend${timePart}`;
    return '';
  }

  // ── State mutations ──────────────────────────────────────────────────────────

  // ── Period completion helpers ────────────────────────────────────────────────

  function pad2date(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function getISOWeekKey(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  function computePeriodKey(rhythm, date) {
    if (rhythm.schedule && rhythm.schedule.type === 'daily') return pad2date(date);
    return getISOWeekKey(date);
  }

  function isRhythmDoneThisPeriod(rhythm, date) {
    const completions = global.Pike.state.data.rhythmCompletions || {};
    return completions[rhythm.id + '::' + computePeriodKey(rhythm, date)] === true;
  }

  function markRhythmDone(rhythmId, date) {
    const rhythm = (global.Pike.state.data.rhythms || []).find((r) => r.id === rhythmId);
    if (!rhythm) return;
    const key = rhythmId + '::' + computePeriodKey(rhythm, date);
    global.Pike.state.commit((d) => {
      if (!d.rhythmCompletions) d.rhythmCompletions = {};
      d.rhythmCompletions[key] = true;
    });
  }

  // ── Subtask helpers ──────────────────────────────────────────────────────────

  function getAllocatedSubtasksForDay(rhythm, date) {
    if (!rhythm.subtasks || !rhythm.subtasks.length) return [];
    const dayName = DAYS[date.getDay()].toLowerCase();
    if (dayName !== 'saturday' && dayName !== 'sunday') return [];
    const isoWeek = getISOWeekKey(date);
    const alloc = (rhythm.weekendAllocations || {})[isoWeek];
    if (alloc === undefined) return null; // null = not planned yet
    return rhythm.subtasks.filter((sub) => alloc[sub.id] === dayName);
  }

  function isSubtaskDone(rhythm, subtaskId, date) {
    const completions = global.Pike.state.data.rhythmCompletions || {};
    return completions[rhythm.id + '::' + subtaskId + '::' + getISOWeekKey(date)] === true;
  }

  function markSubtaskDone(rhythmId, subtaskId, date) {
    const key = rhythmId + '::' + subtaskId + '::' + getISOWeekKey(date);
    global.Pike.state.commit((d) => {
      if (!d.rhythmCompletions) d.rhythmCompletions = {};
      d.rhythmCompletions[key] = true;
    });
  }

  function formatWeekLabel(date) {
    const day = date.getDay();
    const mon = new Date(date);
    mon.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return mon.getMonth() === sun.getMonth()
      ? `${months[mon.getMonth()]} ${mon.getDate()}–${sun.getDate()}`
      : `${months[mon.getMonth()]} ${mon.getDate()} – ${months[sun.getMonth()]} ${sun.getDate()}`;
  }

  function openPlanWeekendModal(rhythm) {
    const isoWeek = getISOWeekKey(new Date());
    const existing = (rhythm.weekendAllocations || {})[isoWeek] || {};

    const container = document.createElement('div');
    container.className = 'rhythm-plan-modal';

    if (!rhythm.subtasks || !rhythm.subtasks.length) {
      container.innerHTML = `<p style="margin:0 0 var(--space-4);color:var(--text-muted)">No subtasks defined. Edit this routine to add subtasks first.</p>
        <div class="pike-modal-actions"><button type="button" class="btn" data-modal-close="1">Close</button></div>`;
      global.Pike.modal.open({ title: 'Plan this weekend', body: container });
      return;
    }

    const rows = rhythm.subtasks.map((sub) => {
      const cur = existing[sub.id] || '';
      return `<div class="rhythm-plan-row" data-subtask-id="${esc(sub.id)}">
        <span class="rhythm-plan-row-title">${esc(sub.title)}</span>
        <div class="rhythm-day-toggle">
          <button type="button" class="rhythm-day-btn${cur === 'saturday' ? ' is-active' : ''}" data-day="saturday">Sat</button>
          <button type="button" class="rhythm-day-btn${cur === 'sunday' ? ' is-active' : ''}" data-day="sunday">Sun</button>
          <button type="button" class="rhythm-day-btn${!cur ? ' is-active' : ''}" data-day="">Skip</button>
        </div>
      </div>`;
    }).join('');

    container.innerHTML = `
      <p class="rhythm-plan-week-label">${esc(formatWeekLabel(new Date()))}</p>
      <div class="rhythm-plan-list">${rows}</div>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="button" class="btn btn-primary" id="rhythm-plan-save">Save plan</button>
      </div>`;

    container.querySelectorAll('.rhythm-plan-row').forEach((row) => {
      row.querySelectorAll('.rhythm-day-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          row.querySelectorAll('.rhythm-day-btn').forEach((b) => b.classList.remove('is-active'));
          btn.classList.add('is-active');
        });
      });
    });

    container.querySelector('#rhythm-plan-save').addEventListener('click', () => {
      const alloc = {};
      container.querySelectorAll('.rhythm-plan-row').forEach((row) => {
        const sid = row.dataset.subtaskId;
        const day = row.querySelector('.rhythm-day-btn.is-active')?.dataset.day || '';
        alloc[sid] = day || null;
      });
      global.Pike.state.commit((d) => {
        const r = (d.rhythms || []).find((x) => x.id === rhythm.id);
        if (!r) return;
        if (!r.weekendAllocations) r.weekendAllocations = {};
        r.weekendAllocations[isoWeek] = alloc;
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: `Plan this weekend — ${esc(rhythm.title)}`, body: container });
  }

  // ── State init ───────────────────────────────────────────────────────────────

  function init() {
    const data = global.Pike.state.data;
    const needsWorkout = !data.workoutSequence || !data.workoutSequence.order || data.workoutSequence.order.length === 0;
    const needsRhythms = !data.rhythms;
    const needsCompletions = !data.rhythmCompletions;
    if (needsWorkout || needsRhythms || needsCompletions) {
      global.Pike.state.commit((d) => {
        if (!d.workoutSequence || !d.workoutSequence.order || d.workoutSequence.order.length === 0) {
          const prevIndex = d.workoutSequence?.nextIndex || 0;
          const prevHistory = d.workoutSequence?.history || [];
          d.workoutSequence = { order: WORKOUT_ORDER, nextIndex: prevIndex, history: prevHistory };
        }
        if (!d.rhythms) d.rhythms = [];
        if (!d.rhythmCompletions) d.rhythmCompletions = {};
      });
    }
  }

  function markWorkoutComplete() {
    global.Pike.state.commit((d) => {
      if (!d.workoutSequence) return;
      const ws = d.workoutSequence;
      const idx = (ws.nextIndex || 0) % ws.order.length;
      ws.history = ws.history || [];
      ws.history.push({ type: ws.order[idx].id, completedAt: new Date().toISOString() });
      ws.nextIndex = (idx + 1) % ws.order.length;
    });
  }

  function skipWorkout() {
    global.Pike.state.commit((d) => {
      if (!d.workoutSequence) return;
      const ws = d.workoutSequence;
      ws.nextIndex = ((ws.nextIndex || 0) + 1) % ws.order.length;
    });
  }

  // ── Modals ───────────────────────────────────────────────────────────────────

  function openRhythmModal(existing) {
    const isEdit = !!existing;
    const initial = existing || {
      id: uid('rhy'),
      title: '',
      schedule: { type: 'weekly', day: 'monday', time: '' },
      active: true,
    };

    const form = document.createElement('form');
    form.id = 'rhythm-form';
    form.innerHTML = `
      <label>
        <span>Name</span>
        <input type="text" class="input" name="title" required maxlength="80"
          value="${esc(initial.title)}" autocomplete="off"
          placeholder="e.g. Home group, Morning walk">
      </label>
      <label>
        <span>Repeats</span>
        <select class="input" name="scheduleType">
          <option value="weekly"   ${initial.schedule.type === 'weekly'   ? 'selected' : ''}>Weekly (pick a day)</option>
          <option value="daily"    ${initial.schedule.type === 'daily'    ? 'selected' : ''}>Every day</option>
          <option value="weekdays" ${initial.schedule.type === 'weekdays' ? 'selected' : ''}>Every weekday</option>
          <option value="weekends" ${initial.schedule.type === 'weekends' ? 'selected' : ''}>Every weekend</option>
        </select>
      </label>
      <div id="rhythm-day-row" ${initial.schedule.type !== 'weekly' ? 'hidden' : ''}>
        <label>
          <span>Day</span>
          <select class="input" name="day">
            ${DAYS.map((d) => `<option value="${d.toLowerCase()}" ${initial.schedule.day === d.toLowerCase() ? 'selected' : ''}>${d}</option>`).join('')}
          </select>
        </label>
      </div>
      <label>
        <span>Time <span class="muted">(optional)</span></span>
        <input type="text" class="input" name="time" autocomplete="off"
          placeholder="e.g. 7:00 PM"
          value="${esc(initial.schedule.time ? fmtTime(initial.schedule.time) : '')}">
      </label>
      <div id="rhythm-subtasks-section" ${initial.schedule.type !== 'weekends' ? 'hidden' : ''}>
        <div class="rhythm-subtask-header">
          <span>Subtasks <span class="muted">(optional)</span></span>
          <button type="button" class="btn btn-ghost btn-sm" id="rhythm-subtask-add">+ Add</button>
        </div>
        <div id="rhythm-subtask-list" class="rhythm-subtask-list"></div>
      </div>
      <div class="pike-modal-actions">
        ${isEdit ? '<button type="button" class="btn btn-danger" data-action="delete">Delete</button>' : ''}
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add rhythm'}</button>
      </div>
    `;

    // Subtask editor helpers
    const subtaskListEl = form.querySelector('#rhythm-subtask-list');
    function addSubtaskRow(subtask) {
      const row = document.createElement('div');
      row.className = 'rhythm-subtask-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'input rhythm-subtask-input';
      input.placeholder = 'e.g. Vacuum, Clean kitchen';
      input.maxLength = 60;
      input.autocomplete = 'off';
      input.dataset.subtaskId = subtask ? subtask.id : uid('sub');
      if (subtask) input.value = subtask.title;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'rhythm-subtask-remove';
      removeBtn.setAttribute('aria-label', 'Remove subtask');
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => row.remove());
      row.appendChild(input);
      row.appendChild(removeBtn);
      subtaskListEl.appendChild(row);
      input.focus();
    }

    // Populate existing subtasks when editing
    if (isEdit && initial.subtasks && initial.subtasks.length) {
      initial.subtasks.forEach((sub) => addSubtaskRow(sub));
    }

    form.querySelector('#rhythm-subtask-add').addEventListener('click', () => addSubtaskRow(null));

    form.querySelector('[name="scheduleType"]').addEventListener('change', (e) => {
      form.querySelector('#rhythm-day-row').hidden = e.target.value !== 'weekly';
      form.querySelector('#rhythm-subtasks-section').hidden = e.target.value !== 'weekends';
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd    = new FormData(form);
      const title = String(fd.get('title') || '').trim();
      if (!title) return;
      const schedType  = String(fd.get('scheduleType'));
      const day        = String(fd.get('day') || 'monday');
      const parsedTime = parseTimeInput(String(fd.get('time') || ''));
      const schedule   = { type: schedType };
      if (schedType === 'weekly') schedule.day = day;
      if (parsedTime) schedule.time = parsedTime;

      const subtasks = [];
      subtaskListEl.querySelectorAll('.rhythm-subtask-input').forEach((inp) => {
        const val = inp.value.trim();
        if (val) subtasks.push({ id: inp.dataset.subtaskId, title: val });
      });

      global.Pike.state.commit((d) => {
        d.rhythms = d.rhythms || [];
        const rhythm = { id: initial.id, title, schedule, active: true };
        if (subtasks.length) rhythm.subtasks = subtasks;
        if (isEdit && initial.weekendAllocations) rhythm.weekendAllocations = initial.weekendAllocations;
        if (isEdit) {
          const idx = d.rhythms.findIndex((r) => r.id === initial.id);
          if (idx >= 0) d.rhythms[idx] = rhythm; else d.rhythms.push(rhythm);
        } else {
          d.rhythms.push(rhythm);
        }
      });
      global.Pike.modal.close();
    });

    form.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      if (!confirm('Delete this rhythm?')) return;
      global.Pike.state.commit((d) => {
        d.rhythms = (d.rhythms || []).filter((r) => r.id !== initial.id);
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: isEdit ? 'Edit rhythm' : 'New rhythm', body: form });
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  function renderWorkoutCard() {
    const container = document.getElementById('rhythms-workout');
    if (!container) return;

    const ws = global.Pike.state.data.workoutSequence;
    if (!ws || !ws.order || !ws.order.length) { container.innerHTML = ''; return; }

    const idx     = (ws.nextIndex || 0) % ws.order.length;
    const next    = ws.order[idx];
    const history = ws.history || [];
    const last    = history.length ? history[history.length - 1] : null;

    const lastHTML = last ? (() => {
      const d     = new Date(last.completedAt);
      const label = ws.order.find((o) => o.id === last.type)?.label || last.type;
      return `<div class="rhythm-workout-last">Last: <strong>${esc(label)}</strong> · ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>`;
    })() : '';

    const dots = ws.order.map((w, i) =>
      `<span class="workout-dot${i === idx ? ' is-current' : ''}" title="${esc(w.label)}"></span>`
    ).join('');

    const exercises = next.exercises.map((e) => `<li>${esc(e)}</li>`).join('');

    container.innerHTML = `
      <div class="rhythm-workout-card">
        <div class="rhythm-workout-header">
          <div>
            <div class="rhythm-workout-eyebrow">Next workout</div>
            <h2 class="rhythm-workout-title">${esc(next.label)}</h2>
          </div>
          <div class="workout-sequence-dots">${dots}</div>
        </div>
        <ol class="rhythm-workout-exercises">${exercises}</ol>
        <div class="rhythm-workout-finisher">+ Optional: ${esc(CARDIO_FINISHER)}</div>
        ${lastHTML}
        <div class="rhythm-workout-actions">
          <button class="btn btn-primary" id="rhy-complete" type="button">Mark complete</button>
          <button class="btn btn-ghost btn-sm" id="rhy-skip" type="button">Skip →</button>
        </div>
      </div>
    `;

    container.querySelector('#rhy-complete').addEventListener('click', markWorkoutComplete);
    container.querySelector('#rhy-skip').addEventListener('click', skipWorkout);
  }

  function renderRhythmsList() {
    const listEl  = document.getElementById('rhythms-list');
    const emptyEl = document.getElementById('rhythms-empty');
    const addBtn  = document.getElementById('rhythms-add');
    if (!listEl) return;

    if (addBtn && !addBtn._wired) {
      addBtn.addEventListener('click', () => openRhythmModal());
      addBtn._wired = true;
    }

    const rhythms = global.Pike.state.data.rhythms || [];
    if (!rhythms.length) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.hidden = false;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    listEl.innerHTML = rhythms.map((r) => {
      const hasSubtasks = r.subtasks && r.subtasks.length > 0;
      const isWeekendType = r.schedule?.type === 'weekends';
      return `
        <div class="rhythm-item" data-id="${esc(r.id)}">
          <div class="rhythm-item-info">
            <div class="rhythm-item-title">${esc(r.title)}</div>
            ${r.schedule ? `<div class="rhythm-item-schedule">${esc(fmtSchedule(r.schedule))}${hasSubtasks ? ` · ${r.subtasks.length} subtask${r.subtasks.length > 1 ? 's' : ''}` : ''}</div>` : ''}
          </div>
          <div class="rhythm-item-actions">
            ${isWeekendType && hasSubtasks ? `<button class="btn btn-ghost btn-sm rhythm-plan-btn" data-id="${esc(r.id)}" type="button">Plan weekend</button>` : ''}
            <button class="btn btn-ghost btn-sm rhythm-edit-btn" data-id="${esc(r.id)}" type="button">Edit</button>
          </div>
        </div>`;
    }).join('');

    listEl.querySelectorAll('.rhythm-plan-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = rhythms.find((x) => x.id === btn.dataset.id);
        if (r) openPlanWeekendModal(r);
      });
    });
    listEl.querySelectorAll('.rhythm-edit-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const r = rhythms.find((x) => x.id === btn.dataset.id);
        if (r) openRhythmModal(r);
      });
    });
  }

  function render() {
    renderWorkoutCard();
    renderRhythmsList();
  }

  global.Pike = global.Pike || {};
  global.Pike.rhythms = {
    init, render,
    isRhythmDoneThisPeriod, markRhythmDone, getISOWeekKey,
    getAllocatedSubtasksForDay, isSubtaskDone, markSubtaskDone,
    openPlanWeekendModal,
  };
})(window);
