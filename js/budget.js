/* Virtual Pike — Budget
 *
 * Manual-first money cockpit. All data lives in data.budget JSON blob (Phases 1–4);
 * transactions move to a typed Supabase table at Phase 5 (Plaid).
 *
 * UX pattern: dashboard with drill-down focused views (mirrors Travel's
 * dashboard → trip detail). Module-local activeView is null when on the
 * dashboard, otherwise the name of the focused view.
 *
 * Categories are seeded once on first init and have no MVP UI — they appear
 * as dropdowns in transaction and allocation forms. Editing categories is
 * deferred (open data.budget.categories in DevTools if you need to tweak).
 *
 * Money is stored as integer cents end-to-end. Use centsFromInput() and
 * formatCents() — never parseFloat amounts directly.
 *
 * Pay-period membership is DERIVED from date — never stamped on transactions.
 * The single source of truth is `periodForDate(date)`. Editing period dates
 * automatically re-binds historical transactions on the next render.
 *
 * Splits invariant: sum(splits.amountCents) === parent.amountCents. NO
 * exceptions. Reporting decides what counts as spending vs transfer vs debt
 * payment, but the data must reconcile exactly.
 *
 * Transfers are atomic two-leg pairs sharing transferPairId (= outflow leg id).
 * The Transactions list shows ONE row per pair (the outflow leg), with a
 * "→ DestAccount" chip. Edit/delete always touches both legs in one commit.
 *
 * render() early-returns when the active section isn't #budget — the
 * state.on() listener fires on every commit across the app, and Budget
 * aggregations would otherwise tank perf elsewhere.
 *
 * Public:
 *   Pike.budget.init()   — one-time setup; idempotent
 *   Pike.budget.render() — re-render the current screen (gated by section)
 */

(function (global) {
  'use strict';

  // ─── Constants ───────────────────────────────────────────────────────────────

  const VIEWS = [
    { id: 'accounts',     title: 'Accounts',      blurb: 'Checking, savings, cards, and loans.' },
    { id: 'debts',        title: 'Debts',         blurb: 'Balances, minimums, and progress.' },
    { id: 'payperiods',   title: 'Pay periods',   blurb: 'Paychecks and per-category allocations.' },
    { id: 'transactions', title: 'Transactions',  blurb: 'Spending, income, transfers, splits.' },
    { id: 'recurring',    title: 'Recurring',     blurb: 'Bills and subscriptions on a cadence.' },
  ];

  const ACCOUNT_TYPES = [
    { id: 'checking',    label: 'Checking' },
    { id: 'savings',     label: 'Savings' },
    { id: 'credit-card', label: 'Credit card' },
    { id: 'loan',        label: 'Loan' },
    { id: 'cash',        label: 'Cash' },
  ];

  const DEBT_ACCOUNT_TYPES = ['credit-card', 'loan'];

  const DEBT_KINDS = [
    { id: 'credit-card',   label: 'Credit card' },
    { id: 'student-loan',  label: 'Student loan' },
    { id: 'auto-loan',     label: 'Auto loan' },
    { id: 'personal-loan', label: 'Personal loan' },
    { id: 'medical',       label: 'Medical' },
    { id: 'other',         label: 'Other' },
  ];

  // User-facing transaction kinds (shown in the regular tx modal).
  // Transfers and debt-payments are created via the dedicated transfer modal.
  const TX_KIND_OPTIONS = [
    { id: 'spending', label: 'Spending', direction: 'outflow' },
    { id: 'income',   label: 'Income',   direction: 'inflow'  },
    { id: 'refund',   label: 'Refund',   direction: 'inflow'  },
  ];

  const RECURRING_CADENCES = [
    { id: 'weekly',    label: 'Weekly',    days: 7   },
    { id: 'biweekly',  label: 'Biweekly',  days: 14  },
    { id: 'monthly',   label: 'Monthly',   days: null },
    { id: 'quarterly', label: 'Quarterly', days: null },
    { id: 'annual',    label: 'Annual',    days: null },
  ];

  // Seeded once on first init via the categoriesSeeded flag.
  const SEED_CATEGORIES = [
    { name: 'Groceries',     group: 'essential', color: 'sage' },
    { name: 'Eating out',    group: 'lifestyle', color: 'rose' },
    { name: 'Gas',           group: 'essential', color: 'taupe' },
    { name: 'Household',     group: 'essential', color: 'sage' },
    { name: 'Bills',         group: 'essential', color: 'taupe' },
    { name: 'Subscriptions', group: 'lifestyle', color: 'rose' },
    { name: 'Personal care', group: 'lifestyle', color: 'rose' },
    { name: 'Health',        group: 'essential', color: 'sage' },
    { name: 'Gifts',         group: 'lifestyle', color: 'rose' },
    { name: 'Travel',        group: 'lifestyle', color: 'rose' },
    { name: 'Income',        group: 'income',    color: 'sage' },
    { name: 'Transfer',      group: 'transfer',  color: 'neutral' },
    { name: 'Debt payment',  group: 'debt',      color: 'amber' },
  ];

  // null = dashboard; otherwise the id of a focused view
  let activeView = null;
  let txFilter = 'all';  // 'all' | 'unassigned' | 'uncategorized'
  let selectedTxnIds = new Set(); // ids of transactions checked for bulk action
  // Sub-drilldown INSIDE the Pay periods focused view (not a 6th top-level view).
  // Mirrors Travel's trip-list → trip-detail pattern.
  let activePeriodId = null;
  let sectionListenerAttached = false;

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function getBudget() {
    const d = global.Pike.state.data;
    return d && d.budget ? d.budget : null;
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function todayKey(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Money helpers — never parseFloat amounts directly.
  function centsFromInput(value) {
    if (value == null || value === '') return 0;
    const cleaned = String(value).replace(/[^\d.\-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return 0;
    const n = Number(cleaned);
    if (!Number.isFinite(n)) return 0;
    const negative = n < 0;
    const abs = Math.abs(n);
    return (negative ? -1 : 1) * Math.round(abs * 100);
  }

  function formatCents(cents, opts) {
    const o = opts || {};
    const n = Math.abs(cents) / 100;
    const formatted = n.toLocaleString('en-US', {
      minimumFractionDigits: o.hideCents ? 0 : 2,
      maximumFractionDigits: o.hideCents ? 0 : 2,
    });
    const sign = cents < 0 ? '−' : (o.showSign ? '+' : '');
    return `${sign}$${formatted}`;
  }

  function inputValueFromCents(cents) {
    if (!cents) return '';
    return (Math.abs(cents) / 100).toFixed(2);
  }

  function fmtDate(isoDate) {
    if (!isoDate) return '';
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function fmtDateShort(isoDate) {
    if (!isoDate) return '';
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function daysBetween(fromIso, toIso) {
    const a = new Date(fromIso); a.setHours(0,0,0,0);
    const b = new Date(toIso);   b.setHours(0,0,0,0);
    return Math.round((b - a) / 86400000);
  }

  function addDaysIso(iso, days) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() + days);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  function addMonthsIso(iso, months) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d);
    dt.setMonth(dt.getMonth() + months);
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  }

  // ─── Aggregation (all derived, never stored) ─────────────────────────────────

  function periodForDate(dateStr) {
    if (!dateStr) return null;
    const periods = (getBudget().payPeriods || []);
    return periods.find((p) => p.startDate <= dateStr && dateStr <= p.endDate) || null;
  }

  function activePeriod() {
    return periodForDate(todayKey());
  }

  // Returns the FIRST other period that overlaps `period`, or null.
  // `period` may have an `id` (existing) or no id (new).
  function findOverlappingPeriod(period) {
    const periods = (getBudget().payPeriods || []);
    return periods.find((p) =>
      p.id !== period.id &&
      !(p.endDate < period.startDate || p.startDate > period.endDate)
    ) || null;
  }

  function signedTxCents(tx) {
    return (tx.direction === 'inflow' ? 1 : -1) * (tx.amountCents || 0);
  }

  // Account balance = starting balance + signed sum of transactions on/after
  // the starting balance date. Includes ALL kinds equally; transfers and
  // debt-payments naturally cancel across paired accounts.
  function accountBalance(acc) {
    const start = acc.startingBalanceCents || 0;
    const txns = (getBudget().transactions || [])
      .filter((t) => t.accountId === acc.id && t.date >= (acc.startingBalanceDate || '') && !t.plaidRemoved);
    return start + txns.reduce((sum, t) => sum + signedTxCents(t), 0);
  }

  // Net "spent" in this period:
  //   spending outflows  → add
  //   refund inflows     → subtract (refunds reduce category spending)
  //   transfers / debt-payments → excluded (they aren't spending)
  //   income             → excluded
  // May go negative when refunds exceed spending — callers should display the
  // result calmly (e.g. as a credit balance), not as a noisy red number.
  function periodSpendingCents(period) {
    if (!period) return 0;
    return (getBudget().transactions || []).reduce((sum, t) => {
      if (t.plaidRemoved) return sum;
      if (t.date < period.startDate || t.date > period.endDate) return sum;
      if (t.kind === 'transfer' || t.kind === 'debt-payment') return sum;
      if (t.kind === 'spending' && t.direction === 'outflow') return sum + (t.amountCents || 0);
      if (t.kind === 'refund'   && t.direction === 'inflow')  return sum - (t.amountCents || 0);
      return sum;
    }, 0);
  }

  function periodIncomeCents(period) {
    if (!period) return 0;
    return (getBudget().transactions || []).reduce((sum, t) => {
      if (t.plaidRemoved) return sum;
      if (t.date < period.startDate || t.date > period.endDate) return sum;
      if (t.direction !== 'inflow') return sum;
      if (t.kind === 'transfer' || t.kind === 'debt-payment') return sum;
      return sum + (t.amountCents || 0);
    }, 0);
  }

  // Historical math: NO archived-account filter. Whatever happened, happened.
  function debtPaidCentsInRange(startDate, endDate) {
    return (getBudget().transactions || []).reduce((sum, t) => {
      if (t.plaidRemoved) return sum;
      if (t.date < startDate || t.date > endDate) return sum;
      if (t.kind !== 'debt-payment') return sum;
      if (t.direction !== 'outflow') return sum;  // count each pair once via outflow leg
      return sum + (t.amountCents || 0);
    }, 0);
  }

  function debtPaidThisPeriodCents(period) {
    if (!period) return 0;
    return debtPaidCentsInRange(period.startDate, period.endDate);
  }

  // Per-debt: amount paid toward THIS debt's account in the active period.
  function debtPaidForDebtThisPeriod(dbt) {
    const period = activePeriod();
    if (!period) return 0;
    return (getBudget().transactions || []).reduce((sum, t) => {
      if (t.plaidRemoved) return sum;
      if (t.date < period.startDate || t.date > period.endDate) return sum;
      if (t.kind !== 'debt-payment') return sum;
      if (t.direction !== 'inflow') return sum;          // inflow leg = toward this debt account
      if (t.accountId !== dbt.accountId) return sum;
      return sum + (t.amountCents || 0);
    }, 0);
  }

  // Net spent in this period for ONE category:
  //   spending outflow with this categoryId / split.categoryId → add
  //   refund inflow with this categoryId / split.categoryId    → subtract
  //   transfers, debt-payments, income → excluded
  // May return a negative value (a credit) when refunds exceed spending.
  function categorySpentInPeriod(categoryId, period) {
    if (!period || !categoryId) return 0;
    return (getBudget().transactions || []).reduce((sum, t) => {
      if (t.plaidRemoved) return sum;
      if (t.date < period.startDate || t.date > period.endDate) return sum;
      if (t.kind === 'transfer' || t.kind === 'debt-payment') return sum;
      let sign = 0;
      if (t.kind === 'spending' && t.direction === 'outflow') sign = +1;
      else if (t.kind === 'refund' && t.direction === 'inflow') sign = -1;
      else return sum;
      if (Array.isArray(t.splits) && t.splits.length) {
        const splitMatch = t.splits
          .filter((s) => s.categoryId === categoryId)
          .reduce((n, s) => n + (s.amountCents || 0), 0);
        return sum + sign * splitMatch;
      }
      if (t.categoryId === categoryId) return sum + sign * (t.amountCents || 0);
      return sum;
    }, 0);
  }

  // Set of categoryIds that received any spending OR refund activity in this
  // period (including via splits). Callers filter as needed — e.g. the
  // unallocated section only surfaces categories with NET > 0 spent so a
  // pure-refund category doesn't read as "unbudgeted spending."
  function categoriesWithSpendingInPeriod(period) {
    const ids = new Set();
    if (!period) return ids;
    (getBudget().transactions || []).forEach((t) => {
      if (t.plaidRemoved) return;
      if (t.date < period.startDate || t.date > period.endDate) return;
      if (t.kind === 'transfer' || t.kind === 'debt-payment') return;
      const isSpending = t.kind === 'spending' && t.direction === 'outflow';
      const isRefund   = t.kind === 'refund'   && t.direction === 'inflow';
      if (!isSpending && !isRefund) return;
      if (Array.isArray(t.splits) && t.splits.length) {
        t.splits.forEach((s) => { if (s.categoryId) ids.add(s.categoryId); });
      } else if (t.categoryId) {
        ids.add(t.categoryId);
      }
    });
    return ids;
  }

  // Naive monthly average debt payment toward this debt's account, looking
  // back N days (default 90 = 3 months). Returns 0 if no payments found.
  function avgRecentMonthlyDebtPaymentCents(dbt, lookbackDays) {
    const days = lookbackDays || 90;
    const cutoff = addDaysIso(todayKey(), -days);
    const total = (getBudget().transactions || []).reduce((sum, t) => {
      if (t.plaidRemoved) return sum;
      if (t.kind !== 'debt-payment') return sum;
      if (t.direction !== 'inflow') return sum;       // inflow leg = toward debt account
      if (t.accountId !== dbt.accountId) return sum;
      if (t.date < cutoff) return sum;
      return sum + (t.amountCents || 0);
    }, 0);
    if (total <= 0) return 0;
    const monthsInLookback = days / 30;
    return Math.round(total / monthsInLookback);
  }

  // Returns months (rounded up), 0 if cleared, or null if no recent payments
  // exist to project from.
  function naivePayoffMonths(dbt) {
    const linked = (getBudget().accounts || []).find((a) => a.id === dbt.accountId);
    if (!linked) return null;
    const balance = Math.abs(accountBalance(linked));
    if (balance <= 0) return 0;
    const avgMonthly = avgRecentMonthlyDebtPaymentCents(dbt, 90);
    if (avgMonthly <= 0) return null;
    return Math.ceil(balance / avgMonthly);
  }

  // Human-readable debt-progress line. Always labeled as "naive" so the user
  // doesn't read it as a confident projection. Returns null when nothing
  // useful to show.
  function debtProgressLineText(dbt) {
    const linked = (getBudget().accounts || []).find((a) => a.id === dbt.accountId);
    if (!linked) return null;
    const months = naivePayoffMonths(dbt);
    const avgMonthly = avgRecentMonthlyDebtPaymentCents(dbt, 90);
    if (months === 0) return 'Cleared';
    if (months === null) {
      return 'Naive estimate · log a payment to project';
    }
    let timeLabel;
    if (months <= 12) {
      timeLabel = months === 1 ? 'about 1 month' : `about ${months} months`;
    } else {
      const years = Math.floor(months / 12);
      const rem = months % 12;
      timeLabel = rem === 0
        ? `about ${years} year${years > 1 ? 's' : ''}`
        : `about ${years} yr ${rem} mo`;
    }
    return `Naive estimate: ${timeLabel} at ${formatCents(avgMonthly)}/mo · ignores APR`;
  }

  function unassignedTxnCount() {
    const periods = getBudget().payPeriods || [];
    if (!periods.length) return 0;
    return (getBudget().transactions || []).filter((t) => !t.plaidRemoved && !periodForDate(t.date)).length;
  }

  // Returns the small uppercase cue under an account balance.
  function accountBalanceState(acc) {
    const txns = (getBudget().transactions || [])
      .filter((t) => t.accountId === acc.id && t.date >= (acc.startingBalanceDate || '') && !t.plaidRemoved);
    if (!txns.length) return 'Starting';
    const latest = txns.reduce((max, t) => (t.date > max ? t.date : max), '');
    return 'Through ' + fmtDateShort(latest);
  }

  // Walks a recurring bill's cadence forward from anchorDate, returning the
  // next occurrence dates in [today, today + days] (inclusive both ends).
  function upcomingOccurrences(bill, daysAhead) {
    const today = todayKey();
    const horizonDate = addDaysIso(today, daysAhead);
    const cadence = (RECURRING_CADENCES.find((c) => c.id === bill.cadence) || {});
    const out = [];
    if (!bill.anchorDate) return out;

    let cursor = bill.anchorDate;
    // Fast-forward cursor to today minus a full cycle (avoid walking from years ago)
    const safetyCap = 1000;
    let i = 0;
    while (cursor < today && i < safetyCap) {
      cursor = stepCadence(cursor, bill.cadence);
      i++;
    }
    // Walk forward inside the window
    while (cursor <= horizonDate && out.length < 50) {
      if (cursor >= today) out.push(cursor);
      cursor = stepCadence(cursor, bill.cadence);
    }
    return out;
  }

  function stepCadence(iso, cadenceId) {
    const cad = RECURRING_CADENCES.find((c) => c.id === cadenceId);
    if (!cad) return addMonthsIso(iso, 1);
    if (cad.days) return addDaysIso(iso, cad.days);
    if (cadenceId === 'monthly')   return addMonthsIso(iso, 1);
    if (cadenceId === 'quarterly') return addMonthsIso(iso, 3);
    if (cadenceId === 'annual')    return addMonthsIso(iso, 12);
    return addMonthsIso(iso, 1);
  }

  // For "Log now" duplicate warning — flexible match by merchant + date + account.
  function findDuplicateTxnsForBill(bill, occurrenceDate) {
    return (getBudget().transactions || []).filter((t) =>
      t.merchant === bill.name &&
      t.date === occurrenceDate &&
      t.accountId === bill.accountId
    );
  }

  // ─── Render gate ─────────────────────────────────────────────────────────────

  function isActiveSection() {
    return !!(global.Pike.router && global.Pike.router.currentSection() === 'budget');
  }

  function render() {
    if (!isActiveSection()) return;
    const contentEl = document.getElementById('budget-content');
    if (!contentEl) return;
    contentEl.innerHTML = '';
    if (activeView === null) {
      contentEl.appendChild(buildDashboard());
    } else {
      contentEl.appendChild(buildFocusedView(activeView));
    }
    // After the DOM is ready, let plaid.js populate the connected-banks slot
    // (only visible when the Accounts focused view is active).
    if (global.Pike && global.Pike.plaid) global.Pike.plaid.render();
  }

  function gotoView(viewId) {
    activeView = viewId;
    txFilter = 'all';
    selectedTxnIds = new Set();
    activePeriodId = null;
    render();
  }

  function gotoDashboard() {
    activeView = null;
    activePeriodId = null;
    render();
  }

  // ─── Dashboard ───────────────────────────────────────────────────────────────

  function buildDashboard() {
    const wrap = document.createElement('div');
    wrap.className = 'budget-dashboard';

    const eyebrow = document.createElement('p');
    eyebrow.className = 'budget-eyebrow';
    eyebrow.textContent = 'A calm view of money';
    wrap.appendChild(eyebrow);

    // Pay-period headline card (or empty placeholder)
    wrap.appendChild(buildPayPeriodHeadline());

    // Quick-add row
    wrap.appendChild(buildQuickAddRow());

    // Five drill-down cards
    const grid = document.createElement('div');
    grid.className = 'budget-grid';
    VIEWS.forEach((view) => grid.appendChild(buildCard(view)));
    wrap.appendChild(grid);

    // Top categories this period (hidden if no active period or no categorized spending)
    const topCats = buildTopCategoriesCard();
    if (topCats) wrap.appendChild(topCats);

    // Upcoming bills (only if any in next 14 days)
    const upcoming = buildUpcomingBillsTile();
    if (upcoming) wrap.appendChild(upcoming);

    // Unassigned banner (only if any unassigned transactions)
    const unassigned = unassignedTxnCount();
    if (unassigned > 0) wrap.appendChild(buildUnassignedBanner(unassigned));

    return wrap;
  }

  function buildPayPeriodHeadline() {
    const period = activePeriod();
    const card = document.createElement('div');
    card.className = 'budget-pp-card';

    if (!period) {
      const empty = document.createElement('div');
      empty.className = 'budget-pp-empty';
      const head = document.createElement('p');
      head.className = 'budget-pp-empty-head';
      head.textContent = 'No active pay period';
      const sub = document.createElement('p');
      sub.className = 'budget-pp-empty-sub';
      sub.textContent = 'Add one in Pay periods to start tracking spending against a paycheck.';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm';
      btn.textContent = 'Open Pay periods';
      btn.addEventListener('click', () => gotoView('payperiods'));
      empty.appendChild(head);
      empty.appendChild(sub);
      empty.appendChild(btn);
      card.appendChild(empty);
      return card;
    }

    const expected = period.expectedIncomeCents || 0;
    const spent = periodSpendingCents(period);
    const remaining = expected - spent;
    const debtPaid = debtPaidThisPeriodCents(period);
    const today = todayKey();
    const daysLeft = Math.max(0, daysBetween(today, period.endDate));

    const label = document.createElement('p');
    label.className = 'budget-pp-label';
    label.textContent = period.label || 'Current period';
    card.appendChild(label);

    const headline = document.createElement('p');
    headline.className = 'budget-pp-headline';
    headline.textContent = formatCents(remaining);
    if (remaining < 0) headline.classList.add('is-negative');
    card.appendChild(headline);

    const sub = document.createElement('p');
    sub.className = 'budget-pp-sub';
    const dayLabel = daysLeft === 0 ? 'last day' : (daysLeft === 1 ? '1 day left' : `${daysLeft} days left`);
    if (spent < 0) {
      sub.textContent = `${formatCents(Math.abs(spent))} net credit · ${dayLabel}`;
    } else {
      sub.textContent = `${formatCents(spent)} spent of ${formatCents(expected)} · ${dayLabel}`;
    }
    card.appendChild(sub);

    // Progress bar — clamped to [0, 100] so net credits render as an empty bar
    // rather than an inverted/negative width.
    const bar = document.createElement('div');
    bar.className = 'budget-pp-bar';
    const fill = document.createElement('div');
    fill.className = 'budget-pp-bar-fill';
    const pct = (expected > 0 && spent > 0)
      ? Math.max(0, Math.min(100, Math.round((spent / expected) * 100)))
      : 0;
    fill.style.width = pct + '%';
    if (expected > 0 && spent > expected) fill.classList.add('is-over');
    bar.appendChild(fill);
    card.appendChild(bar);

    // Debt-paid sub-tile (only when nonzero)
    if (debtPaid > 0) {
      const debt = document.createElement('p');
      debt.className = 'budget-pp-debt';
      debt.textContent = `${formatCents(debtPaid)} paid toward debt this period`;
      card.appendChild(debt);
    }

    return card;
  }

  function buildQuickAddRow() {
    const row = document.createElement('div');
    row.className = 'budget-quick-add';
    [
      { label: '+ Transaction', onClick: () => openTransactionModal(null, { kind: 'spending' }) },
      { label: '+ Transfer',    onClick: () => openTransferModal(null) },
      { label: '+ Income',      onClick: () => openTransactionModal(null, { kind: 'income' }) },
    ].forEach(({ label, onClick }) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn btn-ghost btn-sm budget-quick-add-btn';
      b.textContent = label;
      b.addEventListener('click', onClick);
      row.appendChild(b);
    });
    return row;
  }

  function buildCard(view) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'budget-card';
    card.setAttribute('aria-label', `Open ${view.title}`);

    const title = document.createElement('h3');
    title.className = 'budget-card-title';
    title.textContent = view.title;

    const blurb = document.createElement('p');
    blurb.className = 'budget-card-blurb';
    blurb.textContent = view.blurb;

    const status = document.createElement('span');
    status.className = 'budget-card-status';
    status.textContent = cardStatus(view.id);

    card.appendChild(title);
    card.appendChild(blurb);
    card.appendChild(status);

    card.addEventListener('click', () => gotoView(view.id));
    return card;
  }

  function cardStatus(viewId) {
    const b = getBudget();
    if (!b) return '';
    if (viewId === 'accounts') {
      const accs = (b.accounts || []).filter((a) => !a.archived);
      if (!accs.length) return 'No accounts yet';
      const total = accs.reduce((sum, a) => sum + accountBalance(a), 0);
      return `${formatCents(total)} · ${accs.length} ${accs.length === 1 ? 'account' : 'accounts'}`;
    }
    if (viewId === 'debts') {
      const debts = (b.debts || []);
      if (!debts.length) return 'No debts tracked';
      const owed = debts.reduce((sum, d) => {
        const linked = (b.accounts || []).find((a) => a.id === d.accountId);
        return sum + Math.abs(linked ? accountBalance(linked) : 0);
      }, 0);
      const period = activePeriod();
      const paid = period ? debtPaidThisPeriodCents(period) : 0;
      return paid > 0
        ? `${formatCents(owed)} owed · ${formatCents(paid)} paid this period`
        : `${formatCents(owed)} owed · ${debts.length} ${debts.length === 1 ? 'debt' : 'debts'}`;
    }
    if (viewId === 'payperiods') {
      const period = activePeriod();
      const total = (b.payPeriods || []).length;
      if (!total) return 'No pay periods yet';
      if (period) return `${period.label} · ${total} total`;
      return `${total} ${total === 1 ? 'period' : 'periods'}`;
    }
    if (viewId === 'transactions') {
      const period = activePeriod();
      const txns = (b.transactions || []).filter((t) => !t.plaidRemoved);
      if (!txns.length) return 'No transactions yet';
      if (!period) return `${txns.length} ${txns.length === 1 ? 'transaction' : 'transactions'}`;
      const inPeriod = txns.filter((t) => t.date >= period.startDate && t.date <= period.endDate).length;
      return `${inPeriod} this period`;
    }
    if (viewId === 'recurring') {
      const bills = (b.recurringBills || []).filter((r) => !r.archived);
      if (!bills.length) return 'No recurring yet';
      const upcomingCount = bills.reduce((n, bill) => n + upcomingOccurrences(bill, 14).length, 0);
      return upcomingCount > 0
        ? `${upcomingCount} upcoming in 14 days`
        : `${bills.length} ${bills.length === 1 ? 'bill' : 'bills'}`;
    }
    return 'Coming next';
  }

  function buildTopCategoriesCard() {
    const period = activePeriod();
    if (!period) return null;

    const b = getBudget();
    const categories = b.categories || [];
    const catIds = categoriesWithSpendingInPeriod(period);

    // Compute net spent per category; keep only positive (net spend) entries.
    const rows = [];
    catIds.forEach((id) => {
      const spent = categorySpentInPeriod(id, period);
      if (spent <= 0) return; // pure-refund or zero — skip
      const cat = categories.find((c) => c.id === id);
      if (!cat) return;
      const alloc = (period.allocations || []).find((a) => a.categoryId === id);
      rows.push({ cat, spent, allocCents: alloc ? alloc.amountCents : null });
    });

    if (!rows.length) return null;

    rows.sort((a, b) => b.spent - a.spent);
    const top = rows.slice(0, 5);

    const card = document.createElement('section');
    card.className = 'budget-top-cats';

    const head = document.createElement('div');
    head.className = 'budget-top-cats-head';

    const title = document.createElement('h3');
    title.className   = 'budget-top-cats-title';
    title.textContent = 'Top categories this period';
    head.appendChild(title);

    const viewAll = document.createElement('button');
    viewAll.type      = 'button';
    viewAll.className = 'budget-top-cats-viewall';
    viewAll.textContent = 'View all →';
    viewAll.addEventListener('click', () => {
      activeView    = 'payperiods';
      activePeriodId = period.id;
      render();
    });
    head.appendChild(viewAll);
    card.appendChild(head);

    const list = document.createElement('div');
    list.className = 'budget-top-cats-list';

    top.forEach(({ cat, spent, allocCents }) => {
      const row = document.createElement('div');
      row.className = 'budget-top-cats-row';

      const nameEl = document.createElement('span');
      nameEl.className   = 'budget-top-cats-name';
      nameEl.textContent = cat.name;

      const right = document.createElement('div');
      right.className = 'budget-top-cats-right';

      const spentEl = document.createElement('span');
      spentEl.className   = 'budget-top-cats-spent';
      spentEl.textContent = formatCents(spent);

      right.appendChild(spentEl);

      if (allocCents != null) {
        const remaining = allocCents - spent;
        const sub = document.createElement('span');
        sub.className = 'budget-top-cats-sub';
        if (remaining >= 0) {
          sub.textContent = `${formatCents(remaining)} left`;
        } else {
          sub.textContent = `${formatCents(Math.abs(remaining))} over`;
          sub.classList.add('is-over');
        }
        right.appendChild(sub);
      }

      row.appendChild(nameEl);
      row.appendChild(right);
      list.appendChild(row);
    });

    card.appendChild(list);
    return card;
  }

  function buildUpcomingBillsTile() {
    const bills = (getBudget().recurringBills || []).filter((r) => !r.archived);
    const occurrences = [];
    bills.forEach((bill) => {
      upcomingOccurrences(bill, 14).forEach((dateStr) => {
        occurrences.push({ bill, date: dateStr });
      });
    });
    if (!occurrences.length) return null;
    occurrences.sort((a, b) => a.date.localeCompare(b.date));

    const tile = document.createElement('section');
    tile.className = 'budget-upcoming';
    const title = document.createElement('h3');
    title.className = 'budget-upcoming-title';
    title.textContent = 'Upcoming bills';
    tile.appendChild(title);

    const list = document.createElement('div');
    list.className = 'budget-upcoming-list';
    occurrences.forEach(({ bill, date }) => {
      list.appendChild(buildUpcomingRow(bill, date));
    });
    tile.appendChild(list);
    return tile;
  }

  function buildUpcomingRow(bill, dateStr) {
    const row = document.createElement('div');
    row.className = 'budget-upcoming-row';

    const main = document.createElement('div');
    main.className = 'budget-upcoming-main';
    const name = document.createElement('span');
    name.className = 'budget-upcoming-name';
    name.textContent = bill.name;
    const due = document.createElement('span');
    due.className = 'budget-upcoming-due';
    const days = daysBetween(todayKey(), dateStr);
    due.textContent = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days <= 7 ? `in ${days} days` : fmtDateShort(dateStr);
    main.appendChild(name);
    main.appendChild(due);

    const amount = document.createElement('span');
    amount.className = 'budget-upcoming-amount';
    amount.textContent = formatCents(bill.amountCents || 0);

    const logBtn = document.createElement('button');
    logBtn.type = 'button';
    logBtn.className = 'btn btn-ghost btn-sm';
    logBtn.textContent = 'Log now';
    logBtn.addEventListener('click', () => openLogBillFlow(bill, dateStr));

    row.appendChild(main);
    row.appendChild(amount);
    row.appendChild(logBtn);
    return row;
  }

  function buildUnassignedBanner(count) {
    const b = document.createElement('div');
    b.className = 'budget-banner budget-banner-unassigned';
    const text = document.createElement('p');
    text.className = 'budget-banner-text';
    text.textContent = count === 1
      ? `1 transaction doesn't fall in any pay period.`
      : `${count} transactions don't fall in any pay period.`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = 'Open Transactions';
    btn.addEventListener('click', () => {
      txFilter = 'unassigned';
      activeView = 'transactions';
      render();
    });
    b.appendChild(text);
    b.appendChild(btn);
    return b;
  }

  // ─── Focused view dispatch ───────────────────────────────────────────────────

  function buildFocusedView(viewId) {
    const view = VIEWS.find((v) => v.id === viewId) || { id: viewId, title: viewId, blurb: '' };

    const wrap = document.createElement('div');
    wrap.className = 'budget-focus budget-focus-' + viewId;

    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'budget-back';
    back.textContent = '← Back to Budget';
    back.addEventListener('click', gotoDashboard);
    wrap.appendChild(back);

    const header = document.createElement('header');
    header.className = 'budget-focus-header';

    const heading = document.createElement('h2');
    heading.className = 'budget-focus-title';
    heading.textContent = view.title;
    header.appendChild(heading);

    const headerActions = buildFocusHeaderActions(viewId);
    if (headerActions) header.appendChild(headerActions);

    // When drilling into a period detail, hide the outer focused-view header and
    // blurb so the screen feels like a single focused view, not stacked headers.
    const suppressHeader = (viewId === 'payperiods' && activePeriodId);
    if (!suppressHeader) {
      wrap.appendChild(header);

      const blurb = document.createElement('p');
      blurb.className = 'budget-focus-blurb';
      blurb.textContent = view.blurb;
      wrap.appendChild(blurb);
    }

    const body = document.createElement('div');
    body.className = 'budget-focus-body';
    if      (viewId === 'accounts')     body.appendChild(buildAccountsView());
    else if (viewId === 'debts')        body.appendChild(buildDebtsView());
    else if (viewId === 'payperiods')   body.appendChild(buildPayPeriodsView());
    else if (viewId === 'transactions') body.appendChild(buildTransactionsView());
    else if (viewId === 'recurring')    body.appendChild(buildRecurringView());
    else                                body.appendChild(buildPlaceholder());
    wrap.appendChild(body);

    return wrap;
  }

  function buildFocusHeaderActions(viewId) {
    const wrap = document.createElement('div');
    wrap.className = 'budget-focus-header-actions';

    const addLabels = {
      accounts:     '+ Account',
      debts:        '+ Debt',
      payperiods:   '+ Pay period',
      transactions: '+ Transaction',
      recurring:    '+ Recurring bill',
    };
    const handlers = {
      accounts:     () => openAccountModal(null),
      debts:        () => openDebtModal(null),
      payperiods:   () => openPayPeriodModal(null),
      transactions: () => openTransactionModal(null, { kind: 'spending' }),
      recurring:    () => openRecurringModal(null),
    };

    const addLabel = addLabels[viewId];
    if (!addLabel) return null;

    // Transactions view also gets a "+ Transfer" button.
    if (viewId === 'transactions') {
      const transferBtn = document.createElement('button');
      transferBtn.type = 'button';
      transferBtn.className = 'btn btn-ghost btn-sm';
      transferBtn.textContent = '+ Transfer';
      transferBtn.addEventListener('click', () => openTransferModal(null));
      wrap.appendChild(transferBtn);
    }

    // Pay periods view also gets a "Generate" button for semi-monthly auto-fill.
    if (viewId === 'payperiods') {
      const genBtn = document.createElement('button');
      genBtn.type = 'button';
      genBtn.className = 'btn btn-ghost btn-sm';
      genBtn.textContent = 'Generate';
      genBtn.addEventListener('click', openGeneratePeriodsModal);
      wrap.appendChild(genBtn);
    }

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn btn-ghost btn-sm';
    addBtn.textContent = addLabel;
    addBtn.addEventListener('click', handlers[viewId]);
    wrap.appendChild(addBtn);

    return wrap;
  }

  // ── Generate semi-monthly pay periods ──────────────────────────────────────
  // Generates 1st–15th and 16th–last-day periods for every month in the range,
  // skipping any that would overlap an existing period.

  function semimonthlyPeriodsInRange(fromYYYYMM, toYYYYMM) {
    const results = [];
    let [y, m] = fromYYYYMM.split('-').map(Number);
    const [ty, tm] = toYYYYMM.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) {
      const mm  = String(m).padStart(2, '0');
      const last = new Date(y, m, 0).getDate();
      results.push({ startDate: `${y}-${mm}-01`, endDate: `${y}-${mm}-15` });
      results.push({ startDate: `${y}-${mm}-16`, endDate: `${y}-${mm}-${last}` });
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return results;
  }

  function openGeneratePeriodsModal() {
    const b = getBudget();
    const existing = b.payPeriods || [];
    const txns = b.transactions || [];

    // Start from earliest transaction or existing period, whichever is earlier.
    const allStarts = [
      ...existing.map((p) => p.startDate),
      ...txns.map((t) => t.date),
    ].filter(Boolean).sort();
    const earliest = allStarts[0] || todayKey();
    const fromYYYYMM = earliest.slice(0, 7);

    // Generate through 2 months from today.
    const today = todayKey();
    const toDate = new Date(today);
    toDate.setMonth(toDate.getMonth() + 2);
    const toYYYYMM = toDate.toISOString().slice(0, 7);

    const candidates = semimonthlyPeriodsInRange(fromYYYYMM, toYYYYMM);

    // Filter out any that overlap an existing period.
    const toCreate = candidates.filter((c) =>
      !existing.some((p) => c.startDate <= p.endDate && c.endDate >= p.startDate)
    );

    const fromLabel = fmtDateShort(candidates[0].startDate);
    const toLabel   = fmtDateShort(candidates[candidates.length - 1].endDate);

    const body = document.createElement('div');
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = 'var(--space-3)';

    const desc = document.createElement('p');
    desc.style.fontSize = 'var(--fs-sm)';
    desc.style.color = 'var(--text-muted)';
    desc.style.margin = '0';

    if (!toCreate.length) {
      desc.textContent = 'All semi-monthly periods in this range already exist. Nothing to generate.';
      body.appendChild(desc);
      Pike.modal.open('Generate pay periods', body);
      return;
    }

    desc.textContent = `This will create ${toCreate.length} semi-monthly periods (1st–15th and 16th–last day) from ${fromLabel} through ${toLabel}, skipping any that already exist.`;
    body.appendChild(desc);

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn btn-primary btn-sm';
    confirmBtn.textContent = `Create ${toCreate.length} periods`;
    confirmBtn.addEventListener('click', () => {
      Pike.state.commit((d) => {
        if (!d.budget.payPeriods) d.budget.payPeriods = [];
        toCreate.forEach((c) => {
          const mm = c.startDate.slice(5, 7);
          const day = parseInt(c.startDate.slice(8));
          const monthName = new Date(c.startDate + 'T12:00:00').toLocaleString('en-US', { month: 'short' });
          const half = day === 1 ? `${monthName} 1–15` : `${monthName} 16–${parseInt(c.endDate.slice(8))}`;
          d.budget.payPeriods.push({
            id:                   'pp_' + Math.random().toString(36).slice(2, 9),
            label:                half,
            startDate:            c.startDate,
            endDate:              c.endDate,
            expectedIncomeCents:  0,
            allocations:          [],
            notes:                '',
          });
        });
        d.budget.payPeriods.sort((a, b) => a.startDate.localeCompare(b.startDate));
      });
      Pike.modal.close();
    });
    body.appendChild(confirmBtn);

    Pike.modal.open('Generate pay periods', body);
  }

  function buildEmpty(text) {
    const p = document.createElement('p');
    p.className = 'budget-empty';
    p.textContent = text;
    return p;
  }

  function buildPlaceholder() {
    const ph = document.createElement('div');
    ph.className = 'budget-placeholder';
    const eyebrow = document.createElement('p');
    eyebrow.className = 'budget-placeholder-eyebrow';
    eyebrow.textContent = 'Coming next';
    const body = document.createElement('p');
    body.textContent = 'This view ships in the next phase.';
    ph.appendChild(eyebrow);
    ph.appendChild(body);
    return ph;
  }

  // ─── Accounts ────────────────────────────────────────────────────────────────

  function buildAccountsView() {
    const accounts = (getBudget().accounts || []).filter((a) => !a.archived);
    const wrap = document.createElement('div');
    wrap.className = 'budget-list';
    if (!accounts.length) {
      wrap.appendChild(buildEmpty('No accounts yet. Tap + Account to add your first one.'));
    } else {
      accounts
        .slice()
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((acc) => wrap.appendChild(buildAccountRow(acc)));
    }

    // Plaid connected-banks section — populated asynchronously by plaid.js.
    // The div is always present so Pike.plaid.render() can target it after
    // this function returns.
    const plaidSlot = document.createElement('div');
    plaidSlot.id = 'plaid-accounts-section';
    wrap.appendChild(plaidSlot);

    return wrap;
  }

  function buildAccountRow(acc) {
    const row = document.createElement('div');
    row.className = 'budget-row';

    const main = document.createElement('div');
    main.className = 'budget-row-main';
    const name = document.createElement('h3');
    name.className = 'budget-row-name';
    name.textContent = acc.name;
    const meta = document.createElement('p');
    meta.className = 'budget-row-meta';
    const typeLabel = (ACCOUNT_TYPES.find((t) => t.id === acc.type) || {}).label || acc.type;
    meta.textContent = typeLabel + (acc.institution ? ' · ' + acc.institution : '');
    main.appendChild(name);
    main.appendChild(meta);

    const amountWrap = document.createElement('div');
    amountWrap.className = 'budget-row-amount-wrap';
    const amount = document.createElement('div');
    amount.className = 'budget-row-amount';
    const liveBalance = accountBalance(acc);
    amount.textContent = formatCents(liveBalance);
    if (liveBalance < 0) amount.classList.add('is-negative');
    amountWrap.appendChild(amount);
    const stateLine = document.createElement('span');
    stateLine.className = 'budget-row-amount-state';
    stateLine.textContent = accountBalanceState(acc);
    amountWrap.appendChild(stateLine);

    const actions = document.createElement('div');
    actions.className = 'budget-row-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'budget-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openAccountModal(acc));
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'budget-action-btn';
    archiveBtn.textContent = 'Archive';
    archiveBtn.addEventListener('click', () => archiveAccount(acc.id));
    actions.appendChild(editBtn);
    actions.appendChild(archiveBtn);

    row.appendChild(main);
    row.appendChild(amountWrap);
    row.appendChild(actions);
    return row;
  }

  function openAccountModal(existing) {
    const isEdit = !!existing;
    const acc = existing || {};

    const form = document.createElement('form');
    form.className = 'budget-form';
    form.autocomplete = 'off';
    form.innerHTML = `
      <label class="budget-field">
        <span>Name</span>
        <input type="text" class="input" name="name" required maxlength="80"
               value="${esc(acc.name || '')}" placeholder="e.g. Wells Fargo Spending Checking">
      </label>
      <label class="budget-field">
        <span>Type</span>
        <select class="input" name="type" required>
          ${ACCOUNT_TYPES.map((t) =>
            `<option value="${t.id}" ${acc.type === t.id ? 'selected' : ''}>${t.label}</option>`
          ).join('')}
        </select>
      </label>
      <label class="budget-field">
        <span>Institution (optional)</span>
        <input type="text" class="input" name="institution" maxlength="80"
               value="${esc(acc.institution || '')}" placeholder="e.g. Wells Fargo">
      </label>
      <label class="budget-field">
        <span>Starting balance</span>
        <input type="text" inputmode="decimal" class="input" name="startingBalance"
               value="${esc(inputValueFromCents(acc.startingBalanceCents))}" placeholder="0.00">
      </label>
      <p class="budget-form-hint">For credit cards and loans, enter what you owe as a positive number — Pike will track it as a debt.</p>
      <label class="budget-field">
        <span>Starting balance as of</span>
        <input type="date" class="input" name="startingBalanceDate" required
               value="${esc(acc.startingBalanceDate || todayKey())}">
      </label>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add account'}</button>
      </div>
    `;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      if (!name) return;
      const type = String(fd.get('type') || 'checking');
      const institution = String(fd.get('institution') || '').trim();
      let startingBalanceCents = centsFromInput(String(fd.get('startingBalance') || '0'));
      if (DEBT_ACCOUNT_TYPES.includes(type) && startingBalanceCents > 0) {
        startingBalanceCents = -startingBalanceCents;
      }
      const startingBalanceDate = String(fd.get('startingBalanceDate') || todayKey());

      global.Pike.state.commit((d) => {
        if (!d.budget.accounts) d.budget.accounts = [];
        if (isEdit) {
          const a = d.budget.accounts.find((x) => x.id === existing.id);
          if (a) {
            a.name = name;
            a.type = type;
            a.institution = institution;
            a.startingBalanceCents = startingBalanceCents;
            a.startingBalanceDate = startingBalanceDate;
          }
        } else {
          d.budget.accounts.push({
            id: uid('acc'),
            name, type, institution,
            startingBalanceCents,
            startingBalanceDate,
            archived: false,
            plaidItemId: null,
            plaidAccountId: null,
            lastSyncedAt: null,
          });
        }
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({
      title: isEdit ? 'Edit account' : 'Add account',
      body: form,
    });
  }

  function archiveAccount(id) {
    const acc = (getBudget().accounts || []).find((x) => x.id === id);
    if (!acc) return;
    if (!confirm(`Archive "${acc.name}"? It'll be hidden from active lists and pickers, but its history stays intact.`)) return;
    global.Pike.state.commit((d) => {
      const a = (d.budget.accounts || []).find((x) => x.id === id);
      if (a) a.archived = true;
    });
  }

  // ─── Debts ───────────────────────────────────────────────────────────────────

  function buildDebtsView() {
    const debts = getBudget().debts || [];
    const wrap = document.createElement('div');
    wrap.className = 'budget-list';
    if (!debts.length) {
      wrap.appendChild(buildEmpty('No debts tracked yet. Tap + Debt to add a credit card or loan.'));
      return wrap;
    }
    debts.forEach((dbt) => wrap.appendChild(buildDebtRow(dbt)));
    return wrap;
  }

  function buildDebtRow(dbt) {
    const row = document.createElement('div');
    row.className = 'budget-row';

    const accounts = getBudget().accounts || [];
    const linked = accounts.find((a) => a.id === dbt.accountId);

    const main = document.createElement('div');
    main.className = 'budget-row-main';
    const name = document.createElement('h3');
    name.className = 'budget-row-name';
    name.textContent = linked ? linked.name : '(account missing)';
    const meta = document.createElement('p');
    meta.className = 'budget-row-meta';
    const kindLabel = (DEBT_KINDS.find((k) => k.id === dbt.kind) || {}).label || dbt.kind;
    const apr = dbt.aprBps ? (dbt.aprBps / 100).toFixed(2) + '% APR' : '';
    const min = dbt.minimumPaymentCents ? `min ${formatCents(dbt.minimumPaymentCents)}/mo` : '';
    meta.textContent = [kindLabel, apr, min].filter(Boolean).join(' · ');
    main.appendChild(name);
    main.appendChild(meta);

    // Naive debt-progress line. Quiet, intentionally labeled as an estimate.
    const progressText = debtProgressLineText(dbt);
    if (progressText) {
      const progress = document.createElement('p');
      progress.className = 'budget-debt-progress';
      progress.textContent = progressText;
      main.appendChild(progress);
    }

    const amountWrap = document.createElement('div');
    amountWrap.className = 'budget-row-amount-wrap';
    const amount = document.createElement('div');
    amount.className = 'budget-row-amount';
    if (linked) {
      const owedCents = Math.abs(accountBalance(linked));
      amount.textContent = formatCents(owedCents);
      amount.classList.add('is-negative');
    } else {
      amount.textContent = '—';
    }
    amountWrap.appendChild(amount);
    if (linked) {
      const stateLine = document.createElement('span');
      stateLine.className = 'budget-row-amount-state';
      stateLine.textContent = accountBalanceState(linked);
      amountWrap.appendChild(stateLine);
    }
    // Paid-this-period sub-line
    const paid = debtPaidForDebtThisPeriod(dbt);
    if (paid > 0) {
      const paidLine = document.createElement('span');
      paidLine.className = 'budget-row-amount-state budget-row-amount-paid';
      paidLine.textContent = `Paid this period: ${formatCents(paid)}`;
      amountWrap.appendChild(paidLine);
    }

    const actions = document.createElement('div');
    actions.className = 'budget-row-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'budget-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openDebtModal(dbt));
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'budget-action-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeDebt(dbt.id));
    actions.appendChild(editBtn);
    actions.appendChild(removeBtn);

    row.appendChild(main);
    row.appendChild(amountWrap);
    row.appendChild(actions);
    return row;
  }

  function openDebtModal(existing) {
    const isEdit = !!existing;
    const dbt = existing || {};
    const accounts = (getBudget().accounts || []).filter(
      (a) => !a.archived && DEBT_ACCOUNT_TYPES.includes(a.type)
    );

    if (!accounts.length && !isEdit) {
      global.Pike.modal.open({
        title: 'Add a debt',
        body: '<p style="margin:0;color:var(--text-muted);">First add a credit-card or loan account in <strong>Accounts</strong>. A debt links to one of those accounts so its balance and payments stay in sync.</p>' +
              '<div class="pike-modal-actions"><button type="button" class="btn btn-primary" data-modal-close="1">OK</button></div>',
      });
      return;
    }

    const form = document.createElement('form');
    form.className = 'budget-form';
    form.autocomplete = 'off';
    form.innerHTML = `
      <label class="budget-field">
        <span>Linked account</span>
        <select class="input" name="accountId" required ${isEdit ? 'disabled' : ''}>
          ${accounts.map((a) =>
            `<option value="${esc(a.id)}" ${dbt.accountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`
          ).join('')}
          ${isEdit && !accounts.find((a) => a.id === dbt.accountId)
            ? `<option value="${esc(dbt.accountId)}" selected>(linked account no longer available)</option>` : ''}
        </select>
      </label>
      <label class="budget-field">
        <span>Kind</span>
        <select class="input" name="kind" required>
          ${DEBT_KINDS.map((k) =>
            `<option value="${k.id}" ${dbt.kind === k.id ? 'selected' : ''}>${k.label}</option>`
          ).join('')}
        </select>
      </label>
      <label class="budget-field">
        <span>APR (%)</span>
        <input type="text" inputmode="decimal" class="input" name="apr"
               value="${esc(dbt.aprBps != null ? (dbt.aprBps / 100).toFixed(2) : '')}" placeholder="e.g. 22.99">
      </label>
      <label class="budget-field">
        <span>Minimum monthly payment</span>
        <input type="text" inputmode="decimal" class="input" name="minimumPayment"
               value="${esc(inputValueFromCents(dbt.minimumPaymentCents))}" placeholder="0.00">
      </label>
      <label class="budget-field">
        <span>Target payoff date (optional)</span>
        <input type="date" class="input" name="targetPayoffDate"
               value="${esc(dbt.targetPayoffDate || '')}">
      </label>
      <label class="budget-field">
        <span>Notes (optional)</span>
        <textarea class="input" name="notes" rows="2" placeholder="Anything to remember about this debt…">${esc(dbt.notes || '')}</textarea>
      </label>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add debt'}</button>
      </div>
    `;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const accountId = String(fd.get('accountId') || (isEdit ? dbt.accountId : ''));
      if (!accountId) return;
      const kind = String(fd.get('kind') || 'other');
      const aprRaw = String(fd.get('apr') || '').trim();
      const aprBps = aprRaw === '' ? 0 : Math.round(Number(aprRaw.replace(/[^\d.\-]/g, '')) * 100);
      const minimumPaymentCents = centsFromInput(String(fd.get('minimumPayment') || '0'));
      const targetPayoffDate = String(fd.get('targetPayoffDate') || '').trim() || null;
      const notes = String(fd.get('notes') || '').trim();

      global.Pike.state.commit((d) => {
        if (!d.budget.debts) d.budget.debts = [];
        if (isEdit) {
          const x = d.budget.debts.find((y) => y.id === existing.id);
          if (x) {
            x.kind = kind;
            x.aprBps = aprBps;
            x.minimumPaymentCents = minimumPaymentCents;
            x.targetPayoffDate = targetPayoffDate;
            x.notes = notes;
          }
        } else {
          d.budget.debts.push({
            id: uid('dbt'),
            accountId, kind, aprBps,
            minimumPaymentCents,
            targetPayoffDate,
            notes,
          });
        }
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({
      title: isEdit ? 'Edit debt' : 'Add debt',
      body: form,
    });
  }

  function removeDebt(id) {
    if (!confirm('Remove this debt entry? The linked account stays — only the debt metadata (APR, minimum, target) is removed.')) return;
    global.Pike.state.commit((d) => {
      d.budget.debts = (d.budget.debts || []).filter((x) => x.id !== id);
    });
  }

  // ─── Pay periods ─────────────────────────────────────────────────────────────

  function buildPayPeriodsView() {
    // If a period is selected, render the per-period detail (sub-drilldown).
    if (activePeriodId) {
      const periods = getBudget().payPeriods || [];
      const period = periods.find((p) => p.id === activePeriodId);
      if (period) return buildPayPeriodDetailView(period);
      // Period was removed externally; fall through to the list.
      activePeriodId = null;
    }

    const periods = getBudget().payPeriods || [];
    const wrap = document.createElement('div');
    wrap.className = 'budget-list';
    if (!periods.length) {
      wrap.appendChild(buildEmpty('No pay periods yet. Tap + Pay period to set up your first paycheck envelope.'));
      return wrap;
    }
    const today = todayKey();
    const decorated = periods.map((p) => {
      let status;
      if (today >= p.startDate && today <= p.endDate) status = 'active';
      else if (p.startDate > today) status = 'upcoming';
      else status = 'past';
      return { p, status };
    });
    decorated.sort((a, b) => {
      const order = { active: 0, upcoming: 1, past: 2 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      if (a.status === 'past') return b.p.endDate.localeCompare(a.p.endDate);
      return a.p.startDate.localeCompare(b.p.startDate);
    });
    decorated.forEach(({ p, status }) => wrap.appendChild(buildPayPeriodRow(p, status)));
    return wrap;
  }

  function buildPayPeriodRow(period, status) {
    const row = document.createElement('div');
    row.className = 'budget-row budget-row-period is-' + status + ' is-clickable';
    row.setAttribute('role', 'button');
    row.setAttribute('tabindex', '0');
    row.setAttribute('aria-label', `Open ${period.label || 'period'} detail`);

    const main = document.createElement('div');
    main.className = 'budget-row-main';
    const name = document.createElement('h3');
    name.className = 'budget-row-name';
    name.textContent = period.label || `${fmtDateShort(period.startDate)} paycheck`;

    const statusLabel = document.createElement('span');
    statusLabel.className = 'budget-row-status budget-row-status-' + status;
    statusLabel.textContent = status === 'active' ? 'Active' : status === 'upcoming' ? 'Upcoming' : 'Past';
    name.appendChild(statusLabel);

    const meta = document.createElement('p');
    meta.className = 'budget-row-meta';
    const allocCount = (period.allocations || []).length;
    meta.textContent = `${fmtDateShort(period.startDate)} – ${fmtDateShort(period.endDate)} · ${allocCount} ${allocCount === 1 ? 'allocation' : 'allocations'}`;
    main.appendChild(name);
    main.appendChild(meta);

    const amountWrap = document.createElement('div');
    amountWrap.className = 'budget-row-amount-wrap';
    const amount = document.createElement('div');
    amount.className = 'budget-row-amount';
    amount.textContent = formatCents(period.expectedIncomeCents || 0);
    amountWrap.appendChild(amount);
    // Spent (or net credit) in this period
    const spent = periodSpendingCents(period);
    if (spent > 0) {
      const spentLine = document.createElement('span');
      spentLine.className = 'budget-row-amount-state';
      spentLine.textContent = `Spent ${formatCents(spent)}`;
      amountWrap.appendChild(spentLine);
    } else if (spent < 0) {
      row.classList.add('is-net-credit');
      const creditLine = document.createElement('span');
      creditLine.className = 'budget-row-amount-state is-credit';
      creditLine.textContent = `Net credit ${formatCents(Math.abs(spent))}`;
      amountWrap.appendChild(creditLine);
    }

    const actions = document.createElement('div');
    actions.className = 'budget-row-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'budget-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); openPayPeriodModal(period); });
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'budget-action-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removePayPeriod(period.id); });
    actions.appendChild(editBtn);
    actions.appendChild(removeBtn);

    row.appendChild(main);
    row.appendChild(amountWrap);
    row.appendChild(actions);

    // Open detail on row click / Enter / Space.
    function openDetail() { activePeriodId = period.id; render(); }
    row.addEventListener('click', openDetail);
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); }
    });

    return row;
  }

  // ── Per-period detail view (sub-drilldown within Pay periods) ─────────────
  function buildPayPeriodDetailView(period) {
    const wrap = document.createElement('div');
    wrap.className = 'budget-period-detail';

    // Inline sub-back: returns to the Pay periods LIST (not all the way to dashboard).
    const subBack = document.createElement('button');
    subBack.type = 'button';
    subBack.className = 'budget-back budget-sub-back';
    subBack.textContent = '← Back to Pay periods';
    subBack.addEventListener('click', () => { activePeriodId = null; render(); });
    wrap.appendChild(subBack);

    // Header — label + status pill + Edit/Remove buttons.
    const today = todayKey();
    let status;
    if (today >= period.startDate && today <= period.endDate) status = 'active';
    else if (period.startDate > today) status = 'upcoming';
    else status = 'past';

    const header = document.createElement('header');
    header.className = 'budget-period-detail-header';
    const title = document.createElement('h3');
    title.className = 'budget-period-detail-title';
    title.textContent = period.label || `${fmtDateShort(period.startDate)} paycheck`;
    const statusPill = document.createElement('span');
    statusPill.className = 'budget-row-status budget-row-status-' + status;
    statusPill.textContent = status === 'active' ? 'Active' : status === 'upcoming' ? 'Upcoming' : 'Past';
    title.appendChild(statusPill);
    header.appendChild(title);

    const headerActions = document.createElement('div');
    headerActions.className = 'budget-period-detail-actions';
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-ghost btn-sm';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openPayPeriodModal(period));
    headerActions.appendChild(editBtn);
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-ghost btn-sm';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      removePayPeriod(period.id);
      activePeriodId = null;
    });
    headerActions.appendChild(removeBtn);
    header.appendChild(headerActions);
    wrap.appendChild(header);

    // Summary line: dates + spent of expected.
    const expected = period.expectedIncomeCents || 0;
    const spent = periodSpendingCents(period);
    const remaining = expected - spent;
    const summary = document.createElement('p');
    summary.className = 'budget-period-summary';
    summary.textContent = `${fmtDateShort(period.startDate)} – ${fmtDateShort(period.endDate)} · ${formatCents(spent)} spent of ${formatCents(expected)} · ${formatCents(remaining)} left`;
    wrap.appendChild(summary);

    // Per-category breakdown.
    wrap.appendChild(buildCategoryBreakdownList(period));

    // Debt-paid line in this period (shown only when nonzero).
    const debtPaid = debtPaidThisPeriodCents(period);
    if (debtPaid > 0) {
      const debtLine = document.createElement('p');
      debtLine.className = 'budget-period-debt-paid';
      debtLine.textContent = `${formatCents(debtPaid)} paid toward debt this period`;
      wrap.appendChild(debtLine);
    }

    return wrap;
  }

  function buildCategoryBreakdownList(period) {
    const wrap = document.createElement('section');
    wrap.className = 'budget-cat-section';

    const head = document.createElement('h4');
    head.className = 'budget-cat-section-head';
    head.textContent = 'Categories';
    wrap.appendChild(head);

    const allCats = (getBudget().categories || []).filter((c) => !c.archived);
    const allocList = (period.allocations || []);
    const allocByCatId = new Map(allocList.map((a) => [a.categoryId, a.amountCents]));
    const allocCatIds = new Set(allocList.map((a) => a.categoryId));
    const spentCatIds = categoriesWithSpendingInPeriod(period);

    const list = document.createElement('div');
    list.className = 'budget-cat-list';

    let anyAllocated = false;

    // 1) Allocated categories first (in allocation order).
    allocList.forEach((alloc) => {
      const cat = allCats.find((c) => c.id === alloc.categoryId);
      if (!cat) return;
      anyAllocated = true;
      list.appendChild(buildCategoryBreakdownRow({
        cat,
        allocatedCents: alloc.amountCents,
        spentCents: categorySpentInPeriod(cat.id, period),
        unallocated: false,
      }));
    });

    if (!anyAllocated) {
      const empty = document.createElement('p');
      empty.className = 'budget-empty budget-cat-empty';
      empty.textContent = 'No allocations yet for this period. Tap Edit to add some.';
      list.appendChild(empty);
    }

    // 2) Unallocated categories with NET POSITIVE spending. Pure-credit
    //    (refund-only) categories are excluded — they aren't unbudgeted
    //    spending, just leftover refund credits we don't surface here.
    const unallocatedSpent = Array.from(spentCatIds).filter((id) => {
      if (allocCatIds.has(id)) return false;
      return categorySpentInPeriod(id, period) > 0;
    });
    if (unallocatedSpent.length) {
      const subhead = document.createElement('p');
      subhead.className = 'budget-cat-subhead';
      subhead.textContent = 'Unallocated spending';
      list.appendChild(subhead);
      unallocatedSpent.forEach((catId) => {
        const cat = allCats.find((c) => c.id === catId);
        if (!cat) return;
        list.appendChild(buildCategoryBreakdownRow({
          cat,
          allocatedCents: 0,
          spentCents: categorySpentInPeriod(catId, period),
          unallocated: true,
        }));
      });
    }

    wrap.appendChild(list);
    return wrap;
  }

  function buildCategoryBreakdownRow({ cat, allocatedCents, spentCents, unallocated }) {
    const row = document.createElement('div');
    row.className = 'budget-cat-row' + (unallocated ? ' is-unallocated' : '');

    const head = document.createElement('div');
    head.className = 'budget-cat-row-head';
    const name = document.createElement('span');
    name.className = 'budget-cat-name';
    name.textContent = cat.name;
    head.appendChild(name);

    const status = document.createElement('span');
    status.className = 'budget-cat-status';
    if (unallocated) {
      // Caller filters out non-positive unallocated rows — spentCents > 0 here.
      status.classList.add('is-over');
      status.textContent = `${formatCents(spentCents)} unbudgeted`;
    } else if (spentCents < 0) {
      // Refunds exceeded spending in this category → calm sage credit treatment.
      status.classList.add('is-credit');
      status.textContent = `${formatCents(Math.abs(spentCents))} credit`;
    } else {
      const remaining = allocatedCents - spentCents;
      if (remaining < 0) {
        status.classList.add('is-over');
        status.textContent = `Over by ${formatCents(Math.abs(remaining))}`;
      } else if (spentCents === 0) {
        status.classList.add('is-untouched');
        status.textContent = `Untouched`;
      } else {
        status.textContent = `${formatCents(remaining)} left`;
      }
    }
    head.appendChild(status);
    row.appendChild(head);

    // Amount sub-line
    const amounts = document.createElement('p');
    amounts.className = 'budget-cat-amounts';
    if (unallocated) {
      amounts.textContent = `${formatCents(spentCents)} spent · no allocation`;
    } else if (spentCents < 0) {
      amounts.textContent = `Refunds exceed spending by ${formatCents(Math.abs(spentCents))} · ${formatCents(allocatedCents)} allocated`;
    } else {
      amounts.textContent = `${formatCents(spentCents)} spent of ${formatCents(allocatedCents)}`;
    }
    row.appendChild(amounts);

    // Slim progress bar — empty (0%) when net credit, since nothing has been
    // spent on net. Over-allocation gets the amber warning fill.
    const bar = document.createElement('div');
    bar.className = 'budget-cat-bar';
    const fill = document.createElement('div');
    fill.className = 'budget-cat-bar-fill';
    let pct = 0;
    let over = false;
    if (unallocated) {
      pct = 100;
      over = true;
    } else if (allocatedCents > 0 && spentCents > 0) {
      pct = Math.max(0, Math.min(100, Math.round((spentCents / allocatedCents) * 100)));
      over = spentCents > allocatedCents;
    }
    fill.style.width = pct + '%';
    if (over) fill.classList.add('is-over');
    bar.appendChild(fill);
    row.appendChild(bar);

    return row;
  }

  function openPayPeriodModal(existing) {
    const isEdit = !!existing;
    const period = existing || {};
    const categories = (getBudget().categories || [])
      .filter((c) => !c.archived && c.group !== 'income' && c.group !== 'transfer')
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));

    const form = document.createElement('form');
    form.className = 'budget-form';
    form.autocomplete = 'off';

    const headerHtml = `
      <label class="budget-field">
        <span>Label</span>
        <input type="text" class="input" name="label" maxlength="80"
               value="${esc(period.label || '')}" placeholder="e.g. May 1 paycheck">
      </label>
      <div class="budget-field-row">
        <label class="budget-field">
          <span>Start date</span>
          <input type="date" class="input" name="startDate" required
                 value="${esc(period.startDate || todayKey())}">
        </label>
        <label class="budget-field">
          <span>End date</span>
          <input type="date" class="input" name="endDate" required
                 value="${esc(period.endDate || '')}">
        </label>
      </div>
      <label class="budget-field">
        <span>Expected income</span>
        <input type="text" inputmode="decimal" class="input" name="expectedIncome"
               value="${esc(inputValueFromCents(period.expectedIncomeCents))}" placeholder="0.00">
      </label>
    `;
    form.innerHTML = headerHtml;

    // Overlap warning panel — sits between dates and allocations.
    const overlapBox = document.createElement('div');
    overlapBox.className = 'budget-overlap-warning';
    overlapBox.hidden = true;
    form.appendChild(overlapBox);

    function checkOverlap() {
      const startDate = form.querySelector('input[name="startDate"]').value;
      const endDate = form.querySelector('input[name="endDate"]').value;
      if (!startDate || !endDate || endDate < startDate) {
        overlapBox.hidden = true;
        return;
      }
      const candidate = { id: existing ? existing.id : null, startDate, endDate };
      const conflict = findOverlappingPeriod(candidate);
      if (!conflict) {
        overlapBox.hidden = true;
        overlapBox.innerHTML = '';
        return;
      }
      overlapBox.hidden = false;
      overlapBox.innerHTML = `
        <p class="budget-overlap-head">Overlap detected</p>
        <p class="budget-overlap-body">
          This period overlaps <strong>${esc(conflict.label || 'an existing period')}</strong>
          (${esc(fmtDateShort(conflict.startDate))} – ${esc(fmtDateShort(conflict.endDate))}).
          Transactions in the overlapping range will count toward whichever period was created first.
          You can save anyway.
        </p>
      `;
    }

    form.querySelector('input[name="startDate"]').addEventListener('change', checkOverlap);
    form.querySelector('input[name="endDate"]').addEventListener('change', checkOverlap);

    // Allocations editor
    const allocSection = document.createElement('div');
    allocSection.className = 'budget-allocations';
    const allocHeader = document.createElement('div');
    allocHeader.className = 'budget-allocations-header';
    const allocTitle = document.createElement('span');
    allocTitle.className = 'budget-field-label';
    allocTitle.textContent = 'Allocations';
    const allocAddBtn = document.createElement('button');
    allocAddBtn.type = 'button';
    allocAddBtn.className = 'budget-action-btn';
    allocAddBtn.textContent = '+ Allocation';
    allocHeader.appendChild(allocTitle);
    allocHeader.appendChild(allocAddBtn);

    const allocList = document.createElement('div');
    allocList.className = 'budget-allocation-list';
    const totalLine = document.createElement('p');
    totalLine.className = 'budget-allocations-total';

    const startingAllocations = (period.allocations || []).map((a) => ({
      categoryId: a.categoryId,
      amountCents: a.amountCents,
    }));

    function recalcTotal() {
      const rows = allocList.querySelectorAll('.budget-allocation-row');
      let sum = 0;
      rows.forEach((r) => {
        const v = r.querySelector('input[name="allocAmount"]')?.value || '0';
        sum += centsFromInput(v);
      });
      const inc = centsFromInput(form.querySelector('input[name="expectedIncome"]')?.value || '0');
      totalLine.textContent = `Allocated ${formatCents(sum)} of ${formatCents(inc)} expected`;
      totalLine.classList.toggle('is-over', inc > 0 && sum > inc);
    }

    function addAllocationRow(allocation) {
      const r = document.createElement('div');
      r.className = 'budget-allocation-row';
      r.innerHTML = `
        <select class="input" name="allocCategory">
          ${categories.map((c) =>
            `<option value="${esc(c.id)}" ${allocation.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
          ).join('')}
        </select>
        <input type="text" inputmode="decimal" class="input" name="allocAmount"
               value="${esc(inputValueFromCents(allocation.amountCents || 0))}" placeholder="0.00">
        <button type="button" class="budget-action-btn budget-allocation-remove" aria-label="Remove allocation">✕</button>
      `;
      r.querySelector('input[name="allocAmount"]').addEventListener('input', recalcTotal);
      r.querySelector('.budget-allocation-remove').addEventListener('click', () => {
        r.remove();
        recalcTotal();
      });
      allocList.appendChild(r);
    }

    form.appendChild(allocSection);
    allocSection.appendChild(allocHeader);
    allocSection.appendChild(allocList);
    allocSection.appendChild(totalLine);

    if (categories.length) {
      startingAllocations.forEach(addAllocationRow);
    } else {
      const noCats = document.createElement('p');
      noCats.className = 'budget-form-hint';
      noCats.textContent = 'No spending categories available yet — categories seed automatically on first run.';
      allocList.appendChild(noCats);
    }

    allocAddBtn.addEventListener('click', () => {
      if (!categories.length) return;
      addAllocationRow({ categoryId: categories[0].id, amountCents: 0 });
      recalcTotal();
    });
    form.querySelector('input[name="expectedIncome"]').addEventListener('input', recalcTotal);

    const actions = document.createElement('div');
    actions.className = 'pike-modal-actions';
    actions.innerHTML = `
      <button type="button" class="btn" data-modal-close="1">Cancel</button>
      <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add pay period'}</button>
    `;
    form.appendChild(actions);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const label = String(fd.get('label') || '').trim();
      const startDate = String(fd.get('startDate') || '').trim();
      const endDate = String(fd.get('endDate') || '').trim();
      if (!startDate || !endDate) return;
      if (endDate < startDate) {
        alert('End date must be on or after start date.');
        return;
      }
      const expectedIncomeCents = centsFromInput(String(fd.get('expectedIncome') || '0'));

      const allocations = [];
      allocList.querySelectorAll('.budget-allocation-row').forEach((r) => {
        const categoryId = r.querySelector('select[name="allocCategory"]').value;
        const amountCents = centsFromInput(r.querySelector('input[name="allocAmount"]').value);
        if (categoryId && amountCents > 0) {
          allocations.push({ categoryId, amountCents });
        }
      });

      global.Pike.state.commit((d) => {
        if (!d.budget.payPeriods) d.budget.payPeriods = [];
        if (isEdit) {
          const p = d.budget.payPeriods.find((x) => x.id === existing.id);
          if (p) {
            p.label = label || p.label;
            p.startDate = startDate;
            p.endDate = endDate;
            p.expectedIncomeCents = expectedIncomeCents;
            p.allocations = allocations;
          }
        } else {
          d.budget.payPeriods.push({
            id: uid('pp'),
            label: label || `${fmtDateShort(startDate)} paycheck`,
            startDate, endDate,
            expectedIncomeCents,
            allocations,
            notes: '',
          });
        }
      });
      global.Pike.modal.close();
    });

    recalcTotal();
    checkOverlap();

    global.Pike.modal.open({
      title: isEdit ? 'Edit pay period' : 'Add pay period',
      body: form,
    });
  }

  function removePayPeriod(id) {
    const p = (getBudget().payPeriods || []).find((x) => x.id === id);
    if (!p) return;
    if (!confirm(`Remove the pay period "${p.label}"? Transactions in its date range stay; they just won't be grouped under this period.`)) return;
    global.Pike.state.commit((d) => {
      d.budget.payPeriods = (d.budget.payPeriods || []).filter((x) => x.id !== id);
    });
  }

  // ─── Transactions ────────────────────────────────────────────────────────────

  function buildTransactionsView() {
    const wrap = document.createElement('div');
    wrap.className = 'budget-tx-wrap';

    // Filter pills
    const filterBar = document.createElement('div');
    filterBar.className = 'budget-tx-filters';
    [
      { id: 'all',            label: 'All' },
      { id: 'unassigned',     label: 'Unassigned' },
      { id: 'uncategorized',  label: 'Uncategorized' },
    ].forEach(({ id, label }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'budget-filter-pill' + (txFilter === id ? ' is-active' : '');
      btn.textContent = label;
      btn.addEventListener('click', () => {
        txFilter = id;
        selectedTxnIds = new Set();
        render();
      });
      filterBar.appendChild(btn);
    });
    wrap.appendChild(filterBar);

    const allTxns = getBudget().transactions || [];
    let visible = allTxns.filter((t) => !t.plaidRemoved);
    if (txFilter === 'unassigned') {
      visible = visible.filter((t) => !periodForDate(t.date));
    } else if (txFilter === 'uncategorized') {
      visible = visible.filter((t) =>
        t.kind !== 'transfer' && t.kind !== 'debt-payment' &&
        !t.categoryId && !(Array.isArray(t.splits) && t.splits.length)
      );
    }
    // Hide inflow legs of transfers (one row per pair, the outflow leg).
    visible = visible.filter((t) => {
      if (t.kind !== 'transfer' && t.kind !== 'debt-payment') return true;
      return t.direction === 'outflow';
    });

    // Bulk actions bar — shown when any rows selected
    const bulkBar = document.createElement('div');
    bulkBar.className = 'budget-bulk-bar';
    bulkBar.id = 'budget-bulk-bar';
    bulkBar.hidden = selectedTxnIds.size === 0;
    const bulkCount = document.createElement('span');
    bulkCount.className = 'budget-bulk-count';
    bulkCount.id = 'budget-bulk-count';
    bulkCount.textContent = `${selectedTxnIds.size} selected`;
    const applyCatBtn = document.createElement('button');
    applyCatBtn.type = 'button';
    applyCatBtn.className = 'btn btn-ghost btn-sm';
    applyCatBtn.textContent = 'Apply category';
    applyCatBtn.addEventListener('click', () => openApplyCategoryModal([...selectedTxnIds]));
    const clearSelBtn = document.createElement('button');
    clearSelBtn.type = 'button';
    clearSelBtn.className = 'budget-action-btn';
    clearSelBtn.textContent = 'Clear';
    clearSelBtn.addEventListener('click', () => { selectedTxnIds = new Set(); render(); });
    bulkBar.appendChild(bulkCount);
    bulkBar.appendChild(applyCatBtn);
    bulkBar.appendChild(clearSelBtn);
    wrap.appendChild(bulkBar);

    if (!visible.length) {
      wrap.appendChild(buildEmpty(
        txFilter === 'unassigned'    ? 'No unassigned transactions.' :
        txFilter === 'uncategorized' ? 'No uncategorized transactions.' :
        'No transactions yet. Tap + Transaction to log one, or + Transfer to move money.'
      ));
      return wrap;
    }

    visible.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date);
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    const list = document.createElement('div');
    list.className = 'budget-list';
    visible.forEach((t) => list.appendChild(buildTransactionRow(t)));
    wrap.appendChild(list);
    return wrap;
  }

  function buildTransactionRow(tx) {
    const isSelected = selectedTxnIds.has(tx.id);
    const row = document.createElement('div');
    row.className = 'budget-row budget-row-tx' + (isSelected ? ' is-selected' : '');

    const accounts = getBudget().accounts || [];
    const account = accounts.find((a) => a.id === tx.accountId);
    const categories = getBudget().categories || [];

    // Checkbox for bulk selection
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'budget-tx-checkbox';
    checkbox.checked = isSelected;
    checkbox.setAttribute('aria-label', `Select ${tx.merchant || tx.description || 'transaction'}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedTxnIds.add(tx.id);
      else selectedTxnIds.delete(tx.id);
      row.classList.toggle('is-selected', checkbox.checked);
      const bar = document.getElementById('budget-bulk-bar');
      const cnt = document.getElementById('budget-bulk-count');
      if (bar) bar.hidden = selectedTxnIds.size === 0;
      if (cnt) cnt.textContent = `${selectedTxnIds.size} selected`;
    });
    row.appendChild(checkbox);

    const main = document.createElement('div');
    main.className = 'budget-row-main';

    const name = document.createElement('h3');
    name.className = 'budget-row-name';
    name.textContent = tx.merchant || tx.description || '(no name)';
    if (!periodForDate(tx.date) && (getBudget().payPeriods || []).length) {
      const pill = document.createElement('span');
      pill.className = 'budget-tx-pill-unassigned';
      pill.textContent = 'Unassigned';
      name.appendChild(pill);
    }
    if (tx.recurringBillId) {
      const recPill = document.createElement('span');
      recPill.className = 'budget-tx-pill-recurring';
      recPill.textContent = 'Recurring';
      name.appendChild(recPill);
    }
    main.appendChild(name);

    const meta = document.createElement('p');
    meta.className = 'budget-row-meta';
    const dateLabel = fmtDateShort(tx.date);
    const acctLabel = account ? account.name : '(missing account)';
    let categoryLabel = '';
    if (tx.kind === 'transfer' || tx.kind === 'debt-payment') {
      const dest = tx.transferPairId
        ? (getBudget().transactions || []).find((t) => t.transferPairId === tx.transferPairId && t.id !== tx.id)
        : null;
      const destAcct = dest ? accounts.find((a) => a.id === dest.accountId) : null;
      const arrow = destAcct ? `→ ${destAcct.name}` : (tx.kind === 'debt-payment' ? '→ Debt' : '→ Transfer');
      categoryLabel = arrow;
    } else if (Array.isArray(tx.splits) && tx.splits.length) {
      categoryLabel = `${tx.splits.length} splits`;
    } else if (tx.categoryId) {
      const cat = categories.find((c) => c.id === tx.categoryId);
      categoryLabel = cat ? cat.name : 'Uncategorized';
    } else {
      categoryLabel = 'Uncategorized';
    }
    meta.textContent = `${dateLabel} · ${acctLabel} · ${categoryLabel}`;
    main.appendChild(meta);

    const amountWrap = document.createElement('div');
    amountWrap.className = 'budget-row-amount-wrap';
    const amount = document.createElement('div');
    amount.className = 'budget-row-amount';
    const signed = signedTxCents(tx);
    amount.textContent = (signed >= 0 ? '+' : '') + formatCents(Math.abs(signed));
    if (tx.direction === 'outflow' && (tx.kind === 'spending' || tx.kind === 'refund')) amount.classList.add('is-spending');
    if (tx.kind === 'transfer' || tx.kind === 'debt-payment') amount.classList.add('is-transfer');
    if (tx.kind === 'income') amount.classList.add('is-income');
    amountWrap.appendChild(amount);
    if (tx.kind === 'debt-payment') {
      const sub = document.createElement('span');
      sub.className = 'budget-row-amount-state';
      sub.textContent = 'Debt payment';
      amountWrap.appendChild(sub);
    } else if (tx.kind === 'transfer') {
      const sub = document.createElement('span');
      sub.className = 'budget-row-amount-state';
      sub.textContent = 'Transfer';
      amountWrap.appendChild(sub);
    }

    const actions = document.createElement('div');
    actions.className = 'budget-row-actions';

    // "Recurring" button — only on spending/income/refund transactions
    if (tx.kind !== 'transfer' && tx.kind !== 'debt-payment') {
      const recBtn = document.createElement('button');
      recBtn.type = 'button';
      recBtn.className = 'budget-action-btn';
      recBtn.textContent = tx.recurringBillId ? 'Recurring ✓' : 'Recurring';
      recBtn.addEventListener('click', () => openMarkAsRecurringModal(tx));
      actions.appendChild(recBtn);
    }

    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'budget-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => {
      if (tx.kind === 'transfer' || tx.kind === 'debt-payment') {
        openTransferModal(tx);
      } else {
        openTransactionModal(tx);
      }
    });
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'budget-action-btn';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      if (tx.kind === 'transfer' || tx.kind === 'debt-payment') {
        deleteTransferPair(tx.transferPairId);
      } else {
        deleteTransaction(tx.id);
      }
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    row.appendChild(main);
    row.appendChild(amountWrap);
    row.appendChild(actions);
    return row;
  }

  // ─── Apply category (bulk) ───────────────────────────────────────────────────
  function openApplyCategoryModal(txnIds) {
    if (!txnIds.length) return;
    const b = getBudget();
    const allTxns = b.transactions || [];
    const txns = txnIds.map((id) => allTxns.find((t) => t.id === id)).filter(Boolean);
    const allCategories = (b.categories || []).filter((c) => !c.archived && c.group !== 'income' && c.group !== 'transfer');
    if (!allCategories.length) return;

    // Shared merchant — show "remember" checkbox only when all selected txns
    // have the same non-empty merchant so the rule has a reliable match value.
    const merchants = [...new Set(txns.map((t) => (t.merchant || '').trim()).filter(Boolean))];
    const sharedMerchant = merchants.length === 1 ? merchants[0] : null;

    const form = document.createElement('form');
    form.className = 'budget-form';
    form.autocomplete = 'off';
    form.innerHTML = `
      <p style="margin:0;font-size:var(--fs-sm);color:var(--text-muted);">
        Applying to ${txns.length} transaction${txns.length > 1 ? 's' : ''}.
      </p>
      <label class="budget-field">
        <span>Category</span>
        <select class="input" name="categoryId" required>
          ${allCategories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
        </select>
      </label>
      ${sharedMerchant ? `
      <label class="budget-field" style="flex-direction:row;align-items:center;gap:var(--space-3);cursor:pointer;">
        <input type="checkbox" name="remember" style="width:16px;height:16px;flex-shrink:0;accent-color:var(--accent);">
        <span style="font-size:var(--fs-sm);color:var(--text-muted);">
          Remember "${esc(sharedMerchant)}" for next time
        </span>
      </label>` : ''}
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">Apply</button>
      </div>
    `;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const categoryId = String(fd.get('categoryId') || '');
      const remember   = sharedMerchant && fd.get('remember') === 'on';
      if (!categoryId) return;

      global.Pike.state.commit((d) => {
        // Apply category to all selected transactions (never overwrites splits).
        txnIds.forEach((id) => {
          const t = (d.budget.transactions || []).find((x) => x.id === id);
          if (t && !(Array.isArray(t.splits) && t.splits.length)) {
            t.categoryId = categoryId;
            t.updatedAt  = new Date().toISOString();
          }
        });

        // Optionally create a merchantContains rule for future syncs.
        if (remember && sharedMerchant) {
          if (!d.budget.rules) d.budget.rules = [];
          const norm = sharedMerchant.toLowerCase().trim();
          // Avoid duplicate rules for the same merchant+category.
          const exists = d.budget.rules.some(
            (r) => r.matchType === 'merchantContains' &&
                   (r.matchValue || '').toLowerCase().trim() === norm &&
                   r.categoryId === categoryId
          );
          if (!exists) {
            const maxPriority = d.budget.rules.reduce((m, r) => Math.max(m, r.priority || 0), 0);
            d.budget.rules.push({
              id:         uid('rul'),
              matchType:  'merchantContains',
              matchValue: norm,
              categoryId,
              priority:   maxPriority + 10,
              enabled:    true,
            });
          }
        }
      });

      selectedTxnIds = new Set();
      global.Pike.modal.close();
    });

    global.Pike.modal.open({ title: 'Apply category', body: form });
  }

  // ─── Mark as recurring ───────────────────────────────────────────────────────
  // Creates a recurring bill template pre-filled from an existing transaction,
  // then links the transaction to that bill via recurringBillId.
  // Does NOT change the transaction's category, amount, or kind.
  function openMarkAsRecurringModal(tx) {
    const b = getBudget();
    const accounts = (b.accounts || []).filter((a) => !a.archived);
    const debtAccounts = accounts.filter((a) => DEBT_ACCOUNT_TYPES.includes(a.type));
    const allCategories = (b.categories || []).filter((c) => !c.archived);
    const existingBill = tx.recurringBillId
      ? (b.recurringBills || []).find((r) => r.id === tx.recurringBillId)
      : null;

    const form = document.createElement('form');
    form.className = 'budget-form';
    form.autocomplete = 'off';
    form.innerHTML = `
      <p style="margin:0;font-size:var(--fs-sm);color:var(--text-muted);">
        ${existingBill
          ? `This transaction is already linked to "<strong>${esc(existingBill.name)}</strong>". You can update or unlink it.`
          : 'Create a recurring bill template from this transaction. This does not change the transaction itself.'}
      </p>
      <label class="budget-field">
        <span>Name</span>
        <input type="text" class="input" name="name" required maxlength="80"
               value="${esc((existingBill || {}).name || tx.merchant || tx.description || '')}"
               placeholder="e.g. Netflix">
      </label>
      <label class="budget-field">
        <span>Expected amount</span>
        <input type="text" inputmode="decimal" class="input" name="amount" required
               value="${esc(inputValueFromCents((existingBill || {}).amountCents || tx.amountCents))}"
               placeholder="0.00">
      </label>
      <label class="budget-field">
        <span>Paid from account</span>
        <select class="input" name="accountId" required>
          ${accounts.map((a) =>
            `<option value="${esc(a.id)}" ${((existingBill || {}).accountId || tx.accountId) === a.id ? 'selected' : ''}>${esc(a.name)}</option>`
          ).join('')}
        </select>
      </label>
      <label class="budget-field">
        <span>Pays toward (optional — for debt payments only)</span>
        <select class="input" name="counterAccountId">
          <option value="">None — regular bill</option>
          ${debtAccounts.map((a) =>
            `<option value="${esc(a.id)}" ${((existingBill || {}).counterAccountId) === a.id ? 'selected' : ''}>${esc(a.name)}</option>`
          ).join('')}
        </select>
      </label>
      <label class="budget-field">
        <span>Category (optional)</span>
        <select class="input" name="categoryId">
          <option value="">None</option>
          ${allCategories.map((c) =>
            `<option value="${esc(c.id)}" ${((existingBill || {}).categoryId || tx.categoryId) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
          ).join('')}
        </select>
      </label>
      <div class="budget-field-row">
        <label class="budget-field">
          <span>Cadence</span>
          <select class="input" name="cadence">
            ${RECURRING_CADENCES.map((c) =>
              `<option value="${c.id}" ${((existingBill || {}).cadence || 'monthly') === c.id ? 'selected' : ''}>${c.label}</option>`
            ).join('')}
          </select>
        </label>
        <label class="budget-field">
          <span>Anchor date</span>
          <input type="date" class="input" name="anchorDate"
                 value="${esc((existingBill || {}).anchorDate || tx.date)}">
        </label>
      </div>
    `;

    const actions = document.createElement('div');
    actions.className = 'pike-modal-actions';
    if (existingBill) {
      const unlinkBtn = document.createElement('button');
      unlinkBtn.type = 'button';
      unlinkBtn.className = 'btn budget-modal-delete';
      unlinkBtn.textContent = 'Unlink';
      unlinkBtn.addEventListener('click', () => {
        global.Pike.state.commit((d) => {
          const t = (d.budget.transactions || []).find((x) => x.id === tx.id);
          if (t) { t.recurringBillId = null; t.updatedAt = new Date().toISOString(); }
        });
        global.Pike.modal.close();
      });
      actions.appendChild(unlinkBtn);
    }
    actions.innerHTML += `
      <button type="button" class="btn" data-modal-close="1">Cancel</button>
      <button type="submit" class="btn btn-primary">${existingBill ? 'Save' : 'Create & link'}</button>
    `;
    form.appendChild(actions);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name             = String(fd.get('name') || '').trim();
      if (!name) return;
      const amountCents      = centsFromInput(String(fd.get('amount') || '0'));
      const accountId        = String(fd.get('accountId') || '');
      const counterAccountId = String(fd.get('counterAccountId') || '') || null;
      const categoryId       = String(fd.get('categoryId') || '') || null;
      const cadence          = String(fd.get('cadence') || 'monthly');
      const anchorDate       = String(fd.get('anchorDate') || tx.date);
      const now              = new Date().toISOString();

      global.Pike.state.commit((d) => {
        if (!d.budget.recurringBills) d.budget.recurringBills = [];
        let billId;
        if (existingBill) {
          billId = existingBill.id;
          const b = d.budget.recurringBills.find((x) => x.id === billId);
          if (b) {
            b.name = name; b.amountCents = amountCents;
            b.accountId = accountId; b.counterAccountId = counterAccountId;
            b.categoryId = categoryId; b.cadence = cadence;
            b.anchorDate = anchorDate;
          }
        } else {
          billId = uid('rec');
          d.budget.recurringBills.push({
            id: billId, name, amountCents,
            categoryId, accountId, counterAccountId,
            cadence, anchorDate,
            autopay: false, notes: '', archived: false,
          });
        }
        // Link the transaction — does NOT change its category, amount, or kind.
        const t = (d.budget.transactions || []).find((x) => x.id === tx.id);
        if (t) { t.recurringBillId = billId; t.updatedAt = now; }
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({
      title: existingBill ? 'Edit recurring bill' : 'Mark as recurring',
      body: form,
    });
  }

  // ─── Transaction modal (single — not transfer) ───────────────────────────────
  // `presets` may contain: { kind, prefilledFromBill, occurrenceDate, ... }
  function openTransactionModal(existing, presets) {
    const isEdit = !!existing;
    const tx = existing || {};
    const accounts = (getBudget().accounts || []).filter((a) => !a.archived);
    const allCategories = (getBudget().categories || []).filter((c) => !c.archived);

    if (!accounts.length && !isEdit) {
      global.Pike.modal.open({
        title: 'Add a transaction',
        body: '<p style="margin:0;color:var(--text-muted);">First add an account in <strong>Accounts</strong>. Transactions need an account to land in.</p>' +
              '<div class="pike-modal-actions"><button type="button" class="btn btn-primary" data-modal-close="1">OK</button></div>',
      });
      return;
    }

    presets = presets || {};
    const initialKind = (isEdit ? tx.kind : presets.kind) || 'spending';
    const kindOption = TX_KIND_OPTIONS.find((k) => k.id === initialKind) || TX_KIND_OPTIONS[0];
    const initialDirection = (isEdit ? tx.direction : kindOption.direction);

    // Categories filter for spending vs income/refund
    function categoriesForKind(kind) {
      if (kind === 'income' || kind === 'refund') {
        return allCategories.filter((c) => c.group === 'income');
      }
      return allCategories.filter((c) => c.group !== 'income' && c.group !== 'transfer');
    }

    const initialCategories = categoriesForKind(initialKind);

    const form = document.createElement('form');
    form.className = 'budget-form';
    form.autocomplete = 'off';

    form.innerHTML = `
      <div class="budget-field-row">
        <label class="budget-field">
          <span>Date</span>
          <input type="date" class="input" name="date" required
                 value="${esc(isEdit ? tx.date : (presets.date || todayKey()))}">
        </label>
        <label class="budget-field">
          <span>Kind</span>
          <select class="input" name="kind" required>
            ${TX_KIND_OPTIONS.map((k) =>
              `<option value="${k.id}" ${initialKind === k.id ? 'selected' : ''}>${k.label}</option>`
            ).join('')}
          </select>
        </label>
      </div>
      <label class="budget-field">
        <span>Account</span>
        <select class="input" name="accountId" required>
          ${accounts.map((a) =>
            `<option value="${esc(a.id)}" ${(isEdit ? tx.accountId : presets.accountId) === a.id ? 'selected' : ''}>${esc(a.name)}</option>`
          ).join('')}
          ${isEdit && !accounts.find((a) => a.id === tx.accountId)
            ? `<option value="${esc(tx.accountId)}" selected>(account no longer available)</option>` : ''}
        </select>
      </label>
      <label class="budget-field">
        <span>Amount</span>
        <input type="text" inputmode="decimal" class="input" name="amount" required
               value="${esc(inputValueFromCents(isEdit ? tx.amountCents : presets.amountCents))}" placeholder="0.00">
      </label>
      <div class="budget-field-row">
        <label class="budget-field">
          <span>Merchant (optional)</span>
          <input type="text" class="input" name="merchant" maxlength="80"
                 value="${esc(isEdit ? (tx.merchant || '') : (presets.merchant || ''))}" placeholder="e.g. Trader Joe's">
        </label>
        <label class="budget-field" id="budget-tx-category-field">
          <span>Category</span>
          <select class="input" name="categoryId">
            ${initialCategories.map((c) =>
              `<option value="${esc(c.id)}" ${(isEdit ? tx.categoryId : presets.categoryId) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
            ).join('')}
          </select>
        </label>
      </div>
      <button type="button" class="budget-split-toggle" id="budget-tx-split-toggle">Split this transaction</button>
      <label class="budget-field">
        <span>Description (optional)</span>
        <input type="text" class="input" name="description" maxlength="200"
               value="${esc(isEdit ? (tx.description || '') : (presets.description || ''))}" placeholder="">
      </label>
      <label class="budget-field">
        <span>Notes (optional)</span>
        <textarea class="input" name="notes" rows="2">${esc(isEdit ? (tx.notes || '') : '')}</textarea>
      </label>
    `;

    // Duplicate warning slot (shown if presets indicate a duplicate)
    if (presets.duplicateNote) {
      const warn = document.createElement('div');
      warn.className = 'budget-warning-note';
      warn.innerHTML = `<strong>Heads up.</strong> ${esc(presets.duplicateNote)}`;
      form.appendChild(warn);
    }

    // Splits editor (hidden by default)
    const splitsBox = document.createElement('div');
    splitsBox.className = 'budget-splits';
    splitsBox.hidden = true;
    splitsBox.innerHTML = `
      <div class="budget-allocations-header">
        <span class="budget-field-label">Splits</span>
        <button type="button" class="budget-action-btn" id="budget-tx-split-add">+ Row</button>
      </div>
      <div class="budget-allocation-list" id="budget-tx-split-list"></div>
      <p class="budget-allocations-total" id="budget-tx-split-total"></p>
      <p class="budget-form-hint">Splits must add up exactly to the transaction amount.</p>
    `;
    form.appendChild(splitsBox);

    const actionsRow = document.createElement('div');
    actionsRow.className = 'pike-modal-actions';
    if (isEdit) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn budget-modal-delete';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => {
        deleteTransaction(existing.id);
        global.Pike.modal.close();
      });
      actionsRow.appendChild(delBtn);
    }
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.setAttribute('data-modal-close', '1');
    cancelBtn.textContent = 'Cancel';
    actionsRow.appendChild(cancelBtn);
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = isEdit ? 'Save' : 'Add transaction';
    actionsRow.appendChild(submitBtn);
    form.appendChild(actionsRow);

    // ── Splits state ─────────────────────────────────────────────────────────
    const splitToggleBtn = form.querySelector('#budget-tx-split-toggle');
    const splitAddBtn    = form.querySelector('#budget-tx-split-add');
    const splitListEl    = form.querySelector('#budget-tx-split-list');
    const splitTotalEl   = form.querySelector('#budget-tx-split-total');
    const categoryField  = form.querySelector('#budget-tx-category-field');
    const kindSelect     = form.querySelector('select[name="kind"]');
    const amountInput    = form.querySelector('input[name="amount"]');

    function currentCategoriesForUI() {
      return categoriesForKind(kindSelect.value);
    }

    function refreshCategoryDropdown(selectedId) {
      const opts = currentCategoriesForUI();
      const sel = categoryField.querySelector('select');
      sel.innerHTML = opts.map((c) =>
        `<option value="${esc(c.id)}" ${selectedId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
      ).join('');
    }

    function addSplitRow(initial) {
      const opts = currentCategoriesForUI();
      const r = document.createElement('div');
      r.className = 'budget-allocation-row';
      r.innerHTML = `
        <select class="input" name="splitCategory">
          ${opts.map((c) =>
            `<option value="${esc(c.id)}" ${initial && initial.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
          ).join('')}
        </select>
        <input type="text" inputmode="decimal" class="input" name="splitAmount"
               value="${esc(inputValueFromCents(initial && initial.amountCents || 0))}" placeholder="0.00">
        <button type="button" class="budget-action-btn budget-allocation-remove" aria-label="Remove split">✕</button>
      `;
      r.querySelector('input[name="splitAmount"]').addEventListener('input', recalcSplits);
      r.querySelector('.budget-allocation-remove').addEventListener('click', () => { r.remove(); recalcSplits(); });
      splitListEl.appendChild(r);
    }

    function recalcSplits() {
      const parent = centsFromInput(amountInput.value || '0');
      let sum = 0;
      splitListEl.querySelectorAll('input[name="splitAmount"]').forEach((i) => {
        sum += centsFromInput(i.value);
      });
      const left = parent - sum;
      splitTotalEl.textContent = `Allocated ${formatCents(sum)} of ${formatCents(parent)} · ${formatCents(left)} left`;
      splitTotalEl.classList.toggle('is-over', left !== 0);
    }

    let splitsOn = isEdit && Array.isArray(tx.splits) && tx.splits.length > 0;

    function setSplitsMode(on) {
      splitsOn = on;
      splitsBox.hidden = !on;
      categoryField.style.display = on ? 'none' : '';
      splitToggleBtn.textContent = on ? 'Use a single category' : 'Split this transaction';
      if (on && !splitListEl.children.length) {
        // Seed with one row.
        addSplitRow({ categoryId: currentCategoriesForUI()[0]?.id, amountCents: 0 });
      }
      recalcSplits();
    }

    splitToggleBtn.addEventListener('click', () => setSplitsMode(!splitsOn));
    splitAddBtn.addEventListener('click', () => {
      addSplitRow({ categoryId: currentCategoriesForUI()[0]?.id, amountCents: 0 });
      recalcSplits();
    });
    amountInput.addEventListener('input', recalcSplits);

    kindSelect.addEventListener('change', () => {
      // Update category dropdown to match kind's allowable categories.
      refreshCategoryDropdown(null);
      // Reset all split categories to first available (group of categories changed).
      splitListEl.querySelectorAll('.budget-allocation-row').forEach((r) => {
        const sel = r.querySelector('select[name="splitCategory"]');
        const opts = currentCategoriesForUI();
        sel.innerHTML = opts.map((c) =>
          `<option value="${esc(c.id)}">${esc(c.name)}</option>`
        ).join('');
      });
    });

    // Hydrate splits if editing a split transaction
    if (splitsOn) {
      tx.splits.forEach((s) => addSplitRow({ categoryId: s.categoryId, amountCents: s.amountCents }));
      setSplitsMode(true);
    }

    // ── Submit ───────────────────────────────────────────────────────────────
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const date = String(fd.get('date') || todayKey());
      const accountId = String(fd.get('accountId') || '');
      const kind = String(fd.get('kind') || 'spending');
      const amountCents = centsFromInput(String(fd.get('amount') || '0'));
      const merchant = String(fd.get('merchant') || '').trim();
      const description = String(fd.get('description') || '').trim();
      const notes = String(fd.get('notes') || '').trim();
      const direction = (TX_KIND_OPTIONS.find((k) => k.id === kind) || {}).direction || 'outflow';
      if (!accountId || amountCents <= 0) return;

      let splits = null;
      let categoryId = null;

      if (splitsOn) {
        const rows = Array.from(splitListEl.querySelectorAll('.budget-allocation-row'));
        const collected = rows.map((r) => ({
          id: uid('spl'),
          categoryId: r.querySelector('select[name="splitCategory"]').value,
          amountCents: centsFromInput(r.querySelector('input[name="splitAmount"]').value),
          note: '',
        })).filter((s) => s.amountCents > 0);
        const sum = collected.reduce((n, s) => n + s.amountCents, 0);
        if (sum !== amountCents) {
          // Render an inline error banner inside the form
          showFormError(form, `Splits must add up to ${formatCents(amountCents)}. Off by ${formatCents(amountCents - sum)}.`);
          return;
        }
        if (!collected.length) {
          showFormError(form, 'Add at least one split row, or turn off Split.');
          return;
        }
        splits = collected;
      } else {
        categoryId = String(fd.get('categoryId') || '') || null;
      }

      const now = new Date().toISOString();
      global.Pike.state.commit((d) => {
        if (!d.budget.transactions) d.budget.transactions = [];
        if (isEdit) {
          const t = d.budget.transactions.find((x) => x.id === existing.id);
          if (t) {
            t.date = date;
            t.accountId = accountId;
            t.kind = kind;
            t.direction = direction;
            t.amountCents = amountCents;
            t.merchant = merchant;
            t.description = description;
            t.categoryId = categoryId;
            t.splits = splits;
            t.notes = notes;
            t.updatedAt = now;
          }
        } else {
          d.budget.transactions.push({
            id: uid('txn'),
            accountId, date, amountCents, direction, kind,
            categoryId, merchant, description,
            transferPairId: null,
            ruleAppliedId: null,
            splits, notes,
            createdAt: now, updatedAt: now,
            plaidTransactionId: null,
            plaidPending: null,
          });
        }
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({
      title: isEdit ? 'Edit transaction' : 'Add transaction',
      body: form,
    });
  }

  function showFormError(form, msg) {
    let err = form.querySelector('.budget-form-error');
    if (!err) {
      err = document.createElement('p');
      err.className = 'budget-form-error';
      // Insert just before the actions row
      const actions = form.querySelector('.pike-modal-actions');
      form.insertBefore(err, actions);
    }
    err.textContent = msg;
  }

  function deleteTransaction(id) {
    if (!confirm('Remove this transaction? This cannot be undone.')) return;
    global.Pike.state.commit((d) => {
      d.budget.transactions = (d.budget.transactions || []).filter((t) => t.id !== id);
    });
  }

  // ─── Transfer modal (atomic two-leg) ─────────────────────────────────────────

  function openTransferModal(existingLeg) {
    const isEdit = !!existingLeg;
    const accounts = (getBudget().accounts || []).filter((a) => !a.archived);

    if (accounts.length < 2 && !isEdit) {
      global.Pike.modal.open({
        title: 'Add a transfer',
        body: '<p style="margin:0;color:var(--text-muted);">A transfer needs at least two accounts. Add another in <strong>Accounts</strong> first.</p>' +
              '<div class="pike-modal-actions"><button type="button" class="btn btn-primary" data-modal-close="1">OK</button></div>',
      });
      return;
    }

    // For an edit, find both legs of the pair and resolve outflow leg.
    let outflowLeg = null;
    let inflowLeg = null;
    if (isEdit && existingLeg.transferPairId) {
      const txns = getBudget().transactions || [];
      const pair = txns.filter((t) => t.transferPairId === existingLeg.transferPairId);
      outflowLeg = pair.find((t) => t.direction === 'outflow') || existingLeg;
      inflowLeg  = pair.find((t) => t.direction === 'inflow');
    }

    const initialDate = isEdit ? outflowLeg.date : todayKey();
    const initialFrom = isEdit ? outflowLeg.accountId : '';
    const initialTo   = isEdit ? (inflowLeg ? inflowLeg.accountId : '') : '';
    const initialAmt  = isEdit ? outflowLeg.amountCents : 0;
    const initialDesc = isEdit ? (outflowLeg.description || '') : '';
    const initialMerc = isEdit ? (outflowLeg.merchant || '') : '';

    const form = document.createElement('form');
    form.className = 'budget-form';
    form.autocomplete = 'off';

    function accountOptions(selectedId) {
      return accounts.map((a) =>
        `<option value="${esc(a.id)}" ${selectedId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`
      ).join('');
    }

    form.innerHTML = `
      <label class="budget-field">
        <span>Date</span>
        <input type="date" class="input" name="date" required value="${esc(initialDate)}">
      </label>
      <label class="budget-field">
        <span>From account</span>
        <select class="input" name="fromAccountId" required>
          <option value="" ${!initialFrom ? 'selected' : ''}>Select account…</option>
          ${accountOptions(initialFrom)}
        </select>
      </label>
      <label class="budget-field">
        <span>To account</span>
        <select class="input" name="toAccountId" required>
          <option value="" ${!initialTo ? 'selected' : ''}>Select account…</option>
          ${accountOptions(initialTo)}
        </select>
      </label>
      <p class="budget-form-hint" id="budget-transfer-kind-hint"></p>
      <label class="budget-field">
        <span>Amount</span>
        <input type="text" inputmode="decimal" class="input" name="amount" required
               value="${esc(inputValueFromCents(initialAmt))}" placeholder="0.00">
      </label>
      <label class="budget-field">
        <span>Description (optional)</span>
        <input type="text" class="input" name="description" maxlength="200"
               value="${esc(initialDesc)}" placeholder="">
      </label>
    `;

    const kindHint = form.querySelector('#budget-transfer-kind-hint');
    const fromSel = form.querySelector('select[name="fromAccountId"]');
    const toSel   = form.querySelector('select[name="toAccountId"]');

    function updateKindHint() {
      const fromId = fromSel.value;
      const toId   = toSel.value;
      if (!fromId || !toId) { kindHint.textContent = ''; kindHint.className = 'budget-form-hint'; return; }
      if (fromId === toId)  { kindHint.textContent = 'From and To must be different accounts.'; kindHint.className = 'budget-form-hint is-error'; return; }
      const toAcct = accounts.find((a) => a.id === toId);
      const isDebt = toAcct && DEBT_ACCOUNT_TYPES.includes(toAcct.type);
      kindHint.textContent = isDebt ? 'Debt payment — pays toward this account' : 'Internal transfer';
      kindHint.className = 'budget-form-hint budget-transfer-kind-pill ' + (isDebt ? 'is-debt-payment' : 'is-internal');
    }
    fromSel.addEventListener('change', updateKindHint);
    toSel.addEventListener('change', updateKindHint);
    updateKindHint();

    const actionsRow = document.createElement('div');
    actionsRow.className = 'pike-modal-actions';
    if (isEdit) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn budget-modal-delete';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => {
        deleteTransferPair(outflowLeg.transferPairId);
        global.Pike.modal.close();
      });
      actionsRow.appendChild(delBtn);
    }
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.setAttribute('data-modal-close', '1');
    cancelBtn.textContent = 'Cancel';
    actionsRow.appendChild(cancelBtn);
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = isEdit ? 'Save' : 'Add transfer';
    actionsRow.appendChild(submitBtn);
    form.appendChild(actionsRow);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const date = String(fd.get('date') || todayKey());
      const fromAccountId = String(fd.get('fromAccountId') || '');
      const toAccountId   = String(fd.get('toAccountId') || '');
      const amountCents = centsFromInput(String(fd.get('amount') || '0'));
      const description = String(fd.get('description') || '').trim();
      if (!fromAccountId || !toAccountId || fromAccountId === toAccountId || amountCents <= 0) {
        showFormError(form, 'Pick two different accounts and an amount greater than zero.');
        return;
      }
      const toAcct = accounts.find((a) => a.id === toAccountId);
      const kind = (toAcct && DEBT_ACCOUNT_TYPES.includes(toAcct.type)) ? 'debt-payment' : 'transfer';
      const now = new Date().toISOString();

      global.Pike.state.commit((d) => {
        if (!d.budget.transactions) d.budget.transactions = [];
        if (isEdit) {
          // Rewrite both legs in place by id.
          const pairId = outflowLeg.transferPairId;
          const out = d.budget.transactions.find((t) => t.id === outflowLeg.id);
          const inn = inflowLeg ? d.budget.transactions.find((t) => t.id === inflowLeg.id) : null;
          if (out) {
            out.date = date; out.accountId = fromAccountId; out.kind = kind;
            out.direction = 'outflow'; out.amountCents = amountCents;
            out.description = description; out.merchant = initialMerc;
            out.transferPairId = pairId; out.updatedAt = now;
          }
          if (inn) {
            inn.date = date; inn.accountId = toAccountId; inn.kind = kind;
            inn.direction = 'inflow'; inn.amountCents = amountCents;
            inn.description = description; inn.merchant = initialMerc;
            inn.transferPairId = pairId; inn.updatedAt = now;
          } else {
            // Inflow leg was missing — heal by creating it.
            d.budget.transactions.push({
              id: uid('txn'), accountId: toAccountId, date, amountCents,
              direction: 'inflow', kind, categoryId: null, merchant: initialMerc, description,
              transferPairId: pairId, ruleAppliedId: null, splits: null, notes: '',
              createdAt: now, updatedAt: now,
              plaidTransactionId: null, plaidPending: null,
            });
          }
        } else {
          const outflowId = uid('txn');
          d.budget.transactions.push({
            id: outflowId, accountId: fromAccountId, date, amountCents,
            direction: 'outflow', kind, categoryId: null, merchant: '', description,
            transferPairId: outflowId, ruleAppliedId: null, splits: null, notes: '',
            createdAt: now, updatedAt: now,
            plaidTransactionId: null, plaidPending: null,
          });
          d.budget.transactions.push({
            id: uid('txn'), accountId: toAccountId, date, amountCents,
            direction: 'inflow', kind, categoryId: null, merchant: '', description,
            transferPairId: outflowId, ruleAppliedId: null, splits: null, notes: '',
            createdAt: now, updatedAt: now,
            plaidTransactionId: null, plaidPending: null,
          });
        }
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({
      title: isEdit ? 'Edit transfer' : 'Add transfer',
      body: form,
    });
  }

  function deleteTransferPair(pairId) {
    if (!pairId) return;
    if (!confirm('Remove this transfer? Both legs will be deleted.')) return;
    global.Pike.state.commit((d) => {
      d.budget.transactions = (d.budget.transactions || []).filter((t) => t.transferPairId !== pairId);
    });
  }

  // ─── Recurring bills ─────────────────────────────────────────────────────────

  function buildRecurringView() {
    const bills = (getBudget().recurringBills || []).filter((r) => !r.archived);
    const wrap = document.createElement('div');
    wrap.className = 'budget-list';
    if (!bills.length) {
      wrap.appendChild(buildEmpty('No recurring bills yet. Tap + Recurring bill to set one up.'));
      return wrap;
    }
    bills
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((bill) => wrap.appendChild(buildRecurringRow(bill)));
    return wrap;
  }

  function buildRecurringRow(bill) {
    const row = document.createElement('div');
    row.className = 'budget-row';

    const accounts = getBudget().accounts || [];
    const fromAcct = accounts.find((a) => a.id === bill.accountId);
    const counter = bill.counterAccountId ? accounts.find((a) => a.id === bill.counterAccountId) : null;
    const cadenceLabel = (RECURRING_CADENCES.find((c) => c.id === bill.cadence) || {}).label || bill.cadence;

    const main = document.createElement('div');
    main.className = 'budget-row-main';
    const name = document.createElement('h3');
    name.className = 'budget-row-name';
    name.textContent = bill.name;
    const meta = document.createElement('p');
    meta.className = 'budget-row-meta';
    const next = upcomingOccurrences(bill, 365)[0];
    const nextLabel = next ? `next ${fmtDateShort(next)}` : 'no upcoming dates';
    const route = counter ? `${fromAcct?.name || '—'} → ${counter.name}` : (fromAcct?.name || '—');
    meta.textContent = `${cadenceLabel} · ${nextLabel} · ${route}`;
    main.appendChild(name);
    main.appendChild(meta);

    const amountWrap = document.createElement('div');
    amountWrap.className = 'budget-row-amount-wrap';
    const amount = document.createElement('div');
    amount.className = 'budget-row-amount';
    amount.textContent = formatCents(bill.amountCents || 0);
    amountWrap.appendChild(amount);
    const sub = document.createElement('span');
    sub.className = 'budget-row-amount-state';
    sub.textContent = 'Expected';
    amountWrap.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'budget-row-actions';
    if (next) {
      const logBtn = document.createElement('button');
      logBtn.type = 'button';
      logBtn.className = 'budget-action-btn';
      logBtn.textContent = 'Log now';
      logBtn.addEventListener('click', () => openLogBillFlow(bill, next));
      actions.appendChild(logBtn);
    }
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'budget-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openRecurringModal(bill));
    const archiveBtn = document.createElement('button');
    archiveBtn.type = 'button';
    archiveBtn.className = 'budget-action-btn';
    archiveBtn.textContent = 'Archive';
    archiveBtn.addEventListener('click', () => archiveRecurring(bill.id));
    actions.appendChild(editBtn);
    actions.appendChild(archiveBtn);

    row.appendChild(main);
    row.appendChild(amountWrap);
    row.appendChild(actions);
    return row;
  }

  function openRecurringModal(existing) {
    const isEdit = !!existing;
    const bill = existing || {};
    const accounts = (getBudget().accounts || []).filter((a) => !a.archived);
    const debtAccounts = accounts.filter((a) => DEBT_ACCOUNT_TYPES.includes(a.type));
    const allCategories = (getBudget().categories || []).filter((c) => !c.archived);

    if (!accounts.length && !isEdit) {
      global.Pike.modal.open({
        title: 'Add a recurring bill',
        body: '<p style="margin:0;color:var(--text-muted);">Add an account first in <strong>Accounts</strong>, then come back to set up a bill.</p>' +
              '<div class="pike-modal-actions"><button type="button" class="btn btn-primary" data-modal-close="1">OK</button></div>',
      });
      return;
    }

    const form = document.createElement('form');
    form.className = 'budget-form';
    form.autocomplete = 'off';
    form.innerHTML = `
      <label class="budget-field">
        <span>Name</span>
        <input type="text" class="input" name="name" required maxlength="80"
               value="${esc(bill.name || '')}" placeholder="e.g. Discover minimum payment">
      </label>
      <label class="budget-field">
        <span>Expected amount</span>
        <input type="text" inputmode="decimal" class="input" name="amount" required
               value="${esc(inputValueFromCents(bill.amountCents))}" placeholder="0.00">
      </label>
      <label class="budget-field">
        <span>Paid from account</span>
        <select class="input" name="accountId" required>
          ${accounts.map((a) =>
            `<option value="${esc(a.id)}" ${bill.accountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`
          ).join('')}
        </select>
      </label>
      <label class="budget-field">
        <span>Pays toward (optional, for debt payments)</span>
        <select class="input" name="counterAccountId">
          <option value="" ${!bill.counterAccountId ? 'selected' : ''}>None — this is a regular bill</option>
          ${debtAccounts.map((a) =>
            `<option value="${esc(a.id)}" ${bill.counterAccountId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`
          ).join('')}
        </select>
      </label>
      <label class="budget-field">
        <span>Category</span>
        <select class="input" name="categoryId">
          ${allCategories.map((c) =>
            `<option value="${esc(c.id)}" ${bill.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
          ).join('')}
        </select>
      </label>
      <div class="budget-field-row">
        <label class="budget-field">
          <span>Cadence</span>
          <select class="input" name="cadence" required>
            ${RECURRING_CADENCES.map((c) =>
              `<option value="${c.id}" ${bill.cadence === c.id ? 'selected' : ''}>${c.label}</option>`
            ).join('')}
          </select>
        </label>
        <label class="budget-field">
          <span>Anchor date (first occurrence)</span>
          <input type="date" class="input" name="anchorDate" required
                 value="${esc(bill.anchorDate || todayKey())}">
        </label>
      </div>
      <label class="budget-field">
        <span>Notes (optional)</span>
        <textarea class="input" name="notes" rows="2">${esc(bill.notes || '')}</textarea>
      </label>
    `;

    const actions = document.createElement('div');
    actions.className = 'pike-modal-actions';
    if (isEdit) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'btn budget-modal-delete';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => {
        deleteRecurring(existing.id);
        global.Pike.modal.close();
      });
      actions.appendChild(delBtn);
    }
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn';
    cancelBtn.setAttribute('data-modal-close', '1');
    cancelBtn.textContent = 'Cancel';
    actions.appendChild(cancelBtn);
    const submitBtn = document.createElement('button');
    submitBtn.type = 'submit';
    submitBtn.className = 'btn btn-primary';
    submitBtn.textContent = isEdit ? 'Save' : 'Add bill';
    actions.appendChild(submitBtn);
    form.appendChild(actions);

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const name = String(fd.get('name') || '').trim();
      if (!name) return;
      const amountCents = centsFromInput(String(fd.get('amount') || '0'));
      const accountId = String(fd.get('accountId') || '');
      const counterAccountId = String(fd.get('counterAccountId') || '') || null;
      const categoryId = String(fd.get('categoryId') || '') || null;
      const cadence = String(fd.get('cadence') || 'monthly');
      const anchorDate = String(fd.get('anchorDate') || todayKey());
      const notes = String(fd.get('notes') || '').trim();

      global.Pike.state.commit((d) => {
        if (!d.budget.recurringBills) d.budget.recurringBills = [];
        if (isEdit) {
          const b = d.budget.recurringBills.find((x) => x.id === existing.id);
          if (b) {
            b.name = name; b.amountCents = amountCents;
            b.accountId = accountId; b.counterAccountId = counterAccountId;
            b.categoryId = categoryId; b.cadence = cadence;
            b.anchorDate = anchorDate; b.notes = notes;
          }
        } else {
          d.budget.recurringBills.push({
            id: uid('rec'), name, amountCents,
            categoryId, accountId, counterAccountId,
            cadence, anchorDate,
            autopay: false, notes, archived: false,
          });
        }
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({
      title: isEdit ? 'Edit recurring bill' : 'Add recurring bill',
      body: form,
    });
  }

  function deleteRecurring(id) {
    if (!confirm('Remove this recurring bill? Past transactions logged from it stay intact.')) return;
    global.Pike.state.commit((d) => {
      d.budget.recurringBills = (d.budget.recurringBills || []).filter((b) => b.id !== id);
    });
  }

  function archiveRecurring(id) {
    const bill = (getBudget().recurringBills || []).find((b) => b.id === id);
    if (!bill) return;
    if (!confirm(`Archive "${bill.name}"? It'll stop appearing in upcoming bills, but past transactions remain intact.`)) return;
    global.Pike.state.commit((d) => {
      const b = (d.budget.recurringBills || []).find((x) => x.id === id);
      if (b) b.archived = true;
    });
  }

  function openLogBillFlow(bill, occurrenceDate) {
    // Soft duplicate warning: any tx with same merchant/date/account?
    const dupes = findDuplicateTxnsForBill(bill, occurrenceDate);
    let duplicateNote = null;
    if (dupes.length) {
      const total = formatCents(dupes.reduce((n, t) => n + (t.amountCents || 0), 0));
      duplicateNote = `You already logged "${bill.name}" on ${fmtDateShort(occurrenceDate)} for ${total}. Add another anyway?`;
    }

    if (bill.counterAccountId) {
      // Open transfer modal pre-populated. We can't pass presets through transfer modal yet,
      // so manually pre-fill after open by hydrating its inputs.
      openTransferModal(null);
      // Hydrate after the modal is in DOM
      setTimeout(() => {
        const form = document.querySelector('#pike-modal-body .budget-form');
        if (!form) return;
        form.querySelector('input[name="date"]').value = occurrenceDate;
        const fromSel = form.querySelector('select[name="fromAccountId"]');
        const toSel   = form.querySelector('select[name="toAccountId"]');
        fromSel.value = bill.accountId;
        toSel.value   = bill.counterAccountId;
        form.querySelector('input[name="amount"]').value = inputValueFromCents(bill.amountCents);
        form.querySelector('input[name="description"]').value = `(recurring: ${bill.name})`;
        // Manually trigger change to update kind hint
        fromSel.dispatchEvent(new Event('change'));
        toSel.dispatchEvent(new Event('change'));
        if (duplicateNote) {
          const warn = document.createElement('div');
          warn.className = 'budget-warning-note';
          warn.innerHTML = `<strong>Heads up.</strong> ${esc(duplicateNote)}`;
          const actions = form.querySelector('.pike-modal-actions');
          form.insertBefore(warn, actions);
        }
      }, 0);
    } else {
      openTransactionModal(null, {
        kind: 'spending',
        date: occurrenceDate,
        accountId: bill.accountId,
        amountCents: bill.amountCents,
        merchant: bill.name,
        description: `(recurring: ${bill.name})`,
        categoryId: bill.categoryId,
        duplicateNote,
      });
    }
  }

  // ─── Init + seed migration ───────────────────────────────────────────────────

  function init() {
    const data = global.Pike.state.data;
    if (!data || !data.budget) return;

    if (!data.budget.categoriesSeeded) {
      global.Pike.state.commit((d) => {
        if (!d.budget.categories) d.budget.categories = [];
        SEED_CATEGORIES.forEach((seed) => {
          d.budget.categories.push({
            id: uid('cat'),
            name: seed.name,
            group: seed.group,
            color: seed.color,
            icon: null,
            archived: false,
          });
        });
        d.budget.categoriesSeeded = true;
      });
    }

    if (!sectionListenerAttached) {
      document.addEventListener('pike:section', (e) => {
        if (e && e.detail && e.detail.section === 'budget') {
          activeView = null;
          txFilter = 'all';
          activePeriodId = null;
          render();
        }
      });
      sectionListenerAttached = true;
    }
  }

  global.Pike = global.Pike || {};
  global.Pike.budget = { init, render };

})(window);
