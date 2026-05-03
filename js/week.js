/* Virtual Pike — Week view
 * Shows Mon–Sun for the current (or offset) week.
 * Each day lists events, scheduled tasks, and rhythms that fall on that day.
 */

(function (global) {
  'use strict';

  const DAY_SHORT  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_LONG   = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  let weekOffset = 0;
  let currentWeekDates = null;

  function pad2(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function fmtTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = hhmm.split(':').map(Number);
    return `${h % 12 || 12}:${pad2(m)} ${h >= 12 ? 'PM' : 'AM'}`;
  }

  function getWeekDates(offset) {
    const now = new Date();
    const day = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1) + offset * 7);
    monday.setHours(0, 0, 0, 0);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      return d;
    });
  }

  function rhythmsForDay(date, rhythms) {
    const dayName   = DAY_LONG[date.getDay()];
    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
    const items     = [];

    (rhythms || []).forEach((r) => {
      if (!r.active || !r.schedule) return;
      const s = r.schedule;
      let matches = false;
      if (s.type === 'daily')    matches = true;
      if (s.type === 'weekdays') matches = !isWeekend;
      if (s.type === 'weekends') matches = isWeekend;
      if (s.type === 'weekly')   matches = s.day === dayName;
      if (!matches) return;

      if (r.subtasks && r.subtasks.length) {
        const allocated = global.Pike.rhythms.getAllocatedSubtasksForDay(r, date);
        if (allocated === null) {
          // Not planned yet — show a nudge
          items.push({ id: r.id, title: r.title, schedule: null, _isUnplanned: true });
        } else {
          // Show undone allocated subtasks
          allocated
            .filter((sub) => !global.Pike.rhythms.isSubtaskDone(r, sub.id, date))
            .forEach((sub) => {
              items.push({ id: r.id, _subtaskId: sub.id, title: sub.title, schedule: null, _isSubtask: true });
            });
        }
      } else {
        if (!global.Pike.rhythms.isRhythmDoneThisPeriod(r, date)) {
          items.push(r);
        }
      }
    });

    return items.sort((a, b) => (a.schedule?.time || '').localeCompare(b.schedule?.time || ''));
  }

  function render() {
    const gridEl  = document.getElementById('week-grid');
    const rangeEl = document.getElementById('week-range');
    const prevBtn = document.getElementById('week-prev');
    const nextBtn = document.getElementById('week-next');
    if (!gridEl) return;

    if (prevBtn && !prevBtn._wired) {
      prevBtn.addEventListener('click', () => { weekOffset--; render(); });
      prevBtn._wired = true;
    }
    if (nextBtn && !nextBtn._wired) {
      nextBtn.addEventListener('click', () => { weekOffset++; render(); });
      nextBtn._wired = true;
    }

    const dates = getWeekDates(weekOffset);
    currentWeekDates = dates;
    const data  = global.Pike.state.data;
    const today = dateKey(new Date());

    if (rangeEl) {
      const s = dates[0], e = dates[6];
      rangeEl.textContent = s.getMonth() === e.getMonth()
        ? `${MONTH_SHORT[s.getMonth()]} ${s.getDate()}–${e.getDate()}`
        : `${MONTH_SHORT[s.getMonth()]} ${s.getDate()} – ${MONTH_SHORT[e.getMonth()]} ${e.getDate()}`;
    }

    // Wire review button (once); always reads currentWeekDates so nav updates work
    const reviewBtn = document.getElementById('week-review-btn');
    if (reviewBtn && !reviewBtn._wired) {
      reviewBtn.addEventListener('click', () => toggleWeekReview(currentWeekDates));
      reviewBtn._wired = true;
    }

    gridEl.innerHTML = dates.map((date) => {
      const key     = dateKey(date);
      const isToday = key === today;
      const isPast  = key < today;

      const events  = (data.events || [])
        .filter((e) => e.date === key)
        .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
      const tasks   = (data.tasks || [])
        .filter((t) => t.scheduledDate === key && t.scheduledStart && !t.completedAt)
        .sort((a, b) => (a.scheduledStart || '').localeCompare(b.scheduledStart || ''));
      const rhythms = rhythmsForDay(date, data.rhythms);
      const gcalTimed  = (data.calendarEvents || [])
        .filter((e) => e.date === key && !e.isAllDay && e.start)
        .sort((a, b) => (a.start || '').localeCompare(b.start || ''));
      const gcalAllDay = (data.calendarEvents || [])
        .filter((e) => e.date === key && e.isAllDay);

      let itemsHTML = '';

      for (const ev of gcalAllDay) {
        const src = `<span class="week-gcal-src">${ev.source === 'work' ? 'Work' : 'Personal'}</span>`;
        itemsHTML += `<div class="week-item is-gcal is-allday" data-source="${esc(ev.source || '')}"><span class="week-item-title">${esc(ev.title)}</span>${src}</div>`;
      }
      for (const ev of events) {
        const time = ev.start ? `<span class="week-item-time">${esc(fmtTime(ev.start))}</span>` : '';
        itemsHTML += `<div class="week-item is-event" data-event-id="${esc(ev.id)}">${time}<span class="week-item-title">${esc(ev.title)}</span></div>`;
      }
      for (const ev of gcalTimed) {
        const time = ev.start ? `<span class="week-item-time">${esc(fmtTime(ev.start))}</span>` : '';
        const src  = `<span class="week-gcal-src">${ev.source === 'work' ? 'Work' : 'Personal'}</span>`;
        itemsHTML += `<div class="week-item is-gcal" data-source="${esc(ev.source || '')}">${time}<span class="week-item-title">${esc(ev.title)}</span>${src}</div>`;
      }
      for (const t of tasks) {
        const time = t.scheduledStart ? `<span class="week-item-time">${esc(fmtTime(t.scheduledStart))}</span>` : '';
        itemsHTML += `<div class="week-item is-task">${time}<span class="week-item-title">${esc(t.title)}</span></div>`;
      }
      for (const r of rhythms) {
        if (r._isUnplanned) {
          itemsHTML += `<div class="week-item is-rhythm is-rhythm-unplanned" data-rhythm-id="${esc(r.id)}" data-date="${esc(key)}"><span class="week-item-title">${esc(r.title)} — tap to plan</span></div>`;
        } else if (r._isSubtask) {
          itemsHTML += `<div class="week-item is-rhythm is-subtask" data-rhythm-id="${esc(r.id)}" data-subtask-id="${esc(r._subtaskId)}" data-date="${esc(key)}"><span class="week-item-title">${esc(r.title)}</span><button class="week-rhythm-done-btn" type="button" aria-label="Mark done">✓</button></div>`;
        } else {
          const time = r.schedule?.time ? `<span class="week-item-time">${esc(fmtTime(r.schedule.time))}</span>` : '';
          itemsHTML += `<div class="week-item is-rhythm" data-rhythm-id="${esc(r.id)}" data-date="${esc(key)}">${time}<span class="week-item-title">${esc(r.title)}</span><button class="week-rhythm-done-btn" type="button" aria-label="Mark done">✓</button></div>`;
        }
      }

      // Trip departure marker
      const trips = (data.trips || []).filter((t) => t.departureDate === key);
      for (const t of trips) {
        itemsHTML += `<div class="week-item is-trip"><span class="week-item-title">✈ ${esc(t.name)}</span></div>`;
      }

      if (!itemsHTML) {
        itemsHTML = `<p class="week-day-empty">Open</p>`;
      }

      return `
        <div class="week-day${isToday ? ' is-today' : ''}${isPast ? ' is-past' : ''}">
          <div class="week-day-header">
            <div class="week-day-label-group">
              <span class="week-day-name">${DAY_SHORT[date.getDay()]}</span>
              <span class="week-day-date">${MONTH_SHORT[date.getMonth()]} ${date.getDate()}</span>
            </div>
            <button class="btn btn-ghost btn-sm week-add-btn" data-date="${key}" type="button">+ Event</button>
          </div>
          <div class="week-day-body">${itemsHTML}</div>
        </div>`;
    }).join('');

    // Wire event clicks (edit) and add buttons
    gridEl.querySelectorAll('.week-item.is-event').forEach((el) => {
      el.addEventListener('click', () => {
        const ev = (data.events || []).find((e) => e.id === el.dataset.eventId);
        if (ev && global.Pike.today) global.Pike.today.openEventModal(ev);
      });
      el.style.cursor = 'pointer';
    });

    gridEl.querySelectorAll('.week-rhythm-done-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const item      = btn.closest('.week-item.is-rhythm');
        const rId       = item?.dataset.rhythmId;
        const subtaskId = item?.dataset.subtaskId;
        const dKey      = item?.dataset.date;
        if (!rId || !dKey) return;
        const [y, m, d] = dKey.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d);
        if (subtaskId) {
          global.Pike.rhythms.markSubtaskDone(rId, subtaskId, dateObj);
        } else {
          global.Pike.rhythms.markRhythmDone(rId, dateObj);
        }
      });
    });

    gridEl.querySelectorAll('.week-item.is-rhythm-unplanned').forEach((el) => {
      el.style.cursor = 'pointer';
      el.addEventListener('click', () => {
        const rId = el.dataset.rhythmId;
        const r = (global.Pike.state.data.rhythms || []).find((x) => x.id === rId);
        if (r) global.Pike.rhythms.openPlanWeekendModal(r);
      });
    });

    gridEl.querySelectorAll('.week-add-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (global.Pike.today) global.Pike.today.openEventModal(null, btn.dataset.date);
      });
    });
  }

  function generateWeeklyReview(weekDates) {
    const data = global.Pike.state.data;
    const startKey = dateKey(weekDates[0]);
    const endKey   = dateKey(weekDates[6]);
    const isoWeek  = global.Pike.rhythms ? global.Pike.rhythms.getISOWeekKey(weekDates[0]) : null;
    const lines = [];

    // ── Helpers ────────────────────────────────────────────────────────────
    function firstName(p) { return p.name ? p.name.split(' ')[0] : p; }
    function andList(arr) {
      if (!arr.length) return '';
      if (arr.length === 1) return arr[0];
      if (arr.length === 2) return arr[0] + ' and ' + arr[1];
      return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
    }
    function humanWorkout(type) {
      const map = {
        'lower-body': 'lower body', 'upper-push': 'push day', 'upper-pull': 'pull day',
        'lower body': 'lower body', 'push': 'push day', 'pull': 'pull day',
        'full-body': 'full body', 'cardio': 'cardio',
      };
      return map[String(type).toLowerCase()] || type;
    }
    const nums = ['once','twice','three times','four times','five times','six times','seven times'];
    function timesWord(n) { return nums[n - 1] || `${n} times`; }

    // ── 1. Workouts ────────────────────────────────────────────────────────
    const workouts = (data.workoutSequence?.history || [])
      .filter((h) => { const d = h.completedAt?.slice(0, 10); return d && d >= startKey && d <= endKey; });
    if (workouts.length === 1) {
      lines.push(`You got your workout in — ${humanWorkout(workouts[0].type)}.`);
    } else if (workouts.length > 1 && workouts.length <= 4) {
      const types = workouts.map((w) => humanWorkout(w.type));
      lines.push(`You trained ${timesWord(workouts.length)} — ${andList(types)}.`);
    } else if (workouts.length > 4) {
      lines.push(`You trained ${workouts.length} times this week.`);
    }

    // ── 2. People / sponsees ───────────────────────────────────────────────
    const contacted = (data.people || []).filter((p) =>
      (p.contactLog || []).some((e) => e.date >= startKey && e.date <= endKey)
    );
    if (contacted.length) {
      const sponsees = contacted.filter((p) => p.relationship === 'sponsee');
      const others   = contacted.filter((p) => p.relationship !== 'sponsee');
      if (sponsees.length && !others.length) {
        const label = sponsees.length === 1 ? 'your sponsee' : `your ${sponsees.length} sponsees`;
        lines.push(`You connected with ${label} — ${andList(sponsees.map(firstName))}.`);
      } else if (sponsees.length && others.length) {
        lines.push(`You stayed close to your people this week — ${andList(contacted.map(firstName))}.`);
      } else if (others.length === 1) {
        lines.push(`You stayed in touch with ${firstName(others[0])} this week.`);
      } else {
        lines.push(`You connected with ${andList(others.map(firstName))} this week.`);
      }
    }

    // ── 3. Weekend rhythm subtask completions ─────────────────────────────
    if (isoWeek) {
      const completions = data.rhythmCompletions || {};
      const weekendRhythms = (data.rhythms || []).filter(
        (r) => r.active && r.schedule?.type === 'weekends' && r.subtasks?.length
      );
      const doneSubtaskTitles = [];
      weekendRhythms.forEach((r) => {
        (r.subtasks || []).forEach((sub) => {
          if (completions[r.id + '::' + sub.id + '::' + isoWeek]) {
            doneSubtaskTitles.push(sub.title);
          }
        });
      });
      if (doneSubtaskTitles.length === 1) {
        lines.push(`You got ${doneSubtaskTitles[0]} done — weekend reset started.`);
      } else if (doneSubtaskTitles.length <= 5) {
        lines.push(`Weekend reset done — ${andList(doneSubtaskTitles)} all checked off.`);
      } else if (doneSubtaskTitles.length > 5) {
        lines.push(`You knocked out ${doneSubtaskTitles.length} weekend reset items.`);
      }
    }

    // ── 4. Daily anchor completions ────────────────────────────────────────
    const dailyLibIds = new Set(
      (data.tasks || []).filter((t) => t.isLibrary && t.isDefaultDaily).map((t) => t.id)
    );
    const anchorsDone = (data.tasks || []).filter((t) => {
      const d = t.completedAt?.slice(0, 10);
      return d && d >= startKey && d <= endKey && t.librarySourceId && dailyLibIds.has(t.librarySourceId);
    });
    if (anchorsDone.length) {
      const uniqueTitles = [...new Set(anchorsDone.map((t) => t.title))];
      if (uniqueTitles.length === 1) {
        lines.push(`${uniqueTitles[0]} was your steady anchor this week.`);
      } else if (uniqueTitles.length <= 4) {
        lines.push(`${andList(uniqueTitles)} were your anchors this week.`);
      } else {
        lines.push(`Your daily anchors held — ${uniqueTitles.length} habits showed up this week.`);
      }
    }

    // ── 5. Other weekly routines (atomic rhythms, non-weekend) ────────────
    if (isoWeek) {
      const completions = data.rhythmCompletions || {};
      const routinesDone = (data.rhythms || []).filter((r) =>
        r.active && !r.subtasks?.length &&
        r.schedule?.type !== 'weekends' &&
        completions[r.id + '::' + isoWeek] === true
      );
      if (routinesDone.length === 1) {
        lines.push(`You kept up with ${routinesDone[0].title} this week.`);
      } else if (routinesDone.length <= 3) {
        lines.push(`You kept up with ${andList(routinesDone.map((r) => r.title))}.`);
      } else {
        lines.push(`You kept ${routinesDone.length} regular routines going this week.`);
      }
    }

    // ── 6. Trip prep ───────────────────────────────────────────────────────
    (data.trips || []).forEach((trip) => {
      const c3 = Object.values(trip.checklist3Day  || {}).filter(Boolean).length;
      const cn = Object.values(trip.checklistNight || {}).filter(Boolean).length;
      const total = c3 + cn;
      if (total > 0) {
        lines.push(`${trip.name} prep is moving — ${total} item${total > 1 ? 's' : ''} checked off.`);
      }
    });

    return lines;
  }

  function toggleWeekReview(dates) {
    const reviewEl = document.getElementById('week-review');
    if (!reviewEl) return;

    if (!reviewEl.hidden) {
      reviewEl.hidden = true;
      return;
    }

    const lines = generateWeeklyReview(dates);
    if (!lines.length) {
      reviewEl.innerHTML = `
        <div class="week-review-title">This Week in Review</div>
        <p class="week-review-empty">Nothing tracked yet this week — check back after you've logged some activity.</p>`;
    } else {
      reviewEl.innerHTML = `
        <div class="week-review-title">This Week in Review</div>
        <div class="week-review-lines">
          ${lines.map((l) => `<div class="week-review-line">${esc(l)}</div>`).join('')}
        </div>`;
    }
    reviewEl.hidden = false;
  }

  function init() {}

  global.Pike = global.Pike || {};
  global.Pike.week = { init, render };
})(window);
