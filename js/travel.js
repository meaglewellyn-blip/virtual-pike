/* Virtual Pike — Travel module
 * Trips dashboard, trip detail (quantities, supplements, checklists, packing),
 * and trip prep surface in Today/Week views.
 *
 * ── Trip checklist persistence invariant ─────────────────────────────────
 * Trip prep and packing checks are TRIP-LEVEL state, not daily state.
 * For each trip:
 *   - checklist3Day, checklistNight, packedItems persist once checked.
 *   - None of these reset daily. They live on the trip object until the user
 *     unchecks them, edits trip data, or deletes the trip.
 *   - They survive Today/Travel renders, reloads, close/reopen, and sync.
 *
 * Rules enforced by this module:
 *   1. NEVER key trip checklist state by todayKey() or any date.
 *      Keys are itemId only; container is the trip object.
 *   2. NEVER mutate trip.checklist3Day, trip.checklistNight, or trip.packedItems
 *      from a render path. The ONLY allowed write paths are the change handlers
 *      on `.pack-checkbox`, `.pretripcheck`, and `.trip-prep-cb` inputs.
 *   3. NEVER reinitialize travelTemplates or trip checklist state when existing
 *      data is present. init() is gated by `!data.trips` / `!data.travelTemplates`
 *      and the inner mutator double-checks before assigning.
 *
 * If you add a new render path or migration, audit it against these three rules.
 */

(function (global) {
  'use strict';

  // ── Default templates (seeded once from spreadsheet) ────────────────────────

  const DEFAULT_TEMPLATES = {
    supplements: [
      { id: 'supp-saffron',   name: 'Saffron',          session: 'AM', multiplier: 1, basis: 'days',   optional: false },
      { id: 'supp-b12',       name: 'B12',               session: 'AM', multiplier: 1, basis: 'days',   optional: false },
      { id: 'supp-d3',        name: 'D3',                session: 'AM', multiplier: 1, basis: 'days',   optional: false },
      { id: 'supp-floradix',  name: 'Floradix',          session: 'AM', multiplier: 1, basis: 'days',   optional: false },
      { id: 'supp-melatonin', name: 'Melatonin',         session: 'PM', multiplier: 3, basis: 'nights', optional: false },
      { id: 'supp-magnesium', name: 'Magnesium',         session: 'PM', multiplier: 1, basis: 'nights', optional: false },
      { id: 'supp-glutamine', name: 'L-Glutamine',       session: 'PM', multiplier: 1, basis: 'nights', optional: false },
      { id: 'supp-fishoil',   name: 'Fish oil',          session: 'PM', multiplier: 1, basis: 'nights', optional: false },
      { id: 'supp-ltheanine', name: 'L-theanine gummies',session: 'PM', multiplier: 1, basis: 'nights', optional: true  },
    ],
    packing: {
      skincare: [
        { id: 'sk-am-moist',    name: 'AM moisturizer' },
        { id: 'sk-face-spf',    name: 'Face SPF' },
        { id: 'sk-micellar',    name: 'Micellar water' },
        { id: 'sk-eye-cream',   name: 'Eye cream' },
        { id: 'sk-face-wash',   name: 'Face wash' },
        { id: 'sk-differin',    name: 'Differin' },
        { id: 'sk-pm-moist',    name: 'PM moisturizer' },
        { id: 'sk-body-wash',   name: 'Body wash' },
        { id: 'sk-razor',       name: 'Razor' },
        { id: 'sk-loofa',       name: 'Loofa' },
        { id: 'sk-toothpaste',  name: 'Toothpaste' },
        { id: 'sk-toothbrush',  name: 'Toothbrush' },
        { id: 'sk-eye-drops',   name: 'Eye drops' },
        { id: 'sk-contact-sol', name: 'Contact solution' },
        { id: 'sk-contacts',    name: 'Extra contacts' },
      ],
      haircare: [
        { id: 'hc-detangler',  name: 'Detangler brush' },
        { id: 'hc-dry-shamp',  name: 'Dry shampoo' },
        { id: 'hc-hair-oil',   name: 'Hair oil' },
        { id: 'hc-hair-cream', name: 'Hair cream' },
        { id: 'hc-hairspray',  name: 'Hairspray' },
        { id: 'hc-tools',      name: 'Styling tools' },
      ],
      makeup: [
        { id: 'mk-tint-moist',  name: 'Tint moisturizer' },
        { id: 'mk-set-powder',  name: 'Setting powder' },
        { id: 'mk-blush',       name: 'Blush' },
        { id: 'mk-mascara',     name: 'Mascara' },
        { id: 'mk-eye-con',     name: 'Eye concealer' },
        { id: 'mk-std-con',     name: 'Standard concealer' },
        { id: 'mk-found-brush', name: 'Foundation brush' },
        { id: 'mk-pow-brush',   name: 'Setting powder brush' },
        { id: 'mk-pow-puff',    name: 'Setting powder puff' },
        { id: 'mk-sponge',      name: 'Makeup sponge' },
        { id: 'mk-con-brush',   name: 'Concealer brush' },
        { id: 'mk-lip-balm',    name: 'Lip balm' },
      ],
      makeup_optional: [
        { id: 'mk-opt-found',       name: 'Foundation',   optional: true },
        { id: 'mk-opt-lipliner',    name: 'Lip liner',    optional: true },
        { id: 'mk-opt-eyesh',       name: 'Eye shadows',  optional: true },
        { id: 'mk-opt-eyeliner',    name: 'Eye liner',    optional: true },
        { id: 'mk-opt-highlighter', name: 'Highlighter',  optional: true },
      ],
      misc: [
        { id: 'misc-laptop-ch', name: 'Laptop charger' },
        { id: 'misc-phone-ch',  name: 'Phone charger' },
        { id: 'misc-tablet',    name: 'Tablet' },
        { id: 'misc-earbuds',   name: 'Ear buds' },
        { id: 'misc-vape-juice',name: 'Vape juice' },
        { id: 'misc-vape-pods', name: 'Vape pods' },
        { id: 'misc-zyns',      name: 'Zyns' },
      ],
    },
    preTripChecklists: {
      threeDays: [
        { id: '3d-dog-sitter',      text: 'Prep for dog sitter' },
        { id: '3d-clean-towels',    text: 'Clean towels' },
        { id: '3d-clean-bathtub',   text: 'Clean bathtub' },
        { id: '3d-vacuum',          text: 'Vacuum' },
        { id: '3d-tidy',            text: 'Tidy up as needed' },
        { id: '3d-confirm-arrival', text: 'Confirm arrival time' },
      ],
      nightBefore: [
        { id: 'nb-outfit',  text: 'Layout travel day outfit' },
        { id: 'nb-sheets',  text: 'Change sheets' },
        { id: 'nb-battery', text: 'Charge battery pack' },
        { id: 'nb-checkin', text: 'Check in for flight (if applicable)' },
        { id: 'nb-uber',    text: 'Book Uber to airport' },
        { id: 'nb-trash',   text: 'Take out trash' },
      ],
    },
  };

  const CATEGORY_LABELS = {
    skincare:       'Skin care / hygiene',
    haircare:       'Hair care',
    makeup:         'Makeup',
    makeup_optional:'Makeup (optional)',
    misc:           'Miscellaneous',
  };

  // ── Module state ─────────────────────────────────────────────────────────────

  let activeTripId = null;

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function uid(p) { return `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`; }
  function todayKey() { return dateKey(new Date()); }

  function tripStatus(trip) {
    const today = todayKey();
    if (!trip.departureDate) return 'upcoming';
    if (trip.departureDate > today) return 'upcoming';
    if (trip.returnDate && trip.returnDate >= today) return 'active';
    return 'past';
  }

  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const today = new Date(); today.setHours(0,0,0,0);
    const target = new Date(dateStr + 'T00:00:00');
    return Math.round((target - today) / 86400000);
  }

  function fmtDateRange(dep, ret) {
    if (!dep) return '';
    const d = new Date(dep + 'T00:00:00');
    const dStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    if (!ret) return dStr;
    const r = new Date(ret + 'T00:00:00');
    const rStr = r.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return `${dStr} – ${rStr}`;
  }

  function calcOutfits(details) {
    if (!details) return null;
    return {
      daytime:  details.days       || 0,
      pjs:      Math.ceil((details.nights || 0) / 2),
      nightOut: details.nightsOut  || 0,
      workout:  details.workoutDays || 0,
    };
  }

  function calcSupplements(templates, details) {
    if (!templates || !details) return [];
    const days = details.days || 0;
    const nights = details.nights || 0;
    return (templates.supplements || []).map((s) => ({
      ...s,
      count: s.multiplier * (s.basis === 'days' ? days : nights),
    }));
  }

  function packingProgress(trip, templates) {
    if (!templates) return { checked: 0, total: 0 };
    const packed = trip.packedItems || {};
    let total = 0, checked = 0;
    const cats = ['skincare','haircare','makeup','makeup_optional','misc'];
    cats.forEach((cat) => {
      (templates.packing[cat] || []).forEach((item) => {
        total++;
        if (packed[item.id]) checked++;
      });
    });
    // supplements as a category
    (templates.supplements || []).forEach((s) => {
      total++;
      if (packed[s.id]) checked++;
    });
    return { checked, total };
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  function init() {
    // INVARIANT: Seed defaults ONLY when fields are absent. Never overwrite
    // an existing trips array or travelTemplates object — that would wipe
    // user-edited templates and checklist state. The outer `||` and the
    // inner `if (!d.x)` are both required guards.
    const data = global.Pike.state.data;
    const needsTrips      = !data.trips;
    const needsTemplates  = !data.travelTemplates;
    if (needsTrips || needsTemplates) {
      global.Pike.state.commit((d) => {
        if (!d.trips)           d.trips = [];
        if (!d.travelTemplates) d.travelTemplates = DEFAULT_TEMPLATES;
      });
    }

    // Wire the header "+ New Trip" button
    const btn = document.getElementById('travel-new-trip');
    if (btn && !btn._wired) {
      btn.addEventListener('click', openNewTripModal);
      btn._wired = true;
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  function render() {
    const container = document.getElementById('travel-content');
    if (!container) return;
    if (activeTripId) {
      renderTripDetail(container);
    } else {
      renderDashboard(container);
    }
  }

  // ── Dashboard ────────────────────────────────────────────────────────────────

  function renderDashboard(container) {
    const trips = (global.Pike.state.data.trips || []).slice().sort((a, b) => {
      const sa = tripStatus(a), sb = tripStatus(b);
      const order = { upcoming: 0, active: 1, past: 2 };
      if (order[sa] !== order[sb]) return order[sa] - order[sb];
      return (a.departureDate || '').localeCompare(b.departureDate || '');
    });

    if (!trips.length) {
      container.innerHTML = `
        <div class="travel-empty">
          <p>No trips yet. Tap <strong>+ New Trip</strong> to plan your first one.</p>
        </div>`;
      return;
    }

    container.innerHTML = trips.map((trip) => {
      const status  = tripStatus(trip);
      const days    = daysUntil(trip.departureDate);
      const dateStr = fmtDateRange(trip.departureDate, trip.returnDate);
      const templates = global.Pike.state.data.travelTemplates;
      const prog    = packingProgress(trip, templates);
      const progPct = prog.total ? Math.round((prog.checked / prog.total) * 100) : 0;

      let countdownStr = '';
      if (status === 'upcoming' && days != null) {
        countdownStr = days === 0 ? 'Departing today' : days === 1 ? 'Tomorrow' : `${days} days away`;
      } else if (status === 'active') {
        countdownStr = 'In progress';
      }

      return `
        <div class="trip-card" data-trip-id="${esc(trip.id)}">
          <div class="trip-card-main">
            <div class="trip-card-name">${esc(trip.name)}</div>
            ${trip.destination ? `<div class="trip-card-dest">${esc(trip.destination)}</div>` : ''}
            <div class="trip-card-meta">
              ${dateStr ? `<span>${esc(dateStr)}</span>` : ''}
              ${countdownStr ? `<span class="trip-card-countdown">${esc(countdownStr)}</span>` : ''}
            </div>
          </div>
          <div class="trip-card-right">
            <span class="trip-status-badge is-${esc(status)}">${esc(status)}</span>
            ${prog.total ? `
              <div class="trip-pack-mini">
                <div class="trip-pack-mini-bar" style="width:${progPct}%"></div>
              </div>
              <div class="trip-pack-mini-label">${prog.checked}/${prog.total} packed</div>
            ` : ''}
          </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.trip-card').forEach((card) => {
      card.addEventListener('click', () => {
        activeTripId = card.dataset.tripId;
        render();
      });
    });
  }

  // ── Trip detail ──────────────────────────────────────────────────────────────

  function renderTripDetail(container) {
    const data = global.Pike.state.data;
    const trip = (data.trips || []).find((t) => t.id === activeTripId);
    if (!trip) { activeTripId = null; render(); return; }

    const templates = data.travelTemplates || DEFAULT_TEMPLATES;
    const details   = trip.tripDetails || { days: 0, nights: 0, nightsOut: 0, workoutDays: 0 };
    const outfits   = calcOutfits(details);
    const supps     = calcSupplements(templates, details);
    const packed    = trip.packedItems || {};
    const prog      = packingProgress(trip, templates);
    const progPct   = prog.total ? Math.round((prog.checked / prog.total) * 100) : 0;

    const amSupps   = supps.filter((s) => s.session === 'AM');
    const pmSupps   = supps.filter((s) => s.session === 'PM');

    // Build packing categories HTML
    const packingCats = ['skincare','haircare','makeup','makeup_optional','misc'];
    const packingHTML = packingCats.map((cat) => {
      const items = templates.packing[cat] || [];
      if (!items.length) return '';
      const itemsHTML = items.map((item) => `
        <label class="pack-item${packed[item.id] ? ' is-checked' : ''}">
          <input type="checkbox" class="pack-checkbox" data-item-id="${esc(item.id)}" ${packed[item.id] ? 'checked' : ''}>
          <span>${esc(item.name)}</span>
        </label>`).join('');
      return `
        <div class="packing-category">
          <div class="packing-cat-label">${esc(CATEGORY_LABELS[cat] || cat)}</div>
          <div class="packing-cat-items">${itemsHTML}</div>
        </div>`;
    }).join('');

    // Supplements packing row
    const suppPackHTML = `
      <div class="packing-category">
        <div class="packing-cat-label">Supplements</div>
        <div class="packing-cat-items">
          ${supps.map((s) => `
            <label class="pack-item${packed[s.id] ? ' is-checked' : ''}">
              <input type="checkbox" class="pack-checkbox" data-item-id="${esc(s.id)}" ${packed[s.id] ? 'checked' : ''}>
              <span>${esc(s.name)}${s.count ? ` <span class="pack-count">×${s.count}</span>` : ''}</span>
            </label>`).join('')}
        </div>
      </div>`;

    // Pre-trip checklists
    function clHTML(items, checkedObj, fieldName) {
      return items.map((item) => `
        <label class="pack-item${checkedObj[item.id] ? ' is-checked' : ''}">
          <input type="checkbox" class="pretripcheck" data-field="${esc(fieldName)}" data-item-id="${esc(item.id)}" ${checkedObj[item.id] ? 'checked' : ''}>
          <span>${esc(item.text)}</span>
        </label>`).join('');
    }

    container.innerHTML = `
      <button class="btn btn-ghost btn-sm travel-back-btn" type="button">← All trips</button>

      <div class="trip-detail-header">
        <div>
          <h2 class="trip-detail-name">${esc(trip.name)}</h2>
          ${trip.destination ? `<div class="trip-detail-dest">${esc(trip.destination)}</div>` : ''}
          <div class="trip-detail-dates">${esc(fmtDateRange(trip.departureDate, trip.returnDate))}</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="trip-edit-btn" type="button">Edit</button>
      </div>

      <!-- Quantities -->
      <div class="trip-section-card">
        <h3 class="trip-section-title">Trip details</h3>
        <div class="trip-quantities-grid">
          <label class="trip-qty-field">
            <span>Days</span>
            <input type="number" inputmode="numeric" class="input trip-qty-input" name="days" min="0" value="${esc(details.days || 0)}">
          </label>
          <label class="trip-qty-field">
            <span>Nights</span>
            <input type="number" inputmode="numeric" class="input trip-qty-input" name="nights" min="0" value="${esc(details.nights || 0)}">
          </label>
          <label class="trip-qty-field">
            <span>Nights out</span>
            <input type="number" inputmode="numeric" class="input trip-qty-input" name="nightsOut" min="0" value="${esc(details.nightsOut || 0)}">
          </label>
          <label class="trip-qty-field">
            <span>Workout days</span>
            <input type="number" inputmode="numeric" class="input trip-qty-input" name="workoutDays" min="0" value="${esc(details.workoutDays || 0)}">
          </label>
        </div>
        <div class="trip-outfit-summary" id="trip-outfit-summary">
          ${renderOutfitSummary(outfits, details)}
        </div>
      </div>

      <!-- Supplements -->
      <div class="trip-section-card">
        <h3 class="trip-section-title">Supplements</h3>
        <div class="trip-supps-grid" id="trip-supps-grid">
          ${renderSuppsHTML(amSupps, pmSupps)}
        </div>
      </div>

      <!-- Pre-trip checklists -->
      <div class="trip-section-card">
        <h3 class="trip-section-title">Pre-trip prep</h3>
        <div class="pretripcheck-section">
          <div class="pretripcheck-header">3 days before</div>
          ${clHTML(templates.preTripChecklists.threeDays, trip.checklist3Day || {}, 'checklist3Day')}
        </div>
        <div class="pretripcheck-section" style="margin-top: var(--space-4);">
          <div class="pretripcheck-header">Night before</div>
          ${clHTML(templates.preTripChecklists.nightBefore, trip.checklistNight || {}, 'checklistNight')}
        </div>
      </div>

      <!-- Packing list -->
      <div class="trip-section-card">
        <div class="packing-header-row">
          <h3 class="trip-section-title">Packing list</h3>
          <span class="packing-progress-label">${prog.checked} of ${prog.total} packed</span>
        </div>
        <div class="packing-progress-bar-wrap">
          <div class="packing-progress-bar" id="packing-progress-bar" style="width:${progPct}%"></div>
        </div>
        ${packingHTML}
        ${suppPackHTML}
      </div>
    `;

    // Back button
    container.querySelector('.travel-back-btn').addEventListener('click', () => {
      activeTripId = null;
      render();
    });

    // Edit button
    container.querySelector('#trip-edit-btn').addEventListener('click', () => openEditTripModal(trip.id));

    // Quantity inputs → live recalculate
    container.querySelectorAll('.trip-qty-input').forEach((input) => {
      input.addEventListener('focus', () => input.select());
      input.addEventListener('input', () => {
        const newDetails = {
          days:        parseInt(container.querySelector('[name="days"]').value)       || 0,
          nights:      parseInt(container.querySelector('[name="nights"]').value)     || 0,
          nightsOut:   parseInt(container.querySelector('[name="nightsOut"]').value)  || 0,
          workoutDays: parseInt(container.querySelector('[name="workoutDays"]').value)|| 0,
        };
        global.Pike.state.commit((d) => {
          const t = (d.trips || []).find((x) => x.id === activeTripId);
          if (t) t.tripDetails = newDetails;
        });
        // Live update summary + supplements in DOM without full re-render
        const newOutfits = calcOutfits(newDetails);
        const newSupps   = calcSupplements(templates, newDetails);
        const summaryEl  = container.querySelector('#trip-outfit-summary');
        const suppsEl    = container.querySelector('#trip-supps-grid');
        if (summaryEl) summaryEl.innerHTML = renderOutfitSummary(newOutfits, newDetails);
        if (suppsEl)   suppsEl.innerHTML   = renderSuppsHTML(newSupps.filter(s=>s.session==='AM'), newSupps.filter(s=>s.session==='PM'));
      });
    });

    // Packing checkboxes — ONLY allowed write path for trip.packedItems.
    // Keyed by itemId, never by date. Persists until user unchecks.
    container.querySelectorAll('.pack-checkbox').forEach((cb) => {
      cb.addEventListener('change', () => {
        const itemId  = cb.dataset.itemId;
        const checked = cb.checked;
        global.Pike.state.commit((d) => {
          const t = (d.trips || []).find((x) => x.id === activeTripId);
          if (t) {
            if (!t.packedItems) t.packedItems = {};
            if (checked) t.packedItems[itemId] = true;
            else delete t.packedItems[itemId];
          }
        });
        // Update label style + progress bar without full re-render
        cb.closest('.pack-item')?.classList.toggle('is-checked', checked);
        updatePackingProgress(container);
      });
    });

    // Pre-trip checkboxes — ONLY allowed write path (in trip detail) for
    // trip.checklist3Day and trip.checklistNight. Keyed by itemId, never
    // by date. Persists until user unchecks.
    container.querySelectorAll('.pretripcheck').forEach((cb) => {
      cb.addEventListener('change', () => {
        const field  = cb.dataset.field;
        const itemId = cb.dataset.itemId;
        const checked = cb.checked;
        global.Pike.state.commit((d) => {
          const t = (d.trips || []).find((x) => x.id === activeTripId);
          if (t) {
            if (!t[field]) t[field] = {};
            if (checked) t[field][itemId] = true;
            else delete t[field][itemId];
          }
        });
        cb.closest('.pack-item')?.classList.toggle('is-checked', checked);
      });
    });
  }

  function renderOutfitSummary(outfits, details) {
    if (!outfits || !details.days) return `<p class="trip-outfit-empty">Fill in trip details to see packing quantities.</p>`;
    const rows = [
      ['Daytime outfits', outfits.daytime],
      ['PJs / sleepwear', outfits.pjs],
    ];
    if (outfits.nightOut) rows.push(['Night-out outfits', outfits.nightOut]);
    if (outfits.workout)  rows.push(['Workout outfits',   outfits.workout]);
    return `<div class="trip-outfit-grid">${rows.map(([label, val]) => `
      <span class="trip-outfit-label">${esc(label)}</span>
      <span class="trip-outfit-val">${val}</span>`).join('')}</div>`;
  }

  function renderSuppsHTML(amSupps, pmSupps) {
    function row(s) {
      return `<div class="supp-row${s.optional ? ' is-optional' : ''}">
        <span class="supp-name">${esc(s.name)}${s.optional ? ' <span class="supp-opt">(opt)</span>' : ''}</span>
        <span class="supp-count">${s.count || '—'}</span>
      </div>`;
    }
    return `
      <div class="supp-col">
        <div class="supp-col-label">AM</div>
        ${amSupps.map(row).join('')}
      </div>
      <div class="supp-col">
        <div class="supp-col-label">PM</div>
        ${pmSupps.map(row).join('')}
      </div>`;
  }

  function updatePackingProgress(container) {
    const data = global.Pike.state.data;
    const trip = (data.trips || []).find((t) => t.id === activeTripId);
    if (!trip) return;
    const templates = data.travelTemplates || DEFAULT_TEMPLATES;
    const prog = packingProgress(trip, templates);
    const progPct = prog.total ? Math.round((prog.checked / prog.total) * 100) : 0;
    const bar   = container.querySelector('#packing-progress-bar');
    const label = container.querySelector('.packing-progress-label');
    if (bar)   bar.style.width = progPct + '%';
    if (label) label.textContent = `${prog.checked} of ${prog.total} packed`;
  }

  // ── Modals ───────────────────────────────────────────────────────────────────

  function openNewTripModal() {
    const form = document.createElement('form');
    form.innerHTML = `
      <label><span>Trip name</span>
        <input type="text" class="input" name="name" required maxlength="80" placeholder="e.g. Charleston weekend" autocomplete="off">
      </label>
      <label><span>Destination <span class="muted">(optional)</span></span>
        <input type="text" class="input" name="destination" maxlength="80" placeholder="e.g. Charleston, SC" autocomplete="off">
      </label>
      <div class="row" style="gap:var(--space-3)">
        <label style="flex:1"><span>Departure date</span>
          <input type="date" class="input" name="departureDate" required>
        </label>
        <label style="flex:1"><span>Return date</span>
          <input type="date" class="input" name="returnDate">
        </label>
      </div>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">Create trip</button>
      </div>`;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      if (!name) return;
      const trip = {
        id: uid('trip'),
        name,
        destination:   String(fd.get('destination') || '').trim() || null,
        departureDate: String(fd.get('departureDate') || ''),
        returnDate:    String(fd.get('returnDate') || '') || null,
        tripDetails:   { days: 0, nights: 0, nightsOut: 0, workoutDays: 0 },
        packedItems:   {},
        checklist3Day: {},
        checklistNight:{},
        createdAt:     new Date().toISOString(),
      };
      global.Pike.state.commit((d) => {
        if (!d.trips) d.trips = [];
        d.trips.push(trip);
      });
      global.Pike.modal.close();
      activeTripId = trip.id;
      render();
    });

    global.Pike.modal.open({ title: 'New trip', body: form });
  }

  function openEditTripModal(tripId) {
    const trip = (global.Pike.state.data.trips || []).find((t) => t.id === tripId);
    if (!trip) return;

    const form = document.createElement('form');
    form.innerHTML = `
      <label><span>Trip name</span>
        <input type="text" class="input" name="name" required maxlength="80" value="${esc(trip.name)}" autocomplete="off">
      </label>
      <label><span>Destination <span class="muted">(optional)</span></span>
        <input type="text" class="input" name="destination" maxlength="80" value="${esc(trip.destination || '')}" autocomplete="off">
      </label>
      <div class="row" style="gap:var(--space-3)">
        <label style="flex:1"><span>Departure date</span>
          <input type="date" class="input" name="departureDate" value="${esc(trip.departureDate || '')}">
        </label>
        <label style="flex:1"><span>Return date</span>
          <input type="date" class="input" name="returnDate" value="${esc(trip.returnDate || '')}">
        </label>
      </div>
      <div class="pike-modal-actions">
        <button type="button" class="btn btn-danger" data-action="delete">Delete trip</button>
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">Save</button>
      </div>`;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      if (!name) return;
      global.Pike.state.commit((d) => {
        const t = (d.trips || []).find((x) => x.id === tripId);
        if (!t) return;
        t.name        = name;
        t.destination = String(fd.get('destination') || '').trim() || null;
        t.departureDate = String(fd.get('departureDate') || '');
        t.returnDate    = String(fd.get('returnDate') || '') || null;
      });
      global.Pike.modal.close();
    });

    form.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      if (!confirm('Delete this trip? This cannot be undone.')) return;
      global.Pike.state.commit((d) => {
        d.trips = (d.trips || []).filter((t) => t.id !== tripId);
      });
      global.Pike.modal.close();
      activeTripId = null;
      render();
    });

    global.Pike.modal.open({ title: 'Edit trip', body: form });
  }

  // ── Trip prep for Today view (called by today.js) ────────────────────────────

  function renderTripPrepForToday() {
    const el = document.getElementById('today-trip-prep');
    if (!el) return;

    const data = global.Pike.state.data;
    const trips = (data.trips || []);
    const templates = data.travelTemplates || DEFAULT_TEMPLATES;

    // Find the most imminent upcoming trip
    const upcoming = trips
      .filter((t) => tripStatus(t) === 'upcoming')
      .sort((a, b) => (a.departureDate || '').localeCompare(b.departureDate || ''));

    const trip = upcoming[0];
    if (!trip) { el.hidden = true; el.innerHTML = ''; return; }

    const days = daysUntil(trip.departureDate);
    const show3Day   = days != null && days <= 3 && days >= 1;
    const showNight  = days != null && days <= 1;

    if (!show3Day && !showNight) { el.hidden = true; el.innerHTML = ''; return; }

    el.hidden = false;

    function checklistSection(title, items, checkedObj, field) {
      return `
        <div class="trip-prep-section">
          <div class="trip-prep-section-title">${esc(title)}</div>
          ${items.map((item) => `
            <label class="trip-prep-item${checkedObj[item.id] ? ' is-checked' : ''}">
              <input type="checkbox" class="trip-prep-cb" data-field="${esc(field)}" data-item-id="${esc(item.id)}" ${checkedObj[item.id] ? 'checked' : ''}>
              <span>${esc(item.text)}</span>
            </label>`).join('')}
        </div>`;
    }

    const countdown = days === 0 ? 'departing today' : days === 1 ? 'tomorrow' : `${days} days`;

    el.innerHTML = `
      <div class="today-trip-prep-card">
        <div class="trip-prep-eyebrow">✈ Trip prep · ${esc(trip.name)} departs ${esc(countdown)}</div>
        ${show3Day  ? checklistSection('3 days before', templates.preTripChecklists.threeDays,  trip.checklist3Day  || {}, 'checklist3Day')  : ''}
        ${showNight ? checklistSection('Night before',  templates.preTripChecklists.nightBefore, trip.checklistNight || {}, 'checklistNight') : ''}
      </div>`;

    // Today-view trip prep checkboxes — ONLY allowed write path (from Today)
    // for trip.checklist3Day and trip.checklistNight. Same trip-level state
    // the Travel detail view writes to; checking here in Today persists into
    // the trip object and shows checked next time the trip is opened.
    // Keyed by itemId. NEVER keyed by todayKey() — survives day rollover.
    el.querySelectorAll('.trip-prep-cb').forEach((cb) => {
      cb.addEventListener('change', () => {
        const field  = cb.dataset.field;
        const itemId = cb.dataset.itemId;
        const checked = cb.checked;
        global.Pike.state.commit((d) => {
          const t = (d.trips || []).find((x) => x.id === trip.id);
          if (t) {
            if (!t[field]) t[field] = {};
            if (checked) t[field][itemId] = true;
            else delete t[field][itemId];
          }
        });
        cb.closest('.trip-prep-item')?.classList.toggle('is-checked', checked);
      });
    });
  }

  global.Pike = global.Pike || {};
  global.Pike.travel = { init, render, renderTripPrepForToday };
})(window);
