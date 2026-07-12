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
  let txSearch = '';                   // free text — matches merchant, description, notes
  let txAccountFilter  = '';           // accountId or '' (all)
  let txCategoryFilter = '';           // categoryId, 'none', or '' (all)
  let txScopeFilter    = '';           // '', 'period:<id>', 'month:YYYY-MM'
  let txSort           = 'date-desc';  // 'date-desc' | 'date-asc' | 'amount-desc' | 'amount-asc'
  // Dashboard scope — period or calendar month. Device-local preference, not
  // synced state; semi-monthly periods tile months exactly so both views are
  // pure date math over the same transactions.
  let dashScope = (() => {
    try { return localStorage.getItem('pike.budget.dashscope') === 'month' ? 'month' : 'period'; }
    catch (_) { return 'period'; }
  })();
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

  // Synthetic period covering one calendar month. Semi-monthly periods tile
  // months exactly (1–15 + 16–EOM), so all range-derived math — spending,
  // category totals, refund netting — works unchanged on this object.
  // Expected income and allocations are summed from the real periods inside.
  function monthAsPeriod(yyyymm) {
    const [y, m] = yyyymm.split('-').map(Number);
    const startDate = `${yyyymm}-01`;
    const endDate = `${yyyymm}-${pad2(new Date(y, m, 0).getDate())}`;
    const inside = (getBudget().payPeriods || []).filter(
      (p) => p.startDate >= startDate && p.startDate <= endDate
    );
    const allocMap = {};
    inside.forEach((p) => (p.allocations || []).forEach((a) => {
      allocMap[a.categoryId] = (allocMap[a.categoryId] || 0) + (a.amountCents || 0);
    }));
    const label = new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    return {
      id: 'month:' + yyyymm,
      label,
      startDate,
      endDate,
      expectedIncomeCents: inside.reduce((s, p) => s + (p.expectedIncomeCents || 0), 0),
      allocations: Object.entries(allocMap).map(([categoryId, amountCents]) => ({ categoryId, amountCents })),
    };
  }

  // The period-or-month the dashboard is currently scoped to.
  function dashScopePeriod() {
    if (dashScope === 'month') return monthAsPeriod(todayKey().slice(0, 7));
    return activePeriod();
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
  // Categories flagged excludeFromSpending (interest, late fees — the cost of
  // carrying debt) stay out of the "spent" behavior gauge: they're neither a
  // choice made this period nor cash leaving checking. They surface on their
  // own line instead, and still appear in category breakdowns.
  function excludedFromSpendingCatIds() {
    return new Set(
      (getBudget().categories || []).filter((c) => c.excludeFromSpending).map((c) => c.id)
    );
  }

  // Interest & fees accrued in this period (flagged categories, refund-netted).
  function periodFeesCents(period) {
    if (!period) return 0;
    let total = 0;
    excludedFromSpendingCatIds().forEach((id) => { total += categorySpentInPeriod(id, period); });
    return total;
  }

  // May go negative when refunds exceed spending — callers should display the
  // result calmly (e.g. as a credit balance), not as a noisy red number.
  function periodSpendingCents(period) {
    if (!period) return 0;
    const excluded = excludedFromSpendingCatIds();
    return (getBudget().transactions || []).reduce((sum, t) => {
      if (t.plaidRemoved) return sum;
      if (t.date < period.startDate || t.date > period.endDate) return sum;
      if (t.kind === 'transfer' || t.kind === 'debt-payment') return sum;
      let sign = 0;
      if (t.kind === 'spending' && t.direction === 'outflow') sign = +1;
      else if (t.kind === 'refund' && t.direction === 'inflow') sign = -1;
      else return sum;
      if (Array.isArray(t.splits) && t.splits.length) {
        const counted = t.splits
          .filter((s) => !excluded.has(s.categoryId))
          .reduce((n, s) => n + (s.amountCents || 0), 0);
        return sum + sign * counted;
      }
      if (excluded.has(t.categoryId)) return sum;
      return sum + sign * (t.amountCents || 0);
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

  // ── Amortized debt tracking ──────────────────────────────────────────────────
  // For debts with an APR whose linked account is anchored to a known statement
  // figure (the account's startingBalance/Date), derive current principal by
  // amortizing each observed payment since the anchor: simple daily interest
  // accrues between payments, the remainder of each payment reduces principal.
  // Payments are observed two ways:
  //   1. transfer/debt-payment inflow legs on the linked account
  //   2. outflows anywhere matching the debt's paymentMatchValue — for loans
  //      whose servicer isn't Plaid-connected (autopay from checking)
  // Estimates re-true themselves whenever the user re-anchors the account
  // balance from a fresh statement. Returns null when amortizing isn't possible.
  function amortizedDebtStatus(dbt) {
    if (dbt.aprBps == null) return null;   // 0 is valid — 0% BNPL loans amortize dollar-for-dollar
    const b = getBudget();
    const linked = (b.accounts || []).find((a) => a.id === dbt.accountId);
    // Loans only: credit-card balances move with every purchase, so their
    // truth is the live imported-transaction balance, never an amortization.
    if (!linked || linked.type !== 'loan' || !linked.startingBalanceDate) return null;
    const matchVal = (dbt.paymentMatchValue || '').toLowerCase().trim();

    const anchorDate = linked.startingBalanceDate;
    const payments = [];
    (b.transactions || []).forEach((t) => {
      if (t.plaidRemoved || !t.date || t.date <= anchorDate) return;
      const isTransferLeg = t.transferPairId && t.direction === 'inflow' && t.accountId === dbt.accountId;
      let isMatched = false;
      if (!isTransferLeg && matchVal && t.direction === 'outflow' && !t.transferPairId) {
        const m = `${t.merchant || ''} ${t.description || ''}`.toLowerCase();
        isMatched = m.includes(matchVal);
      }
      if (isTransferLeg || isMatched) payments.push(t);
    });
    payments.sort((a, b2) => a.date.localeCompare(b2.date));

    const dailyRate = (dbt.aprBps / 10000) / 365;
    let balance = Math.abs(linked.startingBalanceCents || 0);
    let prevDate = anchorDate;
    let interestPaid = 0;
    let principalPaid = 0;
    payments.forEach((p) => {
      const days = Math.max(daysBetween(prevDate, p.date), 0);
      const interest = Math.round(balance * dailyRate * days);
      const principal = p.amountCents - interest;
      interestPaid  += Math.min(interest, p.amountCents);
      principalPaid += Math.max(principal, 0);
      balance = Math.max(balance - principal, 0);
      prevDate = p.date;
    });

    // Forward projection at the minimum payment. Null when the minimum doesn't
    // cover interest (never pays off) or no minimum is set.
    let payoffMonths = null;
    if (balance > 0 && dbt.minimumPaymentCents > 0) {
      const monthlyRate = (dbt.aprBps / 10000) / 12;
      if (dbt.minimumPaymentCents > balance * monthlyRate) {
        let sim = balance;
        payoffMonths = 0;
        while (sim > 0 && payoffMonths < 600) {
          sim = sim + Math.round(sim * monthlyRate) - dbt.minimumPaymentCents;
          payoffMonths++;
        }
      }
    }

    return {
      balance, interestPaid, principalPaid,
      paymentCount: payments.length,
      payoffMonths, anchorDate,
    };
  }

  function amortProgressLineText(dbt, s) {
    if (s.balance <= 0) return 'Cleared';
    if (!s.paymentCount) {
      return `Amortized at ${(dbt.aprBps / 100).toFixed(2)}% · no payments observed since ${fmtDateShort(s.anchorDate)}`;
    }
    let timeLabel = '';
    if (s.payoffMonths != null) {
      const years = Math.floor(s.payoffMonths / 12);
      const rem = s.payoffMonths % 12;
      if (s.payoffMonths <= 12) timeLabel = `payoff in about ${s.payoffMonths} mo`;
      else timeLabel = rem === 0 ? `payoff in about ${years} yr` : `payoff in about ${years} yr ${rem} mo`;
    }
    const paidBits = `${formatCents(s.principalPaid)} principal · ${formatCents(s.interestPaid)} interest since ${fmtDateShort(s.anchorDate)}`;
    return [timeLabel, paidBits].filter(Boolean).join(' · ');
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

  // Every occurrence is computed FROM the anchor (anchor + k steps), never by
  // stepping the previous occurrence. Iterative month-stepping drifts on
  // month-end anchors: Jan 29 + 1 month overflows to Mar 1, and the plan
  // loses its day-of-month forever. Clamping against the anchor keeps a
  // 29th-anchored bill on the 29th (28th in February only).
  const CADENCE_MONTHS = { monthly: 1, quarterly: 3, annual: 12 };

  function addMonthsClamped(iso, months) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(y, m - 1 + months, 1);
    const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
    return `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(Math.min(d, lastDay))}`;
  }

  function occurrenceDate(bill, k) {
    const months = CADENCE_MONTHS[bill.cadence];
    if (months) return addMonthsClamped(bill.anchorDate, k * months);
    const cad = RECURRING_CADENCES.find((c) => c.id === bill.cadence);
    return addDaysIso(bill.anchorDate, k * ((cad && cad.days) || 30));
  }

  // Walks a recurring bill's cadence forward from anchorDate, returning the
  // next occurrence dates in [today, today + days] (inclusive both ends).
  function upcomingOccurrences(bill, daysAhead) {
    const today = todayKey();
    const horizonDate = addDaysIso(today, daysAhead);
    const out = [];
    if (!bill.anchorDate) return out;

    let k = 0;
    let cursor = bill.anchorDate;
    while (cursor < today && k < 1000) { k++; cursor = occurrenceDate(bill, k); }
    // Bills with an endDate (installment plans) yield nothing past it —
    // they fall off upcoming lists on their own.
    while (cursor <= horizonDate && out.length < 50) {
      if (bill.endDate && cursor > bill.endDate) break;
      if (cursor >= today) out.push(cursor);
      k++;
      cursor = occurrenceDate(bill, k);
    }
    return out;
  }

  // How many occurrences remain from today through endDate (inclusive).
  // Null when the bill has no end date (open-ended).
  function remainingOccurrenceCount(bill) {
    if (!bill.endDate || !bill.anchorDate) return null;
    const today = todayKey();
    if (bill.endDate < today) return 0;
    let k = 0;
    let cursor = bill.anchorDate;
    while (cursor < today && k < 1000) { k++; cursor = occurrenceDate(bill, k); }
    let count = 0;
    while (cursor <= bill.endDate && count < 500) {
      count++;
      k++;
      cursor = occurrenceDate(bill, k);
    }
    return count;
  }

  // ── Bill reconciliation ──────────────────────────────────────────────────────
  // Finds the transaction that "pays" a bill occurrence, so upcoming bills
  // check themselves off when the imported payment lands (no auto-logging —
  // Plaid brings the real transaction; logging would double-count).
  // A match is: an outflow within ±4 days that is either explicitly linked
  // (recurringBillId) or whose merchant/description contains the bill's
  // matchValue (fallback: bill name) with the amount within ±$1 or ±15%.
  // Near-identical sibling plans (two Affirm bills a day apart) can briefly
  // claim the same transaction — both resolve once both payments post.
  function occurrencePaidTxn(bill, occDate) {
    const txns = getBudget().transactions || [];
    const matchVal = (bill.matchValue || bill.name || '').toLowerCase().trim();
    const tolerance = Math.max(100, Math.round((bill.amountCents || 0) * 0.15));
    return txns.find((t) => {
      if (t.plaidRemoved || t.direction !== 'outflow') return false;
      if (Math.abs(daysBetween(occDate, t.date)) > 4) return false;
      if (t.recurringBillId === bill.id) return true;
      if (!matchVal) return false;
      // Variable-amount bills (utilities, card minimums) skip the amount
      // check — the merchant match plus the tight date window carries it.
      if (!bill.variable && Math.abs((t.amountCents || 0) - (bill.amountCents || 0)) > tolerance) return false;
      const m = `${t.merchant || ''} ${t.description || ''}`.toLowerCase();
      return m.includes(matchVal);
    }) || null;
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
    txSearch = '';
    txAccountFilter = '';
    txCategoryFilter = '';
    txScopeFilter = '';
    txSort = 'date-desc';
    selectedTxnIds = new Set();
    activePeriodId = null;
    render();
  }

  // Drill-down entry: open Transactions pre-filtered (e.g. from a top-categories
  // row). Sets filters directly — gotoView would wipe them.
  function gotoTransactionsFiltered(categoryId, scopeValue) {
    activeView = 'transactions';
    txFilter = 'all';
    txSearch = '';
    txAccountFilter = '';
    txCategoryFilter = categoryId || '';
    txScopeFilter = scopeValue || '';
    txSort = 'date-desc';
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

    // Checking balances at a glance — the cash-first answer to "where am I?"
    const glance = buildCheckingGlance();
    if (glance) wrap.appendChild(glance);

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

    // Sweep helper — the end-of-period ritual: what's safely movable from
    // Everyday Checking toward a debt after upcoming bills are covered.
    const sweep = buildSweepCard();
    if (sweep) wrap.appendChild(sweep);

    // Savings tracker — balance, saved-this-scope vs goal, one-tap top-up.
    const savingsCard = buildSavingsCard();
    if (savingsCard) wrap.appendChild(savingsCard);

    // Upcoming bills (only if any in next 14 days)
    const upcoming = buildUpcomingBillsTile();
    if (upcoming) wrap.appendChild(upcoming);

    // Unassigned banner (only if any unassigned transactions)
    const unassigned = unassignedTxnCount();
    if (unassigned > 0) wrap.appendChild(buildUnassignedBanner(unassigned));

    // Possible imported transfer/payment pairs (only if any)
    const matchCount = findTransferCandidates().length;
    if (matchCount > 0) wrap.appendChild(buildTransferMatchBanner(matchCount));

    return wrap;
  }

  // Two checking balances, always visible. Null when no checking accounts.
  function buildCheckingGlance() {
    const checkings = (getBudget().accounts || []).filter(
      (a) => !a.archived && a.type === 'checking'
    );
    if (!checkings.length) return null;
    const wrap = document.createElement('div');
    wrap.className = 'budget-checking-glance';
    checkings.forEach((acc) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'budget-cg-item';
      const name = document.createElement('span');
      name.className = 'budget-cg-name';
      name.textContent = acc.name.replace(/\s*\.\.\..*$/, '').replace(/WELLS FARGO\s*/i, '');
      const bal = document.createElement('span');
      bal.className = 'budget-cg-balance';
      const cents = accountBalance(acc);
      bal.textContent = formatCents(cents);
      if (cents < 0) bal.classList.add('is-negative');
      const state = document.createElement('span');
      state.className = 'budget-cg-state';
      state.textContent = accountBalanceState(acc);
      item.appendChild(name);
      item.appendChild(bal);
      item.appendChild(state);
      item.addEventListener('click', () => {
        activeView = 'transactions';
        txFilter = 'all';
        txAccountFilter = acc.id;
        txCategoryFilter = '';
        txScopeFilter = '';
        selectedTxnIds = new Set();
        activePeriodId = null;
        render();
      });
      wrap.appendChild(item);
    });
    return wrap;
  }

  // Sum + count of recurring-bill occurrences due in [today, endDate].
  // Occurrences whose payment already imported are excluded — "still to come"
  // and the sweep math must only count money that hasn't left yet.
  function upcomingBillsThrough(endDate, accountId) {
    const today = todayKey();
    const days = Math.max(0, daysBetween(today, endDate));
    let count = 0;
    let totalCents = 0;
    (getBudget().recurringBills || [])
      .filter((r) => !r.archived && (!accountId || r.accountId === accountId))
      .forEach((bill) => {
        upcomingOccurrences(bill, days).forEach((occDate) => {
          if (occurrencePaidTxn(bill, occDate)) return;
          count += 1;
          totalCents += bill.amountCents || 0;
        });
      });
    return { count, totalCents };
  }

  // Net money moved INTO savings-type accounts during the scope window —
  // transfer inflows minus withdrawals. Derived entirely from linked
  // transfer legs; no stored aggregates.
  function savedInPeriodCents(period) {
    if (!period) return 0;
    const b = getBudget();
    const savingsIds = new Set(
      (b.accounts || []).filter((a) => !a.archived && a.type === 'savings').map((a) => a.id)
    );
    if (!savingsIds.size) return 0;
    return (b.transactions || []).reduce((sum, t) => {
      if (t.plaidRemoved || t.kind !== 'transfer') return sum;
      if (!savingsIds.has(t.accountId)) return sum;
      if (t.date < period.startDate || t.date > period.endDate) return sum;
      return sum + (t.direction === 'inflow' ? (t.amountCents || 0) : -(t.amountCents || 0));
    }, 0);
  }

  function openSavingsGoalModal() {
    const b = getBudget();
    const current = (b.settings && b.settings.savingsGoalCents) || 0;
    const form = document.createElement('form');
    form.className = 'budget-form';
    form.innerHTML = `
      <label class="budget-field">
        <span>Savings goal per pay period</span>
        <input type="text" inputmode="decimal" class="input" name="goal" required
               value="${esc(inputValueFromCents(current))}" placeholder="150.00">
        <span style="font-size:var(--fs-xs);color:var(--text-faint);font-weight:400;">The Month view doubles this (two pay periods per month). Set to 0 to hide the goal bar.</span>
      </label>
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">Save goal</button>
      </div>
    `;
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const goal = centsFromInput(String(new FormData(form).get('goal') || '0'));
      global.Pike.state.commit((d) => {
        if (!d.budget.settings) d.budget.settings = {};
        d.budget.settings.savingsGoalCents = Math.max(0, goal);
      });
      global.Pike.modal.close();
    });
    global.Pike.modal.open({ title: 'Savings goal', body: form });
  }

  function buildSavingsCard() {
    const b = getBudget();
    const savings = (b.accounts || []).filter((a) => !a.archived && a.type === 'savings');
    if (!savings.length) return null;
    const period = dashScopePeriod();
    if (!period) return null;

    const scopeMult = dashScope === 'month' ? 2 : 1;
    const goal = ((b.settings && b.settings.savingsGoalCents) || 0) * scopeMult;
    const saved = savedInPeriodCents(period);
    const balance = savings.reduce((s, a) => s + accountBalance(a), 0);

    const card = document.createElement('section');
    card.className = 'budget-sweep';

    const head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:baseline;justify-content:space-between;gap:var(--space-3);width:100%;';
    const title = document.createElement('h3');
    title.className = 'budget-sweep-title';
    title.textContent = 'Savings';
    head.appendChild(title);
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'budget-top-cats-viewall';
    editBtn.textContent = 'Edit goal';
    editBtn.addEventListener('click', openSavingsGoalModal);
    head.appendChild(editBtn);
    card.appendChild(head);

    const line = document.createElement('p');
    line.className = 'budget-sweep-line';
    line.textContent = `${savings.length === 1 ? savings[0].name.replace(/\s*\.\.\..*$/, '') : 'Savings accounts'} hold${savings.length === 1 ? 's' : ''} ${formatCents(balance)}`;
    card.appendChild(line);

    const headline = document.createElement('p');
    headline.className = 'budget-sweep-amount';
    const scopeWord = dashScope === 'month' ? 'this month' : 'this period';
    headline.textContent = goal > 0
      ? `${formatCents(saved)} saved ${scopeWord} of ${formatCents(goal)} goal`
      : `${formatCents(saved)} saved ${scopeWord}`;
    card.appendChild(headline);

    if (goal > 0) {
      const bar = document.createElement('div');
      bar.className = 'budget-pp-bar';
      bar.style.width = '100%';
      const fill = document.createElement('div');
      fill.className = 'budget-pp-bar-fill budget-savings-bar-fill';
      fill.style.width = Math.max(0, Math.min(100, Math.round((saved / goal) * 100))) + '%';
      bar.appendChild(fill);
      card.appendChild(bar);
    }

    if (goal > saved) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm';
      btn.textContent = 'Log savings transfer';
      const everyday = (b.accounts || []).find(
        (a) => !a.archived && a.type === 'checking' && /everyday/i.test(a.name)
      ) || (b.accounts || []).find((a) => !a.archived && a.type === 'checking');
      btn.addEventListener('click', () => openTransferModal(null, {
        fromAccountId: everyday ? everyday.id : '',
        toAccountId: savings[0].id,
        amountCents: goal - saved,
        description: 'Savings commitment',
      }));
      card.appendChild(btn);
    }
    return card;
  }

  function buildSweepCard() {
    const b = getBudget();
    const period = activePeriod();
    if (!period) return null;
    const everyday = (b.accounts || []).find(
      (a) => !a.archived && a.type === 'checking' && /everyday/i.test(a.name)
    ) || (b.accounts || []).find((a) => !a.archived && a.type === 'checking');
    if (!everyday) return null;

    const bal = accountBalance(everyday);
    const bills = upcomingBillsThrough(period.endDate, everyday.id);
    const sweepable = bal - bills.totalCents;

    const card = document.createElement('section');
    card.className = 'budget-sweep';
    const title = document.createElement('h3');
    title.className = 'budget-sweep-title';
    title.textContent = 'Sweep check';
    card.appendChild(title);

    const line = document.createElement('p');
    line.className = 'budget-sweep-line';
    const billBit = bills.count
      ? `≈${formatCents(bills.totalCents)} in ${bills.count} bill${bills.count === 1 ? '' : 's'} before ${fmtDateShort(period.endDate)}`
      : `no bills due before ${fmtDateShort(period.endDate)}`;
    line.textContent = `Everyday Checking holds ${formatCents(bal)} · ${billBit}`;
    card.appendChild(line);

    const headline = document.createElement('p');
    headline.className = 'budget-sweep-amount';
    headline.textContent = sweepable > 0
      ? `≈${formatCents(sweepable)} safe to sweep toward debt`
      : 'Nothing safely sweepable right now';
    if (sweepable <= 0) headline.classList.add('is-none');
    card.appendChild(headline);

    if (sweepable > 0) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-ghost btn-sm';
      btn.textContent = 'Log sweep transfer';
      btn.addEventListener('click', () => openTransferModal(null, {
        fromAccountId: everyday.id,
        amountCents: sweepable,
        description: 'Month-end sweep toward debt',
      }));
      card.appendChild(btn);
    }
    return card;
  }

  function buildPayPeriodHeadline() {
    const period = dashScopePeriod();
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

    // Label row with the Period ⇄ Month scope toggle
    const labelRow = document.createElement('div');
    labelRow.className = 'budget-pp-label-row';
    const label = document.createElement('p');
    label.className = 'budget-pp-label';
    label.textContent = period.label || 'Current period';
    labelRow.appendChild(label);
    const scopeWrap = document.createElement('div');
    scopeWrap.className = 'budget-pp-scope';
    [['period', 'Period'], ['month', 'Month']].forEach(([id, text]) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'budget-pp-scope-btn' + (dashScope === id ? ' is-active' : '');
      btn.textContent = text;
      btn.addEventListener('click', () => {
        dashScope = id;
        try { localStorage.setItem('pike.budget.dashscope', id); } catch (_) {}
        render();
      });
      scopeWrap.appendChild(btn);
    });
    labelRow.appendChild(scopeWrap);
    card.appendChild(labelRow);

    const headline = document.createElement('p');
    headline.className = 'budget-pp-headline is-link';
    headline.title = 'View these transactions';
    headline.textContent = spent < 0
      ? `${formatCents(Math.abs(spent))} net credit`
      : `${formatCents(spent)} spent`;
    const headlineScope = String(period.id).startsWith('month:') ? period.id : 'period:' + period.id;
    headline.addEventListener('click', () => gotoTransactionsFiltered(null, headlineScope));
    card.appendChild(headline);

    // Status in plain words — never a bare unexplained number. This is the
    // budget view (plan vs actual); bank balances live in the glance above.
    const sub = document.createElement('p');
    sub.className = 'budget-pp-sub';
    const dayLabel = daysLeft === 0 ? 'last day' : (daysLeft === 1 ? '1 day left' : `${daysLeft} days left`);
    let statusBit;
    if (spent < 0)             statusBit = 'refunds exceed spending';
    else if (remaining >= 0)   statusBit = `${formatCents(remaining)} left of ${formatCents(expected)} planned`;
    else                       statusBit = `${formatCents(Math.abs(remaining))} over the ${formatCents(expected)} plan`;
    sub.textContent = `${statusBit} · ${dayLabel}`;
    if (remaining < 0 && spent >= 0) sub.classList.add('is-over');
    card.appendChild(sub);

    // Bills still to come inside this scope — context the balance needs.
    const stillToCome = upcomingBillsThrough(period.endDate, null);
    if (stillToCome.count > 0) {
      const stc = document.createElement('p');
      stc.className = 'budget-pp-debt';
      stc.textContent = `${stillToCome.count} bill${stillToCome.count === 1 ? '' : 's'} still to come by ${fmtDateShort(period.endDate)} · ≈${formatCents(stillToCome.totalCents)}`;
      card.appendChild(stc);
    }

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

    // Interest & fees — real cost, but not a spending choice, so it lives
    // outside the "spent" gauge on its own quiet line.
    const fees = periodFeesCents(period);
    if (fees > 0) {
      const feesLine = document.createElement('p');
      feesLine.className = 'budget-pp-debt';
      feesLine.textContent = `${formatCents(fees)} in interest & fees accrued · not counted in spent`;
      card.appendChild(feesLine);
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

    const stats = document.createElement('div');
    stats.className = 'budget-card-stats';
    cardStats(view.id).forEach(({ value, label }) => {
      const stat = document.createElement('div');
      stat.className = 'budget-card-stat';
      const v = document.createElement('span');
      v.className = 'budget-card-stat-value';
      v.textContent = value;
      const l = document.createElement('span');
      l.className = 'budget-card-stat-label';
      l.textContent = label;
      stat.appendChild(v);
      stat.appendChild(l);
      stats.appendChild(stat);
    });

    card.appendChild(title);
    card.appendChild(blurb);
    card.appendChild(stats);

    card.addEventListener('click', () => gotoView(view.id));
    return card;
  }

  // One or two {value, label} stats per drill-down card — value on top in
  // mono, quiet label beneath. Replaces the old single cramped status line.
  function cardStats(viewId) {
    const b = getBudget();
    if (!b) return [];
    if (viewId === 'accounts') {
      const accs = (b.accounts || []).filter((a) => !a.archived);
      if (!accs.length) return [{ value: '—', label: 'no accounts yet' }];
      const total = accs.reduce((sum, a) => sum + accountBalance(a), 0);
      return [
        { value: formatCents(total), label: 'net worth on file' },
        { value: String(accs.length), label: accs.length === 1 ? 'account' : 'accounts' },
      ];
    }
    if (viewId === 'debts') {
      const debts = (b.debts || []);
      const debtAccounts = (b.accounts || []).filter(
        (a) => !a.archived && DEBT_ACCOUNT_TYPES.includes(a.type)
      );
      if (!debtAccounts.length && !debts.length) return [{ value: '—', label: 'no debts tracked' }];
      const owed = debtAccounts.reduce((sum, a) => {
        const dbt = debts.find((d) => d.accountId === a.id);
        const amort = dbt ? amortizedDebtStatus(dbt) : null;
        return sum + (amort ? amort.balance : Math.abs(accountBalance(a)));
      }, 0);
      const period = activePeriod();
      const paid = period ? debtPaidThisPeriodCents(period) : 0;
      const stats = [{ value: formatCents(owed), label: 'owed' }];
      if (paid > 0) stats.push({ value: formatCents(paid), label: 'paid this period' });
      else stats.push({ value: String(debtAccounts.length), label: debtAccounts.length === 1 ? 'account' : 'accounts' });
      return stats;
    }
    if (viewId === 'payperiods') {
      const period = activePeriod();
      const total = (b.payPeriods || []).length;
      if (!total) return [{ value: '—', label: 'no pay periods yet' }];
      const stats = [];
      if (period) stats.push({ value: period.label, label: 'active now' });
      stats.push({ value: String(total), label: 'total' });
      return stats;
    }
    if (viewId === 'transactions') {
      const period = activePeriod();
      const txns = (b.transactions || []).filter((t) => !t.plaidRemoved);
      if (!txns.length) return [{ value: '—', label: 'no transactions yet' }];
      const stats = [];
      if (period) {
        const inPeriod = txns.filter((t) => t.date >= period.startDate && t.date <= period.endDate).length;
        stats.push({ value: String(inPeriod), label: 'this period' });
      } else {
        stats.push({ value: String(txns.length), label: 'total' });
      }
      const uncat = txns.filter((t) =>
        t.kind !== 'transfer' && t.kind !== 'debt-payment' &&
        !t.categoryId && !(Array.isArray(t.splits) && t.splits.length)
      ).length;
      if (uncat > 0) stats.push({ value: String(uncat), label: 'uncategorized' });
      return stats;
    }
    if (viewId === 'recurring') {
      const today = todayKey();
      const bills = (b.recurringBills || []).filter(
        (r) => !r.archived && (!r.endDate || r.endDate >= today)
      );
      if (!bills.length) return [{ value: '—', label: 'no recurring yet' }];
      const upcomingCount = bills.reduce((n, bill) => n + upcomingOccurrences(bill, 14).length, 0);
      const monthly = bills.reduce((n, bill) => n + monthlyCentsForBill(bill), 0);
      return [
        { value: `${formatCents(monthly, { hideCents: true })}/mo`, label: 'committed' },
        { value: String(upcomingCount), label: 'due in 14 days' },
      ];
    }
    return [];
  }

  function buildTopCategoriesCard() {
    const period = dashScopePeriod();
    if (!period) return null;
    const scopeValue = String(period.id).startsWith('month:') ? period.id : 'period:' + period.id;

    const b = getBudget();
    const categories = b.categories || [];
    const excluded = excludedFromSpendingCatIds();
    const catIds = [...categoriesWithSpendingInPeriod(period)].filter((id) => !excluded.has(id));

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
    title.textContent = dashScope === 'month' ? 'Top categories this month' : 'Top categories this period';
    head.appendChild(title);

    const viewAll = document.createElement('button');
    viewAll.type      = 'button';
    viewAll.className = 'budget-top-cats-viewall';
    viewAll.textContent = 'View all →';
    viewAll.addEventListener('click', () => {
      if (String(period.id).startsWith('month:')) {
        gotoTransactionsFiltered(null, period.id);
      } else {
        activeView    = 'payperiods';
        activePeriodId = period.id;
        render();
      }
    });
    head.appendChild(viewAll);
    card.appendChild(head);

    const list = document.createElement('div');
    list.className = 'budget-top-cats-list';

    top.forEach(({ cat, spent, allocCents }) => {
      const row = document.createElement('div');
      row.className = 'budget-top-cats-row is-clickable';
      row.addEventListener('click', () => gotoTransactionsFiltered(cat.id, scopeValue));

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
    const b = getBudget();
    const bills = (b.recurringBills || []).filter((r) => !r.archived);
    const today = todayKey();

    // Horizon: the rest of the current period plus the entire next one, so
    // each section shows a complete picture with its own still-to-come total.
    // Without periods, fall back to a flat 14-day window.
    const period = activePeriod();
    const nextPeriod = period
      ? (b.payPeriods || []).slice().sort((x, y) => x.startDate.localeCompare(y.startDate))
          .find((p) => p.startDate > period.endDate)
      : null;
    const horizonDate = nextPeriod ? nextPeriod.endDate : (period ? period.endDate : addDaysIso(today, 14));
    const days = Math.max(1, daysBetween(today, horizonDate));

    const occurrences = [];
    bills.forEach((bill) => {
      upcomingOccurrences(bill, days).forEach((dateStr) => {
        if (dateStr > horizonDate) return;
        occurrences.push({ bill, date: dateStr });
      });
    });
    if (!occurrences.length) return null;
    occurrences.sort((a, b2) => a.date.localeCompare(b2.date));

    const tile = document.createElement('section');
    tile.className = 'budget-upcoming';
    const title = document.createElement('h3');
    title.className = 'budget-upcoming-title';
    title.textContent = 'Upcoming bills';
    tile.appendChild(title);

    const groups = period
      ? [
          { label: `This period · through ${fmtDateShort(period.endDate)}`,
            items: occurrences.filter((o) => o.date <= period.endDate) },
          { label: nextPeriod
              ? `Next period · ${fmtDateShort(nextPeriod.startDate)} – ${fmtDateShort(nextPeriod.endDate)}`
              : 'Beyond this period',
            items: occurrences.filter((o) => o.date > period.endDate) },
        ]
      : [{ label: 'Next 14 days', items: occurrences }];

    groups.forEach((group) => {
      if (!group.items.length) return;
      const toCome = group.items.reduce(
        (sum, { bill, date }) => sum + (occurrencePaidTxn(bill, date) ? 0 : (bill.amountCents || 0)), 0
      );
      const subhead = document.createElement('div');
      subhead.className = 'budget-upcoming-subhead';
      const lbl = document.createElement('span');
      lbl.textContent = group.label;
      const amt = document.createElement('span');
      amt.textContent = toCome > 0 ? `≈${formatCents(toCome)} to come` : 'all paid ✓';
      subhead.appendChild(lbl);
      subhead.appendChild(amt);
      tile.appendChild(subhead);

      const list = document.createElement('div');
      list.className = 'budget-upcoming-list';
      group.items.forEach(({ bill, date }) => {
        list.appendChild(buildUpcomingRow(bill, date));
      });
      tile.appendChild(list);
    });
    return tile;
  }

  function buildUpcomingRow(bill, dateStr) {
    const paidTxn = occurrencePaidTxn(bill, dateStr);

    const row = document.createElement('div');
    row.className = 'budget-upcoming-row' + (paidTxn ? ' is-paid' : '');

    const main = document.createElement('div');
    main.className = 'budget-upcoming-main';
    const name = document.createElement('span');
    name.className = 'budget-upcoming-name';
    name.textContent = bill.name;
    const due = document.createElement('span');
    due.className = 'budget-upcoming-due' + (paidTxn ? ' is-paid' : '');
    if (paidTxn) {
      due.textContent = `✓ paid ${fmtDateShort(paidTxn.date)}`;
    } else {
      const days = daysBetween(todayKey(), dateStr);
      due.textContent = days === 0 ? 'today' : days === 1 ? 'tomorrow' : days <= 7 ? `in ${days} days` : fmtDateShort(dateStr);
    }
    main.appendChild(name);
    main.appendChild(due);

    const amount = document.createElement('span');
    amount.className = 'budget-upcoming-amount';
    amount.textContent = formatCents(paidTxn ? paidTxn.amountCents : (bill.amountCents || 0));

    row.appendChild(main);
    row.appendChild(amount);
    if (paidTxn) {
      const spacer = document.createElement('span');
      row.appendChild(spacer);
    } else {
      const logBtn = document.createElement('button');
      logBtn.type = 'button';
      logBtn.className = 'btn btn-ghost btn-sm';
      logBtn.textContent = 'Log now';
      logBtn.addEventListener('click', () => openLogBillFlow(bill, dateStr));
      row.appendChild(logBtn);
    }
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

  // ─── Transfer / card-payment matcher ─────────────────────────────────────────
  // Imports capture both sides of one money movement as separate transactions:
  // an Amex payment arrives as a checking outflow AND a card-side credit. Left
  // as-is they inflate spending and income. This finds likely pairs — equal
  // amounts, opposite directions, different accounts, within 3 days — and lets
  // the user link them into a proper transfer/debt-payment pair. Suggestion
  // only; linking is always an explicit user action.

  function transferSuggestKey(outId, inId) { return `${outId}|${inId}`; }

  function findTransferCandidates() {
    const b = getBudget();
    if (!b) return [];
    const dismissed = new Set(b.dismissedTransferSuggestions || []);
    const eligible = (b.transactions || []).filter((t) =>
      !t.plaidRemoved &&
      !t.transferPairId &&
      t.plaidTransactionId &&  // imported only — manual entries are intentional
      (t.kind === 'spending' || t.kind === 'income')
    );
    const used = new Set();
    const pairs = [];
    const WINDOW_DAYS = 5;  // posting lag between the two sides varies

    // Pass 1: classic pairs — equal amounts, opposite directions.
    const inflows = eligible.filter((t) => t.direction === 'inflow');
    eligible.filter((t) => t.direction === 'outflow').forEach((out) => {
      let best = null;
      let bestGap = Infinity;
      inflows.forEach((inn) => {
        if (used.has(inn.id) || inn.accountId === out.accountId) return;
        if (inn.amountCents !== out.amountCents) return;
        if (dismissed.has(transferSuggestKey(out.id, inn.id))) return;
        const gap = Math.abs(daysBetween(out.date, inn.date));
        if (gap > WINDOW_DAYS || gap >= bestGap) return;
        best = inn; bestGap = gap;
      });
      if (best) { used.add(best.id); used.add(out.id); pairs.push({ out, inn: best, fixDirection: false }); }
    });

    // Pass 2: sign-corrected card payments. Some feeds (PayPal Credit) report
    // the card-side payment credit as an OUTFLOW. Recognize it narrowly: the
    // card-side MERCHANT reads like a payment marker, amounts equal, and the
    // other side is a non-debt account. Linking corrects the direction.
    const debtAcctIds = new Set(
      (b.accounts || []).filter((a) => !a.archived && DEBT_ACCOUNT_TYPES.includes(a.type)).map((a) => a.id)
    );
    const marker = /payment|pymt|autopay|thank you|credit card/i;
    const cardOuts = eligible.filter((t) =>
      t.direction === 'outflow' && debtAcctIds.has(t.accountId) && marker.test(t.merchant || '')
    );
    eligible.filter((t) => t.direction === 'outflow' && !debtAcctIds.has(t.accountId)).forEach((out) => {
      if (used.has(out.id)) return;
      let best = null;
      let bestGap = Infinity;
      cardOuts.forEach((co) => {
        if (used.has(co.id) || co.accountId === out.accountId) return;
        if (co.amountCents !== out.amountCents) return;
        if (dismissed.has(transferSuggestKey(out.id, co.id))) return;
        const gap = Math.abs(daysBetween(out.date, co.date));
        if (gap > WINDOW_DAYS || gap >= bestGap) return;
        best = co; bestGap = gap;
      });
      if (best) { used.add(best.id); used.add(out.id); pairs.push({ out, inn: best, fixDirection: true }); }
    });
    return pairs;
  }

  function linkAsTransferPair(outId, inId, fixDirection) {
    global.Pike.state.commit((d) => {
      const txns = d.budget.transactions || [];
      const out = txns.find((t) => t.id === outId);
      const inn = txns.find((t) => t.id === inId);
      if (!out || !inn) return;
      // Correct a feed-side sign error (card payments reported as outflows).
      if (fixDirection) inn.direction = 'inflow';
      const destType = ((d.budget.accounts || []).find((a) => a.id === inn.accountId) || {}).type;
      const kind = DEBT_ACCOUNT_TYPES.includes(destType) ? 'debt-payment' : 'transfer';
      const now = new Date().toISOString();
      [out, inn].forEach((t) => {
        t.kind = kind;
        t.transferPairId = out.id;  // convention: pair id = outflow leg id
        t.categoryId = null;
        t.splits = null;
        t.updatedAt = now;
      });
    });
  }

  function dismissTransferSuggestion(outId, inId) {
    global.Pike.state.commit((d) => {
      if (!d.budget.dismissedTransferSuggestions) d.budget.dismissedTransferSuggestions = [];
      d.budget.dismissedTransferSuggestions.push(transferSuggestKey(outId, inId));
    });
  }

  function openTransferMatchModal() {
    const body = document.createElement('div');
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = 'var(--space-3)';

    function renderList() {
      body.innerHTML = '';
      const b = getBudget();
      const accountName = (id) => {
        const a = (b.accounts || []).find((x) => x.id === id);
        return a ? a.name : 'Unknown account';
      };
      const pairs = findTransferCandidates();

      if (!pairs.length) {
        const done = document.createElement('p');
        done.style.fontSize = 'var(--fs-sm)';
        done.style.color = 'var(--text-muted)';
        done.style.margin = '0';
        done.textContent = 'No more likely matches. New imports are re-checked automatically.';
        body.appendChild(done);
        return;
      }

      const desc = document.createElement('p');
      desc.style.fontSize = 'var(--fs-sm)';
      desc.style.color = 'var(--text-muted)';
      desc.style.margin = '0';
      desc.textContent = 'These imported pairs look like two sides of one movement. Linking excludes them from spending and counts card payments as debt paid.';
      body.appendChild(desc);

      pairs.forEach(({ out, inn, fixDirection }) => {
        const destType = ((b.accounts || []).find((a) => a.id === inn.accountId) || {}).type;
        const isPayment = DEBT_ACCOUNT_TYPES.includes(destType);

        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.flexDirection = 'column';
        row.style.gap = 'var(--space-2)';
        row.style.padding = 'var(--space-3) 0';
        row.style.borderTop = '1px dashed var(--line-soft)';

        const line = document.createElement('div');
        line.style.fontSize = 'var(--fs-sm)';
        line.textContent = `${fmtDateShort(out.date)} · ${formatCents(out.amountCents)} — ${accountName(out.accountId)} → ${accountName(inn.accountId)}`;
        row.appendChild(line);

        const sub = document.createElement('div');
        sub.style.fontSize = 'var(--fs-xs)';
        sub.style.color = 'var(--text-faint)';
        sub.textContent = `${out.merchant || out.description || 'No description'} · ${inn.merchant || inn.description || 'No description'}`
          + (fixDirection ? ' · card-side direction will be corrected' : '');
        row.appendChild(sub);

        const btns = document.createElement('div');
        btns.style.display = 'flex';
        btns.style.gap = 'var(--space-2)';

        const linkBtn = document.createElement('button');
        linkBtn.type = 'button';
        linkBtn.className = 'btn btn-primary btn-sm';
        linkBtn.textContent = isPayment ? 'Link as card payment' : 'Link as transfer';
        linkBtn.addEventListener('click', () => { linkAsTransferPair(out.id, inn.id, fixDirection); renderList(); });

        const skipBtn = document.createElement('button');
        skipBtn.type = 'button';
        skipBtn.className = 'btn btn-ghost btn-sm';
        skipBtn.textContent = 'Not a match';
        skipBtn.addEventListener('click', () => { dismissTransferSuggestion(out.id, inn.id); renderList(); });

        btns.appendChild(linkBtn);
        btns.appendChild(skipBtn);
        row.appendChild(btns);
        body.appendChild(row);
      });
    }

    renderList();
    global.Pike.modal.open({ title: 'Possible transfers & card payments', body });
  }

  function buildTransferMatchBanner(count) {
    const b = document.createElement('div');
    b.className = 'budget-banner budget-banner-matches';
    const text = document.createElement('p');
    text.className = 'budget-banner-text';
    text.textContent = count === 1
      ? '1 imported pair looks like a transfer or card payment.'
      : `${count} imported pairs look like transfers or card payments.`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-ghost btn-sm';
    btn.textContent = 'Review';
    btn.addEventListener('click', openTransferMatchModal);
    b.appendChild(text);
    b.appendChild(btn);
    return b;
  }

  // ─── Focused view dispatch ───────────────────────────────────────────────────

  function buildFocusedView(viewId) {
    const view = VIEWS.find((v) => v.id === viewId)
      || (viewId === 'rules'
        ? { id: 'rules', title: 'Rules', blurb: 'Auto-categorization for imported transactions. Higher priority wins when several rules match.' }
        : { id: viewId, title: viewId, blurb: '' });

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
    else if (viewId === 'rules')        body.appendChild(buildRulesView());
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
      rules:        '+ Rule',
    };
    const handlers = {
      accounts:     () => openAccountModal(null),
      debts:        () => openDebtModal(null),
      payperiods:   () => openPayPeriodModal(null),
      transactions: () => openTransactionModal(null, { kind: 'spending' }),
      recurring:    () => openRecurringModal(null),
      rules:        () => openRuleModal(null),
    };

    const addLabel = addLabels[viewId];
    if (!addLabel) return null;

    // Transactions view also gets "+ Transfer" and the Rules manager.
    if (viewId === 'transactions') {
      const rulesBtn = document.createElement('button');
      rulesBtn.type = 'button';
      rulesBtn.className = 'btn btn-ghost btn-sm';
      rulesBtn.textContent = 'Rules';
      rulesBtn.addEventListener('click', () => gotoView('rules'));
      wrap.appendChild(rulesBtn);
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

  // Fallbacks when budget.settings doesn't override them. Income merchants are
  // matched case-insensitively against merchant + description — "gusto" catches
  // every Gusto payroll deposit, on-cycle or off-cycle.
  const DEFAULT_EXPECTED_INCOME_CENTS = 381100;
  const DEFAULT_INCOME_MERCHANTS = ['gusto'];

  function semimonthlyLabel(startDate, endDate) {
    const day = parseInt(startDate.slice(8));
    const monthName = new Date(startDate + 'T12:00:00').toLocaleString('en-US', { month: 'short' });
    return day === 1 ? `${monthName} 1–15` : `${monthName} 16–${parseInt(endDate.slice(8))}`;
  }

  // Actual payroll income landing inside [startDate, endDate]: inflows to
  // checking/savings accounts whose merchant or description matches an income
  // merchant. Deliberately NOT all kind==='income' — imports classify every
  // inflow as income, including card-side payment credits and refunds.
  function payrollIncomeInRange(b, startDate, endDate) {
    const merchants = (b.settings && b.settings.incomeMerchants) || DEFAULT_INCOME_MERCHANTS;
    const depositAccounts = new Set(
      (b.accounts || [])
        .filter((a) => a.type === 'checking' || a.type === 'savings')
        .map((a) => a.id)
    );
    return (b.transactions || []).reduce((sum, t) => {
      if (t.plaidRemoved || t.direction !== 'inflow') return sum;
      if (!depositAccounts.has(t.accountId)) return sum;
      if (t.date < startDate || t.date > endDate) return sum;
      const text = `${t.merchant || ''} ${t.description || ''}`.toLowerCase();
      return merchants.some((m) => text.includes(m)) ? sum + t.amountCents : sum;
    }, 0);
  }

  // Missing semi-monthly periods from the earliest transaction/period through
  // 2 months ahead. Closed periods get expected income backfilled from actual
  // payroll deposits; current and future periods get the default — their
  // paycheck usually hasn't landed yet (Gusto pays at period end).
  function computeMissingPeriods(b) {
    const existing = b.payPeriods || [];
    const txns = (b.transactions || []).filter((t) => !t.plaidRemoved);
    const allStarts = [
      ...existing.map((p) => p.startDate),
      ...txns.map((t) => t.date),
    ].filter(Boolean).sort();
    const earliest = allStarts[0] || todayKey();

    const today = todayKey();
    const toDate = new Date(today);
    toDate.setMonth(toDate.getMonth() + 2);
    const toYYYYMM = toDate.toISOString().slice(0, 7);

    const candidates = semimonthlyPeriodsInRange(earliest.slice(0, 7), toYYYYMM);
    const defaultIncome = (b.settings && b.settings.defaultExpectedIncomeCents) || DEFAULT_EXPECTED_INCOME_CENTS;

    return candidates
      .filter((c) => !existing.some((p) => c.startDate <= p.endDate && c.endDate >= p.startDate))
      .map((c) => ({
        startDate: c.startDate,
        endDate:   c.endDate,
        expectedIncomeCents: c.endDate < today
          ? payrollIncomeInRange(b, c.startDate, c.endDate)
          : defaultIncome,
      }));
  }

  // Creates any missing periods on a draft state. Called inside the Plaid
  // import commit (via Pike.budget.ensurePayPeriods) so periods exist the
  // moment imported transactions land — and from the Generate modal below.
  // Existing periods are never modified. Returns the number created.
  function ensurePayPeriods(d) {
    if (!d.budget) return 0;
    const toCreate = computeMissingPeriods(d.budget);
    if (!toCreate.length) return 0;
    if (!d.budget.payPeriods) d.budget.payPeriods = [];
    // Default allocation templates, one per half-month (rent lands in one
    // half, so their budgets differ). Backfilled PAST periods stay empty —
    // stamping a plan onto history she never made would be dishonest.
    const templates = (d.budget.settings && d.budget.settings.defaultAllocations) || {};
    const today = todayKey();
    toCreate.forEach((c) => {
      const key = parseInt(c.startDate.slice(8), 10) <= 15 ? 'firstHalf' : 'secondHalf';
      const tmpl = (c.endDate >= today && templates[key]) ? templates[key] : [];
      d.budget.payPeriods.push({
        id:                  uid('pp'),
        label:               semimonthlyLabel(c.startDate, c.endDate),
        startDate:           c.startDate,
        endDate:             c.endDate,
        expectedIncomeCents: c.expectedIncomeCents,
        allocations:         tmpl.map((a) => ({ ...a })),
        notes:               '',
      });
    });
    d.budget.payPeriods.sort((a, b) => a.startDate.localeCompare(b.startDate));
    return toCreate.length;
  }

  function openGeneratePeriodsModal() {
    const b = getBudget();
    const toCreate = computeMissingPeriods(b);

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
      global.Pike.modal.open({ title: 'Generate pay periods', body });
      return;
    }

    const fromLabel = fmtDateShort(toCreate[0].startDate);
    const toLabel   = fmtDateShort(toCreate[toCreate.length - 1].endDate);
    const defaultIncome = (b.settings && b.settings.defaultExpectedIncomeCents) || DEFAULT_EXPECTED_INCOME_CENTS;
    desc.textContent = `This will create ${toCreate.length} semi-monthly periods (1st–15th and 16th–last day) from ${fromLabel} through ${toLabel}, skipping any that already exist. Past periods get expected income from the payroll deposits found in them; current and future periods start at ${formatCents(defaultIncome)}.`;
    body.appendChild(desc);

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'btn btn-primary btn-sm';
    confirmBtn.textContent = `Create ${toCreate.length} periods`;
    confirmBtn.addEventListener('click', () => {
      global.Pike.state.commit((d) => { ensurePayPeriods(d); });
      global.Pike.modal.close();
    });
    body.appendChild(confirmBtn);

    global.Pike.modal.open({ title: 'Generate pay periods', body });
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
    const b = getBudget();
    const debts = b.debts || [];
    const debtAccounts = (b.accounts || []).filter(
      (a) => !a.archived && DEBT_ACCOUNT_TYPES.includes(a.type)
    );
    const wrap = document.createElement('div');
    wrap.className = 'budget-list';

    if (!debtAccounts.length && !debts.length) {
      wrap.appendChild(buildEmpty('No debts tracked yet. Tap + Debt to add a credit card or loan.'));
      return wrap;
    }

    // One row per debt-type account — credit cards auto-included with their
    // live imported balance, no manual entry required. Debt entries whose
    // account was archived still render so history isn't hidden.
    const rows = debtAccounts.map((acc) => ({
      acc,
      dbt: debts.find((d) => d.accountId === acc.id) || null,
    }));
    debts.forEach((d) => {
      if (!rows.some((r) => r.dbt && r.dbt.id === d.id)) {
        rows.push({ acc: (b.accounts || []).find((a) => a.id === d.accountId) || null, dbt: d });
      }
    });

    // Total headline — amortized estimate where available, live balance otherwise.
    let cardsTotal = 0;
    let loansTotal = 0;
    rows.forEach(({ acc, dbt }) => {
      if (!acc) return;
      const amort = dbt ? amortizedDebtStatus(dbt) : null;
      const owed = amort ? amort.balance : Math.abs(accountBalance(acc));
      if (acc.type === 'loan') loansTotal += owed;
      else cardsTotal += owed;
    });
    if (cardsTotal + loansTotal > 0) {
      const head = document.createElement('div');
      head.className = 'budget-debts-total';
      const label = document.createElement('span');
      label.className = 'budget-debts-total-label';
      label.textContent = 'Total debt';
      const amt = document.createElement('span');
      amt.className = 'budget-debts-total-amount';
      amt.textContent = formatCents(cardsTotal + loansTotal);
      const split = document.createElement('span');
      split.className = 'budget-debts-total-split';
      split.textContent = `${formatCents(cardsTotal)} cards · ${formatCents(loansTotal)} loans`;
      head.appendChild(label);
      head.appendChild(amt);
      head.appendChild(split);
      wrap.appendChild(head);
    }

    // Loans first (richer progress lines), then cards, each alphabetical.
    rows.sort((x, y) => {
      const tx = x.acc ? x.acc.type : 'zz';
      const ty = y.acc ? y.acc.type : 'zz';
      if ((tx === 'loan') !== (ty === 'loan')) return tx === 'loan' ? -1 : 1;
      return (x.acc ? x.acc.name : '').localeCompare(y.acc ? y.acc.name : '');
    });
    rows.forEach(({ acc, dbt }) => wrap.appendChild(buildDebtRow(dbt, acc)));
    return wrap;
  }

  function buildDebtRow(dbt, accOverride) {
    const row = document.createElement('div');
    row.className = 'budget-row';

    const accounts = getBudget().accounts || [];
    const linked = accOverride || (dbt ? accounts.find((a) => a.id === dbt.accountId) : null);

    const main = document.createElement('div');
    main.className = 'budget-row-main';
    const name = document.createElement('h3');
    name.className = 'budget-row-name';
    name.textContent = linked ? linked.name : '(account missing)';
    const meta = document.createElement('p');
    meta.className = 'budget-row-meta';
    if (dbt) {
      const kindLabel = (DEBT_KINDS.find((k) => k.id === dbt.kind) || {}).label || dbt.kind;
      const apr = dbt.aprBps ? (dbt.aprBps / 100).toFixed(2) + '% APR' : '';
      const min = dbt.minimumPaymentCents ? `min ${formatCents(dbt.minimumPaymentCents)}/mo` : '';
      meta.textContent = [kindLabel, apr, min].filter(Boolean).join(' · ');
    } else {
      const typeLabel = (ACCOUNT_TYPES.find((t) => t.id === (linked && linked.type)) || {}).label || '';
      meta.textContent = `${typeLabel} · live balance from imported transactions`;
    }
    main.appendChild(name);
    main.appendChild(meta);

    // Progress line: amortized when the debt has APR + an anchored loan
    // account, otherwise the quiet naive estimate. Entry-less card rows skip it.
    const amort = dbt ? amortizedDebtStatus(dbt) : null;
    const progressText = !dbt ? null : (amort ? amortProgressLineText(dbt, amort) : debtProgressLineText(dbt));
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
    if (amort) {
      amount.textContent = formatCents(amort.balance);
      amount.classList.add('is-negative');
    } else if (linked) {
      const owedCents = Math.abs(accountBalance(linked));
      amount.textContent = formatCents(owedCents);
      amount.classList.add('is-negative');
    } else {
      amount.textContent = '—';
    }
    amountWrap.appendChild(amount);
    if (amort) {
      const stateLine = document.createElement('span');
      stateLine.className = 'budget-row-amount-state';
      stateLine.textContent = `amortized est. · anchored ${fmtDateShort(amort.anchorDate)}`;
      amountWrap.appendChild(stateLine);
    } else if (linked) {
      const stateLine = document.createElement('span');
      stateLine.className = 'budget-row-amount-state';
      stateLine.textContent = accountBalanceState(linked);
      amountWrap.appendChild(stateLine);
    }
    // Paid-this-period sub-line (works for entry-less rows via the account id)
    const paid = linked ? debtPaidForDebtThisPeriod(dbt || { accountId: linked.id }) : 0;
    if (paid > 0) {
      const paidLine = document.createElement('span');
      paidLine.className = 'budget-row-amount-state budget-row-amount-paid';
      paidLine.textContent = `Paid this period: ${formatCents(paid)}`;
      amountWrap.appendChild(paidLine);
    }

    const actions = document.createElement('div');
    actions.className = 'budget-row-actions';
    if (dbt) {
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
    } else {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'budget-action-btn';
      addBtn.textContent = 'Add details';
      addBtn.addEventListener('click', () => openDebtModal(null, linked && linked.id));
      actions.appendChild(addBtn);
    }

    row.appendChild(main);
    row.appendChild(amountWrap);
    row.appendChild(actions);
    return row;
  }

  function openDebtModal(existing, prefillAccountId) {
    const isEdit = !!existing;
    const dbt = existing || {};
    if (!isEdit && prefillAccountId) dbt.accountId = prefillAccountId;
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
        <span>Payment match (optional)</span>
        <input type="text" class="input" name="paymentMatchValue"
               value="${esc(dbt.paymentMatchValue || '')}" placeholder="e.g. launch servicing">
        <span style="font-size:var(--fs-xs);color:var(--text-faint);font-weight:400;">Text that identifies this loan's payments in imported transactions. With an APR, enables the amortized balance — interest vs principal — for servicers that aren't bank-connected.</span>
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
      const paymentMatchValue = String(fd.get('paymentMatchValue') || '').trim().toLowerCase() || null;
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
            x.paymentMatchValue = paymentMatchValue;
            x.notes = notes;
          }
        } else {
          d.budget.debts.push({
            id: uid('dbt'),
            accountId, kind, aprBps,
            minimumPaymentCents,
            targetPayoffDate,
            paymentMatchValue,
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

    // Interest & fees accrued in the period — outside the spent gauge.
    const fees = periodFeesCents(period);
    if (fees > 0) {
      const feesLine = document.createElement('p');
      feesLine.className = 'budget-period-debt-paid';
      feesLine.textContent = `${formatCents(fees)} in interest & fees accrued · not counted in spent`;
      wrap.appendChild(feesLine);
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
        period,
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
          period,
        }));
      });
    }

    wrap.appendChild(list);
    return wrap;
  }

  function buildCategoryBreakdownRow({ cat, allocatedCents, spentCents, unallocated, period }) {
    const row = document.createElement('div');
    row.className = 'budget-cat-row' + (unallocated ? ' is-unallocated' : '');
    if (period && period.id) {
      row.classList.add('is-clickable');
      row.title = `View ${cat.name} transactions`;
      row.addEventListener('click', () => gotoTransactionsFiltered(cat.id, 'period:' + period.id));
    }

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

    // Default-allocations template. Semi-monthly halves get separate
    // templates — rent lands in one half, so their budgets differ.
    const defaultsWrap = document.createElement('label');
    defaultsWrap.className = 'budget-field';
    defaultsWrap.style.cssText = 'flex-direction:row;align-items:center;gap:var(--space-2);';
    defaultsWrap.innerHTML = `
      <input type="checkbox" name="saveDefault" style="width:16px;height:16px;">
      <span style="font-size:var(--fs-sm);font-weight:400;text-transform:none;letter-spacing:0;" id="budget-pp-default-label"></span>
    `;
    form.appendChild(defaultsWrap);
    function refreshDefaultLabel() {
      const sd = form.querySelector('input[name="startDate"]').value || todayKey();
      const half = parseInt(sd.slice(8), 10) <= 15 ? '1st–15th' : '16th–end-of-month';
      form.querySelector('#budget-pp-default-label').textContent =
        `Save these allocations as the default for every ${half} period — applies to current and upcoming ones that have none, and to all newly generated ones`;
    }
    refreshDefaultLabel();
    form.querySelector('input[name="startDate"]').addEventListener('change', refreshDefaultLabel);

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

      const saveDefault = !!fd.get('saveDefault');

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

        // Save as the default template for this half of the month, and fill
        // current/upcoming same-half periods that have no allocations yet.
        // Hand-edited periods and past periods are never touched.
        if (saveDefault) {
          if (!d.budget.settings) d.budget.settings = {};
          if (!d.budget.settings.defaultAllocations) d.budget.settings.defaultAllocations = {};
          const half = (sd) => (parseInt(sd.slice(8), 10) <= 15 ? 'firstHalf' : 'secondHalf');
          const key = half(startDate);
          d.budget.settings.defaultAllocations[key] = allocations.map((a) => ({ ...a }));
          const today = todayKey();
          d.budget.payPeriods.forEach((p) => {
            if (p.endDate < today) return;
            if (half(p.startDate) !== key) return;
            if ((p.allocations || []).length) return;
            p.allocations = allocations.map((a) => ({ ...a }));
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

    const b = getBudget();
    const allTxns = b.transactions || [];

    // ── Search box — matches merchant, description, and notes ─────────────
    const searchWrap = document.createElement('div');
    searchWrap.className = 'budget-tx-search-wrap';
    const searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.id = 'budget-tx-search';
    searchInput.className = 'input budget-tx-search';
    searchInput.placeholder = 'Search merchant, description, or notes…';
    searchInput.value = txSearch;
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        txSearch = searchInput.value;
        selectedTxnIds = new Set();
        render();
        // render() rebuilds the DOM — put the cursor back where she's typing.
        const el = document.getElementById('budget-tx-search');
        if (el) {
          el.focus();
          const n = el.value.length;
          try { el.setSelectionRange(n, n); } catch (_) {}
        }
      }, 200);
    });
    searchWrap.appendChild(searchInput);
    wrap.appendChild(searchWrap);

    // ── Filter & sort selects ──────────────────────────────────────────────
    const selects = document.createElement('div');
    selects.className = 'budget-tx-selects';

    const mkSelect = (options, current, onChange, ariaLabel) => {
      const sel = document.createElement('select');
      sel.className = 'input budget-tx-select';
      sel.setAttribute('aria-label', ariaLabel);
      options.forEach(([value, text]) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = text;
        if (value === current) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => {
        onChange(sel.value);
        selectedTxnIds = new Set();
        render();
      });
      return sel;
    };

    const accountOpts = [['', 'All accounts']].concat(
      (b.accounts || []).filter((a) => !a.archived)
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((a) => [a.id, a.name])
    );
    selects.appendChild(mkSelect(accountOpts, txAccountFilter, (v) => { txAccountFilter = v; }, 'Filter by account'));

    const categoryOpts = [['', 'All categories']].concat(
      (b.categories || []).filter((c) => !c.archived)
        .sort((x, y) => x.name.localeCompare(y.name))
        .map((c) => [c.id, c.name])
    );
    selects.appendChild(mkSelect(categoryOpts, txCategoryFilter, (v) => { txCategoryFilter = v; }, 'Filter by category'));

    // Date scope: months (from actual transaction dates) and pay periods.
    const monthSet = new Set(allTxns.filter((t) => !t.plaidRemoved && t.date).map((t) => t.date.slice(0, 7)));
    const monthOpts = [...monthSet].sort().reverse().map((ym) => {
      const [y, m] = ym.split('-').map(Number);
      return ['month:' + ym, new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })];
    });
    const periodOpts = (b.payPeriods || []).slice()
      .sort((x, y) => y.startDate.localeCompare(x.startDate))
      .map((p) => ['period:' + p.id, `${p.label} (${p.startDate.slice(0, 4)})`]);
    selects.appendChild(mkSelect(
      [['', 'All dates']].concat(monthOpts).concat(periodOpts),
      txScopeFilter, (v) => { txScopeFilter = v; }, 'Filter by date range'
    ));

    selects.appendChild(mkSelect([
      ['date-desc',    'Newest first'],
      ['date-asc',     'Oldest first'],
      ['amount-desc',  'Largest first'],
      ['amount-asc',   'Smallest first'],
      ['merchant-asc', 'By merchant'],
    ], txSort, (v) => { txSort = v; }, 'Sort order'));

    if (txAccountFilter || txCategoryFilter || txScopeFilter || txSearch.trim()) {
      const clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'budget-action-btn';
      clearBtn.textContent = 'Clear filters';
      clearBtn.addEventListener('click', () => {
        txSearch = '';
        txAccountFilter = '';
        txCategoryFilter = '';
        txScopeFilter = '';
        selectedTxnIds = new Set();
        render();
      });
      selects.appendChild(clearBtn);
    }
    wrap.appendChild(selects);

    let visible = allTxns.filter((t) => !t.plaidRemoved);
    const q = txSearch.trim().toLowerCase();
    if (q) {
      visible = visible.filter((t) =>
        `${t.merchant || ''} ${t.description || ''} ${t.notes || ''}`.toLowerCase().includes(q)
      );
    }
    if (txFilter === 'unassigned') {
      visible = visible.filter((t) => !periodForDate(t.date));
    } else if (txFilter === 'uncategorized') {
      visible = visible.filter((t) =>
        t.kind !== 'transfer' && t.kind !== 'debt-payment' &&
        !t.categoryId && !(Array.isArray(t.splits) && t.splits.length)
      );
    }
    if (txAccountFilter) {
      visible = visible.filter((t) => t.accountId === txAccountFilter);
    }
    if (txCategoryFilter) {
      visible = visible.filter((t) =>
        t.categoryId === txCategoryFilter ||
        (Array.isArray(t.splits) && t.splits.some((s) => s.categoryId === txCategoryFilter))
      );
    }
    if (txScopeFilter.startsWith('month:')) {
      const ym = txScopeFilter.slice(6);
      visible = visible.filter((t) => (t.date || '').slice(0, 7) === ym);
    } else if (txScopeFilter.startsWith('period:')) {
      const p = (b.payPeriods || []).find((x) => x.id === txScopeFilter.slice(7));
      if (p) visible = visible.filter((t) => t.date >= p.startDate && t.date <= p.endDate);
    }
    // Hide inflow legs of transfers (one row per pair, the outflow leg) —
    // unless the account filter points AT the receiving account, where the
    // inflow leg is the one that belongs in the list.
    visible = visible.filter((t) => {
      if (t.kind !== 'transfer' && t.kind !== 'debt-payment') return true;
      if (txAccountFilter) return t.accountId === txAccountFilter;
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
        q ? `No transactions match “${txSearch.trim()}”.` :
        (txAccountFilter || txCategoryFilter || txScopeFilter) ? 'No transactions match these filters.' :
        txFilter === 'unassigned'    ? 'No unassigned transactions.' :
        txFilter === 'uncategorized' ? 'No uncategorized transactions.' :
        'No transactions yet. Tap + Transaction to log one, or + Transfer to move money.'
      ));
      return wrap;
    }

    visible.sort((a, b2) => {
      if (txSort === 'amount-desc') return (b2.amountCents || 0) - (a.amountCents || 0);
      if (txSort === 'amount-asc')  return (a.amountCents || 0) - (b2.amountCents || 0);
      if (txSort === 'merchant-asc') {
        const ma = (a.merchant || a.description || '').toLowerCase();
        const mb = (b2.merchant || b2.description || '').toLowerCase();
        const cmpM = ma.localeCompare(mb);
        if (cmpM !== 0) return cmpM;
        return b2.date.localeCompare(a.date);
      }
      const cmp = txSort === 'date-asc'
        ? a.date.localeCompare(b2.date)
        : b2.date.localeCompare(a.date);
      if (cmp !== 0) return cmp;
      return (b2.createdAt || '').localeCompare(a.createdAt || '');
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
      <label class="budget-field">
        <span>End date (optional — for installment plans)</span>
        <input type="date" class="input" name="endDate" value="${esc((existingBill || {}).endDate || '')}">
      </label>
      ${tx.merchant ? `
      <label class="budget-field" style="flex-direction:row;align-items:center;gap:var(--space-2);">
        <input type="checkbox" name="makeRule" ${tx.categoryId ? '' : 'checked'} style="width:16px;height:16px;">
        <span style="font-size:var(--fs-sm);font-weight:400;text-transform:none;letter-spacing:0;">Remember "${esc(tx.merchant)}" — auto-categorize future imports with the category above</span>
      </label>` : ''}
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
      const endDate          = String(fd.get('endDate') || '').trim() || null;
      const makeRule         = !!fd.get('makeRule');
      const matchValue       = (tx.merchant || '').toLowerCase().trim() || null;
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
            b.anchorDate = anchorDate; b.endDate = endDate;
            if (!b.matchValue && matchValue) b.matchValue = matchValue;
          }
        } else {
          billId = uid('rec');
          d.budget.recurringBills.push({
            id: billId, name, amountCents,
            categoryId, accountId, counterAccountId,
            cadence, anchorDate, endDate,
            matchValue,
            autopay: false, notes: '', archived: false,
          });
        }
        // Link the transaction — links only; kind and amount stay untouched.
        const t = (d.budget.transactions || []).find((x) => x.id === tx.id);
        if (t) { t.recurringBillId = billId; t.updatedAt = now; }

        // One-gesture "this is a subscription now": also create a category
        // rule for the merchant so every future import self-categorizes, and
        // categorize this transaction if it wasn't already.
        if (makeRule && matchValue && categoryId) {
          if (!d.budget.rules) d.budget.rules = [];
          let rule = d.budget.rules.find((r) =>
            r.matchType === 'merchantContains' && r.matchValue === matchValue
          );
          if (!rule) {
            rule = { id: uid('rul'), matchType: 'merchantContains', matchValue,
                     categoryId, priority: 50, enabled: true };
            d.budget.rules.push(rule);
          }
          if (t && !t.categoryId) { t.categoryId = categoryId; t.ruleAppliedId = rule.id; }
        }
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({
      title: existingBill ? 'Edit recurring bill' : 'Mark as recurring',
      body: form,
    });
  }

  // ─── Rules manager ───────────────────────────────────────────────────────────
  // Every rule that auto-categorizes imports, in one place: browse, create,
  // edit, disable, delete. Creating a rule can backfill existing
  // uncategorized transactions in the same commit.

  function buildRulesView() {
    const b = getBudget();
    const rules = (b.rules || []).slice();
    const wrap = document.createElement('div');
    wrap.className = 'budget-list';

    if (!rules.length) {
      wrap.appendChild(buildEmpty('No rules yet. Tap + Rule, or use "Remember this merchant" when categorizing.'));
      return wrap;
    }

    // Matched-transaction counts — a rule that never fires is a candidate
    // for cleanup; a heavy hitter deserves care when editing.
    const matchCounts = {};
    (b.transactions || []).forEach((t) => {
      if (t.ruleAppliedId) matchCounts[t.ruleAppliedId] = (matchCounts[t.ruleAppliedId] || 0) + 1;
    });

    rules.sort((x, y) => {
      if (!!x.enabled !== !!y.enabled) return x.enabled ? -1 : 1;
      return (x.matchValue || '').localeCompare(y.matchValue || '');
    });
    rules.forEach((rule) => wrap.appendChild(buildRuleRow(rule, matchCounts[rule.id] || 0)));
    return wrap;
  }

  function buildRuleRow(rule, matchCount) {
    const b = getBudget();
    const cat = (b.categories || []).find((c) => c.id === rule.categoryId);

    const row = document.createElement('div');
    row.className = 'budget-row' + (rule.enabled ? '' : ' budget-rule-off');

    const main = document.createElement('div');
    main.className = 'budget-row-main';
    const name = document.createElement('h3');
    name.className = 'budget-row-name budget-rule-match';
    name.textContent = `“${rule.matchValue}”`;
    const meta = document.createElement('p');
    meta.className = 'budget-row-meta';
    const typeLabel = rule.matchType === 'merchantEquals' ? 'merchant is exactly' : 'merchant or description contains';
    const bits = [typeLabel, `→ ${cat ? cat.name : '(missing category)'}`];
    if ((rule.priority || 0) !== 50) bits.push(`priority ${rule.priority || 0}`);
    if (!rule.enabled) bits.push('off');
    meta.textContent = bits.join(' · ');
    main.appendChild(name);
    main.appendChild(meta);

    const amountWrap = document.createElement('div');
    amountWrap.className = 'budget-row-amount-wrap';
    const amount = document.createElement('div');
    amount.className = 'budget-row-amount';
    amount.textContent = String(matchCount);
    const state = document.createElement('span');
    state.className = 'budget-row-amount-state';
    state.textContent = matchCount === 1 ? 'txn matched' : 'txns matched';
    amountWrap.appendChild(amount);
    amountWrap.appendChild(state);

    const actions = document.createElement('div');
    actions.className = 'budget-row-actions';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'budget-action-btn';
    toggleBtn.textContent = rule.enabled ? 'Turn off' : 'Turn on';
    toggleBtn.addEventListener('click', () => {
      global.Pike.state.commit((d) => {
        const r = (d.budget.rules || []).find((x) => x.id === rule.id);
        if (r) r.enabled = !r.enabled;
      });
    });
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'budget-action-btn';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => openRuleModal(rule));
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'budget-action-btn';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => {
      if (!confirm(`Delete the "${rule.matchValue}" rule? Transactions it already categorized keep their categories.`)) return;
      global.Pike.state.commit((d) => {
        d.budget.rules = (d.budget.rules || []).filter((x) => x.id !== rule.id);
      });
    });
    actions.appendChild(toggleBtn);
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);

    row.appendChild(main);
    row.appendChild(amountWrap);
    row.appendChild(actions);
    return row;
  }

  function openRuleModal(existing) {
    const isEdit = !!existing;
    const rule = existing || {};
    const allCategories = (getBudget().categories || []).filter((c) => !c.archived)
      .sort((x, y) => x.name.localeCompare(y.name));

    const form = document.createElement('form');
    form.className = 'budget-form';
    form.autocomplete = 'off';
    form.innerHTML = `
      <label class="budget-field">
        <span>Match text</span>
        <input type="text" class="input" name="matchValue" required maxlength="80"
               value="${esc(rule.matchValue || '')}" placeholder="e.g. doordash">
        <span style="font-size:var(--fs-xs);color:var(--text-faint);font-weight:400;">Case-insensitive. Checked against both the merchant and the bank description.</span>
      </label>
      <label class="budget-field">
        <span>Match type</span>
        <select class="input" name="matchType">
          <option value="merchantContains" ${rule.matchType !== 'merchantEquals' ? 'selected' : ''}>Merchant or description contains</option>
          <option value="merchantEquals" ${rule.matchType === 'merchantEquals' ? 'selected' : ''}>Merchant is exactly</option>
        </select>
      </label>
      <label class="budget-field">
        <span>Category</span>
        <select class="input" name="categoryId" required>
          ${allCategories.map((c) =>
            `<option value="${esc(c.id)}" ${rule.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
          ).join('')}
        </select>
      </label>
      <label class="budget-field">
        <span>Priority</span>
        <input type="number" class="input" name="priority" value="${esc(String(rule.priority != null ? rule.priority : 50))}" min="0" max="1000" step="10">
        <span style="font-size:var(--fs-xs);color:var(--text-faint);font-weight:400;">Higher wins when several rules match. Use above 50 for specific rules ("apple card") that must beat generic ones ("apple").</span>
      </label>
      <label class="budget-field" style="flex-direction:row;align-items:center;gap:var(--space-2);">
        <input type="checkbox" name="enabled" ${rule.enabled !== false ? 'checked' : ''} style="width:16px;height:16px;">
        <span style="font-size:var(--fs-sm);font-weight:400;text-transform:none;letter-spacing:0;">Enabled</span>
      </label>
      ${!isEdit ? `
      <label class="budget-field" style="flex-direction:row;align-items:center;gap:var(--space-2);">
        <input type="checkbox" name="applyNow" checked style="width:16px;height:16px;">
        <span style="font-size:var(--fs-sm);font-weight:400;text-transform:none;letter-spacing:0;">Also categorize existing uncategorized transactions that match</span>
      </label>` : ''}
      <div class="pike-modal-actions">
        <button type="button" class="btn" data-modal-close="1">Cancel</button>
        <button type="submit" class="btn btn-primary">${isEdit ? 'Save' : 'Add rule'}</button>
      </div>
    `;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const matchValue = String(fd.get('matchValue') || '').trim().toLowerCase();
      if (!matchValue) return;
      const matchType = String(fd.get('matchType') || 'merchantContains');
      const categoryId = String(fd.get('categoryId') || '');
      if (!categoryId) return;
      const priority = Math.max(0, Math.round(Number(fd.get('priority')) || 50));
      const enabled = !!fd.get('enabled');
      const applyNow = !isEdit && !!fd.get('applyNow');

      const dup = (getBudget().rules || []).find((r) =>
        r.matchType === matchType && r.matchValue === matchValue && r.id !== rule.id
      );
      if (dup) {
        showFormError(form, `A rule for "${matchValue}" already exists — edit that one instead.`);
        return;
      }

      const now = new Date().toISOString();
      global.Pike.state.commit((d) => {
        if (!d.budget.rules) d.budget.rules = [];
        let saved;
        if (isEdit) {
          saved = d.budget.rules.find((x) => x.id === existing.id);
          if (saved) {
            saved.matchValue = matchValue; saved.matchType = matchType;
            saved.categoryId = categoryId; saved.priority = priority;
            saved.enabled = enabled;
          }
        } else {
          saved = { id: uid('rul'), matchType, matchValue, categoryId, priority, enabled };
          d.budget.rules.push(saved);
        }
        if (applyNow && saved && enabled) {
          (d.budget.transactions || []).forEach((t) => {
            if (t.plaidRemoved || t.transferPairId || t.categoryId) return;
            if (t.kind !== 'spending' && t.kind !== 'income') return;
            const m = (t.merchant || '').toLowerCase();
            const dsc = (t.description || '').toLowerCase();
            const hit = matchType === 'merchantEquals'
              ? m.trim() === matchValue
              : (m.includes(matchValue) || dsc.includes(matchValue));
            if (hit) { t.categoryId = categoryId; t.ruleAppliedId = saved.id; t.updatedAt = now; }
          });
        }
      });
      global.Pike.modal.close();
    });

    global.Pike.modal.open({
      title: isEdit ? 'Edit rule' : 'Add rule',
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

    // Categories filter by kind. Income earns into income categories, but
    // refunds/reimbursements net against SPENDING categories — a Venmo
    // repayment for a group dinner belongs in Eating out, subtracting there.
    function categoriesForKind(kind) {
      if (kind === 'income') {
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
            <option value="" ${!(isEdit ? tx.categoryId : presets.categoryId) ? 'selected' : ''}>(no category)</option>
            ${initialCategories.map((c) =>
              `<option value="${esc(c.id)}" ${(isEdit ? tx.categoryId : presets.categoryId) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`
            ).join('')}
          </select>
        </label>
      </div>
      <label class="budget-field" id="budget-tx-rule-field" style="flex-direction:row;align-items:center;gap:var(--space-2);">
        <input type="checkbox" name="makeRule" style="width:16px;height:16px;">
        <span style="font-size:var(--fs-sm);font-weight:400;text-transform:none;letter-spacing:0;">Remember this merchant — auto-categorize future imports with this category</span>
      </label>
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
      // Always offer "(no category)" — without it the browser silently picks
      // the first category, which stamped Groceries on uncategorized saves.
      sel.innerHTML = `<option value="" ${!selectedId ? 'selected' : ''}>(no category)</option>` + opts.map((c) =>
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
      // Belt and suspenders: the hidden attribute alone lost to the CSS
      // display rule, leaving the editor visible while submit ignored it.
      splitsBox.style.display = on ? '' : 'none';
      categoryField.style.display = on ? 'none' : '';
      splitToggleBtn.textContent = on ? 'Use a single category' : 'Split this transaction';
      if (!on) {
        // Clear rows on toggle-off so hidden values can't linger and surprise.
        splitListEl.innerHTML = '';
      }
      if (on && !splitListEl.children.length) {
        // Seed with one row.
        addSplitRow({ categoryId: currentCategoriesForUI()[0]?.id, amountCents: 0 });
      }
      recalcSplits();
    }
    // Apply the initial state explicitly — the box must start truly hidden.
    splitsBox.style.display = splitsOn ? '' : 'none';

    splitToggleBtn.addEventListener('click', () => setSplitsMode(!splitsOn));
    splitAddBtn.addEventListener('click', () => {
      addSplitRow({ categoryId: currentCategoriesForUI()[0]?.id, amountCents: 0 });
      recalcSplits();
    });
    amountInput.addEventListener('input', recalcSplits);

    kindSelect.addEventListener('change', () => {
      // Update category dropdown to match kind's allowable categories.
      refreshCategoryDropdown(null);
      // Rebuild split selects for the new kind, preserving each row's choice
      // when the category still applies (a silent reset stamped everything
      // back to the first option).
      splitListEl.querySelectorAll('.budget-allocation-row').forEach((r) => {
        const sel = r.querySelector('select[name="splitCategory"]');
        const prev = sel.value;
        const opts = currentCategoriesForUI();
        sel.innerHTML = opts.map((c) =>
          `<option value="${esc(c.id)}" ${c.id === prev ? 'selected' : ''}>${esc(c.name)}</option>`
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

        // "Remember this merchant" — same rule shape as the bulk
        // Apply-category flow, so future imports self-categorize.
        if (fd.get('makeRule') && !splitsOn && categoryId && merchant) {
          if (!d.budget.rules) d.budget.rules = [];
          const matchValue = merchant.toLowerCase().trim();
          const exists = d.budget.rules.some((r) =>
            r.matchType === 'merchantContains' && r.matchValue === matchValue
          );
          if (!exists) {
            d.budget.rules.push({
              id: uid('rul'), matchType: 'merchantContains', matchValue,
              categoryId, priority: 50, enabled: true,
            });
          }
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

  function openTransferModal(existingLeg, prefill) {
    const isEdit = !!existingLeg;
    const pre = prefill || {};
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
    const initialFrom = isEdit ? outflowLeg.accountId : (pre.fromAccountId || '');
    const initialTo   = isEdit ? (inflowLeg ? inflowLeg.accountId : '') : (pre.toAccountId || '');
    const initialAmt  = isEdit ? outflowLeg.amountCents : (pre.amountCents || 0);
    const initialDesc = isEdit ? (outflowLeg.description || '') : (pre.description || '');
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

    // Installment plans whose end date has passed drop to a quiet section at
    // the bottom — they fell off upcoming lists automatically; archiving them
    // is optional housekeeping.
    const today = todayKey();
    const active = bills.filter((b) => !b.endDate || b.endDate >= today);
    const ended  = bills.filter((b) => b.endDate && b.endDate < today);

    const summary = buildRecurringSummary(active);
    if (summary) wrap.appendChild(summary);

    active
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((bill) => wrap.appendChild(buildRecurringRow(bill)));

    if (ended.length) {
      const head = document.createElement('p');
      head.className = 'budget-eyebrow';
      head.style.marginTop = 'var(--space-5)';
      head.textContent = 'Completed plans';
      wrap.appendChild(head);
      ended
        .slice()
        .sort((a, b) => (b.endDate || '').localeCompare(a.endDate || ''))
        .forEach((bill) => wrap.appendChild(buildRecurringRow(bill)));
    }
    return wrap;
  }

  // Normalize a bill's amount to a monthly figure for the summary table.
  function monthlyCentsForBill(bill) {
    const amt = bill.amountCents || 0;
    if (bill.cadence === 'weekly')    return Math.round(amt * 52 / 12);
    if (bill.cadence === 'biweekly')  return Math.round(amt * 26 / 12);
    if (bill.cadence === 'quarterly') return Math.round(amt / 3);
    if (bill.cadence === 'annual')    return Math.round(amt / 12);
    return amt;  // monthly
  }

  // Monthly recurring load, bucketed: installment plans (bills with an end
  // date — BNPL) as their own line, everything else by category. All amounts
  // normalized to per-month so weekly and annual bills compare honestly.
  function buildRecurringSummary(activeBills) {
    if (!activeBills.length) return null;
    const cats = getBudget().categories || [];
    const buckets = {};
    activeBills.forEach((bill) => {
      const key = bill.endDate
        ? 'Installments (BNPL)'
        : ((cats.find((c) => c.id === bill.categoryId) || {}).name || 'Uncategorized');
      if (!buckets[key]) buckets[key] = { count: 0, monthlyCents: 0 };
      buckets[key].count += 1;
      buckets[key].monthlyCents += monthlyCentsForBill(bill);
    });
    const rows = Object.entries(buckets).sort((a, b2) => b2[1].monthlyCents - a[1].monthlyCents);
    const totalCents = rows.reduce((s, [, v]) => s + v.monthlyCents, 0);

    const card = document.createElement('section');
    card.className = 'budget-top-cats';

    const head = document.createElement('div');
    head.className = 'budget-top-cats-head';
    const title = document.createElement('h3');
    title.className = 'budget-top-cats-title';
    title.textContent = 'Monthly recurring load';
    head.appendChild(title);
    const total = document.createElement('span');
    total.className = 'budget-top-cats-spent';
    total.textContent = `${formatCents(totalCents)}/mo`;
    head.appendChild(total);
    card.appendChild(head);

    const list = document.createElement('div');
    list.className = 'budget-top-cats-list';
    rows.forEach(([name, v]) => {
      const row = document.createElement('div');
      row.className = 'budget-top-cats-row';
      const nameEl = document.createElement('span');
      nameEl.className = 'budget-top-cats-name';
      nameEl.textContent = name;
      const right = document.createElement('div');
      right.className = 'budget-top-cats-right';
      const amt = document.createElement('span');
      amt.className = 'budget-top-cats-spent';
      amt.textContent = `${formatCents(v.monthlyCents)}/mo`;
      const sub = document.createElement('span');
      sub.className = 'budget-top-cats-sub';
      sub.textContent = `${v.count} bill${v.count === 1 ? '' : 's'}`;
      right.appendChild(amt);
      right.appendChild(sub);
      row.appendChild(nameEl);
      row.appendChild(right);
      list.appendChild(row);
    });
    card.appendChild(list);
    return card;
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
    const isEnded = bill.endDate && bill.endDate < todayKey();
    const next = isEnded ? null : upcomingOccurrences(bill, 365)[0];
    const route = counter ? `${fromAcct?.name || '—'} → ${counter.name}` : (fromAcct?.name || '—');
    // Show the year on end dates outside the current year — "ends Jun 29"
    // would read as earlier than "next Jul 29" when it's really next year.
    const fmtEnd = (iso) => iso.slice(0, 4) === todayKey().slice(0, 4) ? fmtDateShort(iso) : fmtDate(iso);
    const bits = [cadenceLabel];
    if (isEnded) {
      bits.push(`ended ${fmtEnd(bill.endDate)}`);
    } else {
      bits.push(next ? `next ${fmtDateShort(next)}` : 'no upcoming dates');
      if (bill.endDate) {
        const left = remainingOccurrenceCount(bill);
        bits.push(`ends ${fmtEnd(bill.endDate)}${left != null ? ` · ${left} left` : ''}`);
      }
    }
    bits.push(route);
    meta.textContent = bits.join(' · ');
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
    sub.textContent = isEnded ? 'Completed' : (bill.variable ? 'Varies' : 'Expected');
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
        <span>End date (optional — for installment plans)</span>
        <input type="date" class="input" name="endDate" value="${esc(bill.endDate || '')}">
        <span style="font-size:var(--fs-xs);color:var(--text-faint);font-weight:400;">The last payment date. After it passes, the bill falls off upcoming lists automatically — made for BNPL plans like Affirm and Klarna.</span>
      </label>
      <label class="budget-field">
        <span>Payment match (optional)</span>
        <input type="text" class="input" name="matchValue" value="${esc(bill.matchValue || '')}" placeholder="e.g. netflix">
        <span style="font-size:var(--fs-xs);color:var(--text-faint);font-weight:400;">Merchant text that identifies this bill's payments in imported transactions — lets upcoming bills check themselves off when the payment lands.</span>
      </label>
      <label class="budget-field" style="flex-direction:row;align-items:center;gap:var(--space-2);">
        <input type="checkbox" name="variable" ${bill.variable ? 'checked' : ''} style="width:16px;height:16px;">
        <span style="font-size:var(--fs-sm);font-weight:400;text-transform:none;letter-spacing:0;">Amount varies (utilities, card minimums) — match payments by merchant and date only</span>
      </label>
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
      const endDate = String(fd.get('endDate') || '').trim() || null;
      const matchValue = String(fd.get('matchValue') || '').trim().toLowerCase() || null;
      const variable = !!fd.get('variable');
      const notes = String(fd.get('notes') || '').trim();

      global.Pike.state.commit((d) => {
        if (!d.budget.recurringBills) d.budget.recurringBills = [];
        if (isEdit) {
          const b = d.budget.recurringBills.find((x) => x.id === existing.id);
          if (b) {
            b.name = name; b.amountCents = amountCents;
            b.accountId = accountId; b.counterAccountId = counterAccountId;
            b.categoryId = categoryId; b.cadence = cadence;
            b.anchorDate = anchorDate; b.endDate = endDate;
            b.matchValue = matchValue; b.variable = variable; b.notes = notes;
          }
        } else {
          d.budget.recurringBills.push({
            id: uid('rec'), name, amountCents,
            categoryId, accountId, counterAccountId,
            cadence, anchorDate, endDate, matchValue, variable,
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

    // Seed guard + dedupe. A sync race once planted the seed list three times
    // (multiple devices each seeded before the categoriesSeeded flag round-
    // tripped). Two defenses: never seed when ANY categories exist, and
    // collapse duplicate names back to the first copy, remapping every
    // reference. Both idempotent — safe to run on every init.
    const cats = data.budget.categories || [];
    const dupIds = {};
    const seenByName = {};
    cats.forEach((c) => {
      const key = (c.name || '').toLowerCase();
      if (seenByName[key]) dupIds[c.id] = seenByName[key];
      else seenByName[key] = c.id;
    });

    if (Object.keys(dupIds).length) {
      global.Pike.state.commit((d) => {
        const fix = (id) => dupIds[id] || id;
        (d.budget.transactions || []).forEach((t) => {
          if (t.categoryId) t.categoryId = fix(t.categoryId);
          (t.splits || []).forEach((s) => { if (s.categoryId) s.categoryId = fix(s.categoryId); });
        });
        (d.budget.payPeriods || []).forEach((p) => {
          (p.allocations || []).forEach((a) => { if (a.categoryId) a.categoryId = fix(a.categoryId); });
        });
        (d.budget.rules || []).forEach((r) => { if (r.categoryId) r.categoryId = fix(r.categoryId); });
        (d.budget.recurringBills || []).forEach((rb) => { if (rb.categoryId) rb.categoryId = fix(rb.categoryId); });
        d.budget.categories = d.budget.categories.filter((c) => !dupIds[c.id]);
        d.budget.categoriesSeeded = true;
      });
    } else if (!data.budget.categoriesSeeded) {
      global.Pike.state.commit((d) => {
        if (!d.budget.categories) d.budget.categories = [];
        if (!d.budget.categories.length) {
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
        }
        // Categories already present (flag was lost in a merge) — just set the
        // flag; never seed over existing data.
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
  global.Pike.budget = { init, render, ensurePayPeriods };

})(window);
