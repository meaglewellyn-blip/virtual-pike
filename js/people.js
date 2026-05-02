/* Virtual Pike — People module
 * Sponsees (step tracking, 7-day cadence), Family & Friends (birthdays,
 * sobriety dates, 30-day cadence). Birthday/sobriety reminders surface on Today.
 */

(function (global) {
  'use strict';

  const DEFAULT_PEOPLE = [
    // Sponsees — 7-day cadence
    { id: 'per-alexis',  name: 'Alexis',   category: 'sponsee', cadenceDays: 7,  lastContactAt: null, stepWork: { currentStep: null, notes: '' }, birthday: null, sobrietyDate: null, contactLog: [] },
    { id: 'per-madison', name: 'Madison',  category: 'sponsee', cadenceDays: 7,  lastContactAt: null, stepWork: { currentStep: null, notes: '' }, birthday: null, sobrietyDate: null, contactLog: [] },
    { id: 'per-mary',    name: 'Mary',     category: 'sponsee', cadenceDays: 7,  lastContactAt: null, stepWork: { currentStep: null, notes: '' }, birthday: null, sobrietyDate: null, contactLog: [] },
    // Family — biannual cadence
    { id: 'per-brother', name: 'Brother', category: 'family', cadenceDays: 180, lastContactAt: null, stepWork: null, birthday: '06-26', sobrietyDate: null, contactLog: [] },
    { id: 'per-dad',     name: 'Dad',     category: 'family', cadenceDays: 180, lastContactAt: null, stepWork: null, birthday: '02-14', sobrietyDate: null, contactLog: [] },
    { id: 'per-pam',     name: 'Pam',     category: 'family', cadenceDays: 180, lastContactAt: null, stepWork: null, birthday: '11-03', sobrietyDate: null, contactLog: [] },
    // Friends — no cadence tracking, just birthday/sobriety dates
    { id: 'per-lindsey', name: 'Lindsey',  category: 'friend',  cadenceDays: null, lastContactAt: null, stepWork: null, birthday: '01-17', sobrietyDate: '2007-04-23', contactLog: [] },
    { id: 'per-jaime',   name: 'Jaime',    category: 'friend',  cadenceDays: null, lastContactAt: null, stepWork: null, birthday: '05-30', sobrietyDate: '2011-05-16', contactLog: [] },
    { id: 'per-molly',   name: 'Molly',    category: 'friend',  cadenceDays: null, lastContactAt: null, stepWork: null, birthday: '09-03', sobrietyDate: '2016-01-13', contactLog: [] },
    { id: 'per-morgan',  name: 'Morgan',   category: 'friend',  cadenceDays: null, lastContactAt: null, stepWork: null, birthday: '09-07', sobrietyDate: '2016-05-05', contactLog: [] },
    { id: 'per-chelsea', name: 'Chelsea',  category: 'friend',  cadenceDays: null, lastContactAt: null, stepWork: null, birthday: '04-05', sobrietyDate: '2012-12-01', contactLog: [] },
    { id: 'per-rush',    name: 'Rush',     category: 'friend',  cadenceDays: null, lastContactAt: null, stepWork: null, birthday: '03-31', sobrietyDate: '2008-09-08', contactLog: [] },
    { id: 'per-sam',     name: 'Sam',      category: 'friend',  cadenceDays: null, lastContactAt: null, stepWork: null, birthday: '09-02', sobrietyDate: '2016-09-05', contactLog: [] },
    { id: 'per-carl',    name: 'Carl',     category: 'friend',  cadenceDays: null, lastContactAt: null, stepWork: null, birthday: '12-17', sobrietyDate: '2006-05-19', contactLog: [] },
    { id: 'per-ashley',  name: 'Ashley',   category: 'friend',  cadenceDays: null, lastContactAt: null, stepWork: null, birthday: '08-10', sobrietyDate: '2019-09-29', contactLog: [] },
    { id: 'per-grace',   name: 'Grace',    category: 'friend',  cadenceDays: null, lastContactAt: null, stepWork: null, birthday: '05-04', sobrietyDate: '2015-07-31', contactLog: [] },
    { id: 'per-rachel',  name: 'Rachel',   category: 'friend',  cadenceDays: null, lastContactAt: null, stepWork: null, birthday: '10-26', sobrietyDate: null,          contactLog: [] },
  ];

  const CATEGORY_LABELS = { sponsee: 'Sponsees', family: 'Family', friend: 'Friends' };
  const CATEGORY_ORDER  = ['sponsee', 'family', 'friend'];

  function uid(p) { return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`; }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function pad2(n) { return String(n).padStart(2,'0'); }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  }

  // ── Pulse ────────────────────────────────────────────────────────────────────

  function daysSince(isoDate) {
    if (!isoDate) return null;
    return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
  }

  function pulseStatus(person) {
    if (!person.cadenceDays) return 'none';
    const d = daysSince(person.lastContactAt);
    if (d === null) return 'never';
    if (d <= person.cadenceDays)        return 'ok';
    if (d <= person.cadenceDays * 1.75) return 'warn';
    return 'overdue';
  }

  function pulseLabel(person) {
    const d = daysSince(person.lastContactAt);
    if (d === null) return 'Never connected';
    if (d === 0)    return 'Today';
    if (d === 1)    return 'Yesterday';
    return `${d} days ago`;
  }

  // ── Dates ────────────────────────────────────────────────────────────────────

  function yearsSober(yyyymmdd) {
    if (!yyyymmdd) return null;
    const start = new Date(yyyymmdd + 'T00:00:00');
    const now   = new Date();
    const anniv = new Date(now.getFullYear(), start.getMonth(), start.getDate());
    return now.getFullYear() - start.getFullYear() - (anniv > now ? 1 : 0);
  }

  function getUpcomingEvents(people) {
    const today  = new Date(); today.setHours(0,0,0,0);
    const cutoff = new Date(today.getTime() + 14 * 86400000);
    const events = [];

    for (const p of people) {
      if (p.birthday) {
        const [bm, bd] = p.birthday.split('-').map(Number);
        let next = new Date(today.getFullYear(), bm-1, bd);
        if (next < today) next = new Date(today.getFullYear()+1, bm-1, bd);
        if (next <= cutoff) {
          events.push({ type: 'birthday', person: p, date: next, daysAway: Math.round((next - today)/86400000) });
        }
      }
      if (p.sobrietyDate) {
        const [sy, sm, sd] = p.sobrietyDate.split('-').map(Number);
        let next = new Date(today.getFullYear(), sm-1, sd);
        if (next < today) next = new Date(today.getFullYear()+1, sm-1, sd);
        const years = next.getFullYear() - sy;
        if (next <= cutoff) {
          events.push({ type: 'sobriety', person: p, date: next, daysAway: Math.round((next - today)/86400000), years });
        }
      }
    }
    return events.sort((a,b) => a.daysAway - b.daysAway);
  }

  // ── State mutations ──────────────────────────────────────────────────────────

  const BIRTHDAY_SEED = {
    'per-brother': '06-26', 'per-dad': '02-14', 'per-pam': '11-03',
    'per-lindsey': '01-17', 'per-jaime':  '05-30', 'per-molly':   '09-03',
    'per-morgan':  '09-07', 'per-chelsea':'04-05',  'per-rush':    '03-31',
    'per-sam':     '09-02', 'per-carl':   '12-17',  'per-ashley':  '08-10',
    'per-grace':   '05-04', 'per-rachel': '10-26',
  };

  const SOBRIETY_SEED = {
    'per-lindsey': '2007-04-23', 'per-jaime':  '2011-05-16', 'per-molly':  '2016-01-13',
    'per-chelsea': '2012-12-01', 'per-rush':   '2008-09-08', 'per-sam':    '2016-09-05',
    'per-carl':    '2006-05-19', 'per-ashley': '2019-09-29', 'per-morgan':  '2016-05-05',
    'per-grace':   '2015-07-31',
  };

  function init() {
    const data = global.Pike.state.data;
    if (!data.people || data.people.length === 0) {
      global.Pike.state.commit((d) => {
        d.people = DEFAULT_PEOPLE.map((p) => ({ ...p, contactLog: [] }));
      });
      return;
    }
    // Check what migrations are needed
    let needsMigration = false;
    for (const p of data.people) {
      if (p.category === 'family' && p.cadenceDays === 30) { needsMigration = true; break; }
      if (p.category === 'friend' && p.cadenceDays != null) { needsMigration = true; break; }
      if (BIRTHDAY_SEED[p.id] && !p.birthday) { needsMigration = true; break; }
      if (SOBRIETY_SEED[p.id] && !p.sobrietyDate) { needsMigration = true; break; }
    }
    const NEW_FRIENDS = [
      { id: 'per-carl',   name: 'Carl',   birthday: '12-17', sobrietyDate: '2006-05-19' },
      { id: 'per-ashley', name: 'Ashley', birthday: '08-10', sobrietyDate: '2019-09-29' },
    ];
    for (const nf of NEW_FRIENDS) {
      if (!data.people.find((p) => p.id === nf.id)) { needsMigration = true; break; }
    }
    // Dad/Pam split migration
    if (data.people.find((p) => p.id === 'per-dadpam')) needsMigration = true;
    if (!data.people.find((p) => p.id === 'per-pam')) needsMigration = true;
    // Grace/Rachel → friends
    for (const id of ['per-grace', 'per-rachel']) {
      const p = data.people.find((x) => x.id === id);
      if (p && p.category === 'sponsee') { needsMigration = true; break; }
    }

    if (needsMigration) {
      global.Pike.state.commit((d) => {
        for (const p of (d.people || [])) {
          if (p.category === 'family' && p.cadenceDays === 30) p.cadenceDays = 180;
          if (p.category === 'friend') p.cadenceDays = null;
          if (BIRTHDAY_SEED[p.id] && !p.birthday) p.birthday = BIRTHDAY_SEED[p.id];
          if (SOBRIETY_SEED[p.id] && !p.sobrietyDate) p.sobrietyDate = SOBRIETY_SEED[p.id];
        }
        for (const nf of NEW_FRIENDS) {
          if (!d.people.find((p) => p.id === nf.id)) {
            d.people.push({ id: nf.id, name: nf.name, category: 'friend', cadenceDays: null, lastContactAt: null, stepWork: null, birthday: nf.birthday, sobrietyDate: nf.sobrietyDate, contactLog: [] });
          }
        }
        // Grace/Rachel → move to friends
        for (const [id, bday, sob] of [['per-grace','05-04','2015-07-31'],['per-rachel','10-26',null]]) {
          const p = d.people.find((x) => x.id === id);
          if (p && p.category === 'sponsee') {
            p.category    = 'friend';
            p.cadenceDays = null;
            p.stepWork    = null;
            if (!p.birthday)     p.birthday     = bday;
            if (!p.sobrietyDate && sob) p.sobrietyDate = sob;
          }
        }
        // Migrate per-dadpam → per-dad (rename + new id), add Pam separately
        const dadpam = d.people.find((p) => p.id === 'per-dadpam');
        if (dadpam) {
          dadpam.id   = 'per-dad';
          dadpam.name = 'Dad';
          if (!dadpam.birthday) dadpam.birthday = '02-14';
        }
        if (!d.people.find((p) => p.id === 'per-pam')) {
          d.people.push({ id: 'per-pam', name: 'Pam', category: 'family', cadenceDays: 180, lastContactAt: null, stepWork: null, birthday: '11-03', sobrietyDate: null, contactLog: [] });
        }
      });
    }
  }

  function logContact(personId, type, note, date) {
    const chosenDate = date || todayKey();
    global.Pike.state.commit((d) => {
      const p = (d.people || []).find((x) => x.id === personId);
      if (!p) return;
      p.contactLog = p.contactLog || [];
      p.contactLog.unshift({ id: uid('log'), date: chosenDate, type, note: note || '' });
      // Only advance lastContactAt — never roll it back for older retroactive entries
      if (!p.lastContactAt || chosenDate >= p.lastContactAt) {
        p.lastContactAt = chosenDate;
      }
    });
  }

  function deleteContactLogEntry(personId, logId) {
    global.Pike.state.commit((d) => {
      const p = (d.people || []).find((x) => x.id === personId);
      if (!p) return;
      p.contactLog = (p.contactLog || []).filter((e) => e.id !== logId);
      // Recalculate lastContactAt from the remaining entries
      const remaining = (p.contactLog || []).filter((e) => e.date);
      p.lastContactAt = remaining.length
        ? remaining.reduce((max, e) => e.date > max ? e.date : max, remaining[0].date)
        : null;
    });
  }

  function savePerson(personId, updates) {
    global.Pike.state.commit((d) => {
      const p = (d.people || []).find((x) => x.id === personId);
      if (!p) return;
      Object.assign(p, updates);
    });
  }

  function addToToday(personId, contactType) {
    const people = global.Pike.state.data.people || [];
    const p = people.find((x) => x.id === personId);
    if (!p) return;
    global.Pike.state.commit((d) => {
      d.tasks = d.tasks || [];
      d.tasks.push({
        id: uid('tsk'),
        title: `${contactType === 'meeting' ? 'Meet' : 'Call'} ${p.name}`,
        estimateMinutes: contactType === 'meeting' ? 60 : 30,
        scheduledDate: todayKey(),
        scheduledStart: null,
        completedAt: null,
        recurrenceId: null,
        category: 'people',
      });
    });
  }

  // ── Add person modal ─────────────────────────────────────────────────────────

  function openAddPersonModal() {
    const form = document.createElement('form');
    form.id = 'add-person-form';
    form.innerHTML = `
      <label>
        <span>Name</span>
        <input type="text" class="input" name="name" required maxlength="60" autocomplete="off" placeholder="e.g. Jordan">
      </label>
      <label>
        <span>Category</span>
        <select class="input" name="category" id="add-person-cat">
          <option value="friend">Friend</option>
          <option value="family">Family</option>
          <option value="sponsee">Sponsee</option>
        </select>
      </label>
      <div id="add-person-dates">
        <label>
          <span>Birthday</span>
          <input type="text" class="input" name="birthday" maxlength="5" placeholder="MM-DD e.g. 08-10" autocomplete="off">
        </label>
        <label>
          <span>Sobriety date</span>
          <input type="text" class="input" name="sobrietyDate" placeholder="YYYY-MM-DD e.g. 2019-09-29" autocomplete="off">
        </label>
      </div>
      <div id="add-person-cadence" hidden>
        <label>
          <span>Check-in goal</span>
          <select class="input" name="cadenceDays">
            <option value="7">Every week</option>
            <option value="14">Every 2 weeks</option>
            <option value="21">Every 3 weeks</option>
            <option value="30">Every month</option>
          </select>
        </label>
      </div>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">Add person</button>
      </div>
    `;

    const catEl      = form.querySelector('#add-person-cat');
    const datesRow   = form.querySelector('#add-person-dates');
    const cadenceRow = form.querySelector('#add-person-cadence');

    catEl.addEventListener('change', () => {
      const cat = catEl.value;
      datesRow.hidden   = cat === 'sponsee';
      cadenceRow.hidden = cat !== 'sponsee';
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd       = new FormData(form);
      const name     = String(fd.get('name') || '').trim();
      if (!name) return;
      const cat      = String(fd.get('category'));
      const isSponsee = cat === 'sponsee';
      const cadence  = isSponsee ? (parseInt(fd.get('cadenceDays'), 10) || 7) : (cat === 'family' ? 180 : null);
      const birthday = isSponsee ? null : (String(fd.get('birthday') || '').trim() || null);
      const sobriety = isSponsee ? null : (String(fd.get('sobrietyDate') || '').trim() || null);

      global.Pike.state.commit((d) => {
        d.people = d.people || [];
        d.people.push({
          id: uid('per'),
          name,
          category: cat,
          cadenceDays: cadence,
          lastContactAt: null,
          stepWork: isSponsee ? { currentStep: null, notes: '' } : null,
          birthday,
          sobrietyDate: sobriety,
          contactLog: [],
        });
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: 'Add person', body: form });
  }

  // ── Person modal ─────────────────────────────────────────────────────────────

  function openPersonModal(personId) {
    const people = global.Pike.state.data.people || [];
    const person = people.find((p) => p.id === personId);
    if (!person) return;

    const isSponsee = person.category === 'sponsee';
    const isFriend  = person.category === 'friend';
    const ys = yearsSober(person.sobrietyDate);

    const stepOptions = Array.from({length: 12}, (_,i) => i+1)
      .map((n) => `<option value="${n}" ${person.stepWork?.currentStep === n ? 'selected':''}>${n}</option>`)
      .join('');

    const form = document.createElement('form');
    form.className = 'person-modal-form';
    form.innerHTML = `
      ${person.cadenceDays ? `
      <div class="person-modal-pulse">
        <span class="person-pulse-dot is-${pulseStatus(person)}"></span>
        <span class="person-pulse-label">${esc(pulseLabel(person))}</span>
        <span class="person-pulse-cadence">· goal every ${person.cadenceDays}d</span>
      </div>` : ''}

      ${isSponsee ? `
      <div class="person-modal-section">
        <div class="person-modal-section-title">Step work</div>
        <div class="person-stepwork-row">
          <label style="flex:0 0 140px">
            <span>Current step</span>
            <select class="input" name="currentStep">
              <option value="">—</option>
              ${stepOptions}
            </select>
          </label>
          <label style="flex:1">
            <span>Notes</span>
            <input type="text" class="input" name="stepNotes" maxlength="300"
              placeholder="e.g. Starting resentment list…"
              value="${esc(person.stepWork?.notes || '')}">
          </label>
        </div>
        <div style="margin-top: var(--space-3)">
          <label style="display:inline-flex; flex-direction:column; gap:var(--space-1)">
            <span style="font-size:var(--fs-xs); color:var(--text-faint); font-weight:var(--fw-medium); text-transform:uppercase; letter-spacing:0.08em">Check-in goal</span>
            <div style="display:flex; align-items:center; gap:var(--space-2)">
              <input type="number" class="input" name="cadenceDays" min="1" max="365"
                value="${person.cadenceDays || 7}" style="width:80px; text-align:center">
              <span style="font-size:var(--fs-sm); color:var(--text-muted)">days</span>
            </div>
          </label>
        </div>
      </div>
      ` : `
      <div class="person-modal-section">
        <div class="person-modal-section-title">Dates <span class="muted">(for 2-week reminders)</span></div>
        <div class="person-dates-row">
          <label>
            <span>Birthday</span>
            <input type="text" class="input" name="birthday" maxlength="5"
              placeholder="MM-DD e.g. 03-15" value="${esc(person.birthday || '')}">
          </label>
          <label>
            <span>Sobriety date</span>
            <input type="text" class="input" name="sobrietyDate"
              placeholder="YYYY-MM-DD e.g. 2019-06-01" value="${esc(person.sobrietyDate || '')}">
          </label>
        </div>
        ${ys !== null ? `<div class="person-sober-years">${ys} year${ys !== 1 ? 's':''}  sober 🌿</div>` : ''}
      </div>
      `}

      <div class="person-modal-section">
        <div class="person-modal-section-title">Log contact</div>
        <div class="person-log-row">
          <select class="input" name="contactType" style="flex:0 0 110px">
            <option value="call">Call</option>
            <option value="meeting">Meeting</option>
            <option value="text">Text</option>
            <option value="check-in">Check-in</option>
          </select>
          <input type="date" class="input" name="contactDate"
            value="${todayKey()}" style="flex:0 0 140px">
        </div>
        <div class="person-log-row" style="margin-top:var(--space-2)">
          <input type="text" class="input" name="contactNote"
            placeholder="Quick note (optional)" maxlength="200" style="flex:1">
          <button type="button" class="btn btn-primary btn-sm" id="ppl-log-btn">Log</button>
        </div>
      </div>

      <div class="person-modal-section">
        <div class="person-modal-section-title">Add to today</div>
        <div class="person-addtask-row">
          <button type="button" class="btn btn-ghost btn-sm" id="ppl-add-call">+ Call today</button>
          <button type="button" class="btn btn-ghost btn-sm" id="ppl-add-meeting">+ Meeting today</button>
        </div>
      </div>

      <div class="person-modal-section">
        <div class="person-modal-section-title">Contact history</div>
        <div class="person-log-history" id="person-log-hist"></div>
      </div>

      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Close</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>
    `;

    // ── Live-rendered contact history ────────────────────────────────────────
    function refreshLog() {
      const histEl = form.querySelector('#person-log-hist');
      if (!histEl) return;
      const p = (global.Pike.state.data.people || []).find((x) => x.id === personId);
      const log = ((p?.contactLog) || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));

      if (!log.length) {
        histEl.innerHTML = `<p class="person-log-empty">No contact logged yet.</p>`;
        return;
      }

      histEl.innerHTML = log.map((e) => `
        <div class="person-log-entry">
          <span class="person-log-date">${esc(e.date)}</span>
          <span class="person-log-type">${esc(e.type)}</span>
          ${e.note ? `<span class="person-log-note">${esc(e.note)}</span>` : ''}
          <button class="person-log-delete-btn" data-log-id="${esc(e.id)}"
            type="button" aria-label="Delete this entry">×</button>
        </div>`).join('');

      histEl.querySelectorAll('.person-log-delete-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.classList.contains('is-confirming')) {
            deleteContactLogEntry(personId, btn.dataset.logId);
            refreshLog();
          } else {
            btn.classList.add('is-confirming');
            btn.textContent = 'Remove?';
            setTimeout(() => {
              if (btn.classList.contains('is-confirming')) {
                btn.classList.remove('is-confirming');
                btn.textContent = '×';
              }
            }, 3000);
          }
        });
      });
    }

    refreshLog();

    form.querySelector('#ppl-log-btn').addEventListener('click', () => {
      const type = form.querySelector('[name="contactType"]').value;
      const note = form.querySelector('[name="contactNote"]').value.trim();
      const date = form.querySelector('[name="contactDate"]').value || todayKey();
      logContact(personId, type, note, date);
      global.Pike.modal.close();
    });

    form.querySelector('#ppl-add-call').addEventListener('click', () => {
      addToToday(personId, 'call');
      global.Pike.modal.close();
    });

    form.querySelector('#ppl-add-meeting').addEventListener('click', () => {
      addToToday(personId, 'meeting');
      global.Pike.modal.close();
    });

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      if (isSponsee) {
        const step    = parseInt(fd.get('currentStep'), 10);
        const cadence = parseInt(fd.get('cadenceDays'), 10);
        savePerson(personId, {
          cadenceDays: isNaN(cadence) ? person.cadenceDays : cadence,
          stepWork: {
            currentStep: isNaN(step) ? null : step,
            notes: String(fd.get('stepNotes') || '').trim(),
          },
        });
      } else {
        savePerson(personId, {
          birthday:     String(fd.get('birthday')     || '').trim() || null,
          sobrietyDate: String(fd.get('sobrietyDate') || '').trim() || null,
        });
      }
      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: person.name, body: form });
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  function renderUpcomingEvents() {
    const el = document.getElementById('today-people-events');
    if (!el) return;
    const events = getUpcomingEvents(global.Pike.state.data.people || []);
    if (!events.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `
      <div class="ppl-events-eyebrow">Coming up</div>
      ${events.map((ev) => {
        const when = ev.daysAway === 0 ? 'today!' : ev.daysAway === 1 ? 'tomorrow' : `in ${ev.daysAway} days`;
        const label = ev.type === 'birthday'
          ? `🎂 <strong>${esc(ev.person.name)}</strong>'s birthday — ${when}`
          : `✨ <strong>${esc(ev.person.name)}</strong>'s sobriety anniversary (${ev.years} yr) — ${when}`;
        return `<div class="ppl-event-item">${label}</div>`;
      }).join('')}
    `;
  }

  function render() {
    renderUpcomingEvents();

    const addBtn = document.getElementById('people-add');
    if (addBtn && !addBtn._wired) {
      addBtn.addEventListener('click', openAddPersonModal);
      addBtn._wired = true;
    }

    const container = document.getElementById('people-list');
    if (!container) return;

    const people = global.Pike.state.data.people || [];
    const statusOrder = { overdue: 0, never: 1, warn: 2, ok: 3, none: 4 };
    const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    let html = '';
    for (const cat of CATEGORY_ORDER) {
      const group = people
        .filter((p) => p.category === cat)
        .sort((a, b) => {
          if (cat === 'friend') return a.name.localeCompare(b.name);
          return (statusOrder[pulseStatus(a)]||0) - (statusOrder[pulseStatus(b)]||0);
        });
      if (!group.length) continue;

      html += `
        <div class="people-group">
          <div class="people-group-label">${esc(CATEGORY_LABELS[cat])}</div>
          ${group.map((p) => {
            const isFriendCard = p.category === 'friend';
            const status = pulseStatus(p);
            const stepBadge = p.stepWork?.currentStep
              ? `<span class="person-badge">Step ${p.stepWork.currentStep}</span>` : '';
            const soberBadge = (!p.stepWork && p.sobrietyDate)
              ? (() => { const y = yearsSober(p.sobrietyDate); return y !== null ? `<span class="person-badge is-sober">${y}yr</span>` : ''; })()
              : '';

            let cardMeta = '';
            if (isFriendCard) {
              const parts = [];
              if (p.birthday) {
                const [bm, bd] = p.birthday.split('-').map(Number);
                parts.push(`🎂 ${MONTH_SHORT[bm-1]} ${bd}`);
              }
              const ys = yearsSober(p.sobrietyDate);
              if (ys !== null) parts.push(`${ys}yr sober`);
              cardMeta = parts.join(' · ');
            } else {
              cardMeta = esc(pulseLabel(p));
            }

            return `
              <button class="person-card" data-id="${esc(p.id)}" type="button">
                ${!isFriendCard ? `<span class="person-pulse-dot is-${esc(status)}"></span>` : ''}
                <div class="person-card-info">
                  <div class="person-card-name">${esc(p.name)} ${stepBadge}${soberBadge}</div>
                  ${cardMeta ? `<div class="person-card-meta">${cardMeta}</div>` : ''}
                </div>
                <span class="person-card-chevron">›</span>
              </button>`;
          }).join('')}
        </div>`;
    }

    container.innerHTML = html;
    container.querySelectorAll('.person-card').forEach((btn) => {
      btn.addEventListener('click', () => openPersonModal(btn.dataset.id));
    });
  }

  global.Pike = global.Pike || {};
  global.Pike.people = { init, render, renderUpcomingEvents };
})(window);
