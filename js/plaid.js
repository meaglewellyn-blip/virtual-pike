/* Virtual Pike — Plaid Integration (Phase 5B: Account mapping + transaction import)
 *
 * All sensitive operations go through the plaid-proxy Edge Function.
 * No secrets, access tokens, or item IDs ever touch the frontend.
 *
 * Public:
 *   Pike.plaid.init()       — async; checks connection status, renders
 *   Pike.plaid.render()     — sync; paints current state into #plaid-accounts-section
 *   Pike.plaid.connect()    — opens Plaid Link
 *   Pike.plaid.disconnect() — revokes an institution
 */

(function (global) {
  'use strict';

  const Pike = global.Pike || (global.Pike = {});

  const EDGE_URL = 'https://oenxkfheadicpixkywtz.supabase.co/functions/v1/plaid-proxy';
  const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9lbnhrZmhlYWRpY3BpeGt5d3R6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc3MDYzMzEsImV4cCI6MjA5MzI4MjMzMX0.bfVyJ0ysEoKn8Dr0suDAN1ftrJ6uq4JncIoK8FdFBtM';

  // ── Module state ──────────────────────────────────────────────────────────────

  let sdkLoaded       = false;
  let statusLoaded    = false;
  let connectedItems  = [];   // [{ id, institution_name, institution_id, created_at }]
  let previewAccounts = [];   // [{ item_id, institution, accounts }]
  let previewTxns     = [];   // [{ item_id, institution, added }]
  let connecting      = false;
  let importingItemId = null; // item currently being fetched for import

  // ── General helpers ───────────────────────────────────────────────────────────

  function getBudget() {
    return (Pike.state && Pike.state.data && Pike.state.data.budget) || {};
  }

  function uid(prefix) { return (prefix || '') + Math.random().toString(36).slice(2, 10); }

  function pad2(n) { return String(n).padStart(2, '0'); }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function fmtUSD(cents) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  }

  // ── Account mapping helpers ───────────────────────────────────────────────────

  function getMappedPikeAccounts(itemId) {
    return (getBudget().accounts || []).filter((a) => a.plaidItemId === itemId && !a.archived);
  }

  function getPikeAccountForPlaid(plaidAccountId) {
    return (getBudget().accounts || []).find((a) => a.plaidAccountId === plaidAccountId && !a.archived);
  }

  function getUnmappedPikeAccounts() {
    return (getBudget().accounts || []).filter((a) => !a.plaidAccountId && !a.archived);
  }

  function getExistingPlaidIds() {
    return new Set(
      (getBudget().transactions || [])
        .filter((t) => t.plaidTransactionId)
        .map((t) => t.plaidTransactionId)
    );
  }

  // ── Schema mappers ────────────────────────────────────────────────────────────

  function mapAccountType(plaidType, plaidSubtype) {
    if (plaidType === 'credit') return 'credit-card';
    if (plaidType === 'loan')   return 'loan';
    if (plaidSubtype === 'savings') return 'savings';
    return 'checking';
  }

  function mapTransaction(t) {
    return {
      date:        t.date,
      merchant:    t.merchant_name || t.name || '—',
      amountCents: Math.round(Math.abs(t.amount) * 100),
      direction:   t.amount > 0 ? 'outflow' : 'inflow',
    };
  }

  // ── Edge Function helper ──────────────────────────────────────────────────────

  async function callEdge(params, body) {
    const url = new URL(EDGE_URL);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const opts = {
      headers: {
        'Authorization': `Bearer ${ANON_KEY}`,
        'Content-Type':  'application/json',
      },
    };
    if (body) { opts.method = 'POST'; opts.body = JSON.stringify(body); }
    const res = await fetch(url.toString(), opts);
    return res.json();
  }

  // ── Plaid Link SDK loader ─────────────────────────────────────────────────────

  function loadSdk() {
    return new Promise((resolve, reject) => {
      if (sdkLoaded || global.Plaid) { sdkLoaded = true; resolve(); return; }
      const script = document.createElement('script');
      script.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      script.onload  = () => { sdkLoaded = true; resolve(); };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // ── Status & preview fetchers ─────────────────────────────────────────────────

  async function refreshStatus() {
    try {
      const { items, error } = await callEdge({ action: 'status' });
      if (error) { console.warn('Pike: plaid status error', error); return; }
      connectedItems = items || [];
      statusLoaded   = true;
    } catch (e) {
      console.warn('Pike: plaid status failed', e);
    }
  }

  async function fetchPreview() {
    try {
      const [acctRes, txnRes] = await Promise.all([
        callEdge({ action: 'accounts' }),
        callEdge({ action: 'transactions' }),
      ]);
      previewAccounts = (acctRes.results || []).filter((r) => !r.error);
      previewTxns     = (txnRes.results  || []).filter((r) => !r.error);
    } catch (e) {
      console.warn('Pike: plaid preview fetch failed', e);
    }
  }

  // ── Connect: open Plaid Link ──────────────────────────────────────────────────

  async function connect() {
    if (connecting) return;
    connecting = true;
    render();
    try {
      await loadSdk();
      const { link_token, error } = await callEdge({ action: 'link-token' });
      if (error || !link_token) {
        console.warn('Pike: plaid link-token error', error);
        connecting = false; render(); return;
      }
      const handler = global.Plaid.create({
        token: link_token,
        onSuccess: async (public_token, metadata) => {
          handler.destroy();
          connecting = false;
          const institution = metadata.institution || {};
          await callEdge({ action: 'exchange' }, {
            public_token,
            institution_id:   institution.institution_id || null,
            institution_name: institution.name           || null,
          });
          await refreshStatus();
          await fetchPreview();
          render();
        },
        onExit: (err) => {
          handler.destroy();
          connecting = false;
          if (err) console.warn('Pike: plaid link exit error', err);
          render();
        },
      });
      handler.open();
    } catch (e) {
      console.warn('Pike: plaid connect failed', e);
      connecting = false; render();
    }
  }

  // ── Manage accounts: open Plaid Link in update mode ──────────────────────────
  // Uses a link-token-update token scoped to the existing item's access_token
  // (looked up server-side). Never exposes the access_token to the frontend.

  async function openManageAccounts(item) {
    if (connecting) return;
    connecting = true;
    render();
    try {
      await loadSdk();
      const { link_token, error } = await callEdge(
        { action: 'link-token-update' },
        { item_id: item.id }
      );
      if (error || !link_token) {
        console.warn('Pike: plaid link-token-update error', error);
        connecting = false; render(); return;
      }
      const handler = global.Plaid.create({
        token: link_token,
        onSuccess: async () => {
          handler.destroy();
          connecting = false;
          await refreshStatus();
          await fetchPreview();
          render();
        },
        onExit: (err) => {
          handler.destroy();
          connecting = false;
          if (err) console.warn('Pike: plaid manage exit error', err);
          render();
        },
      });
      handler.open();
    } catch (e) {
      console.warn('Pike: plaid manage accounts failed', e);
      connecting = false; render();
    }
  }

  // ── Disconnect an institution ─────────────────────────────────────────────────

  async function disconnect(itemId) {
    try {
      await callEdge({ action: 'disconnect' }, { item_id: itemId });
      connectedItems  = connectedItems.filter((i) => i.id !== itemId);
      previewAccounts = previewAccounts.filter((p) => p.item_id !== itemId);
      previewTxns     = previewTxns.filter((p) => p.item_id !== itemId);
      render();
    } catch (e) {
      console.warn('Pike: plaid disconnect failed', e);
    }
  }

  // ── Account mapping modal ─────────────────────────────────────────────────────

  function openMappingModal(item, plaidAccounts) {
    const body = document.createElement('div');
    body.className = 'plaid-mapping-form';

    const intro = document.createElement('p');
    intro.className = 'plaid-mapping-intro';
    intro.textContent = `Link each ${item.institution_name || 'bank'} account to a Pike account, or create a new one. Skipped accounts won't be imported.`;
    body.appendChild(intro);

    const rows = [];

    plaidAccounts.forEach((plaidAcct) => {
      const currentPike = getPikeAccountForPlaid(plaidAcct.account_id);
      const unmapped    = getUnmappedPikeAccounts();

      const row = document.createElement('div');
      row.className = 'plaid-mapping-row';

      const info = document.createElement('div');
      info.className = 'plaid-mapping-row-info';

      const nameEl = document.createElement('span');
      nameEl.className = 'plaid-mapping-acct-name';
      nameEl.textContent = plaidAcct.name + (plaidAcct.mask ? ' ···' + plaidAcct.mask : '');

      const typeEl = document.createElement('span');
      typeEl.className = 'plaid-mapping-acct-type';
      typeEl.textContent = mapAccountType(plaidAcct.type, plaidAcct.subtype);

      info.appendChild(nameEl);
      info.appendChild(typeEl);

      const select = document.createElement('select');
      select.className = 'plaid-mapping-select form-input';
      select.dataset.plaidAccountId = plaidAcct.account_id;
      select.dataset.plaidName      = plaidAcct.name;
      select.dataset.plaidType      = mapAccountType(plaidAcct.type, plaidAcct.subtype);
      const bal = Math.round((plaidAcct.balances?.current ?? 0) * 100);
      select.dataset.plaidBalance = String(bal);

      const skipOpt   = document.createElement('option');
      skipOpt.value   = '__skip__';
      skipOpt.textContent = currentPike ? '— Unlink —' : '— Skip for now —';
      select.appendChild(skipOpt);

      const createOpt   = document.createElement('option');
      createOpt.value   = '__create__';
      createOpt.textContent = '+ Create new Pike account';
      select.appendChild(createOpt);

      unmapped.forEach((pa) => {
        const opt = document.createElement('option');
        opt.value = pa.id;
        opt.textContent = pa.name;
        select.appendChild(opt);
      });

      // If already mapped, add current account as selectable option
      if (currentPike && !unmapped.find((a) => a.id === currentPike.id)) {
        const opt = document.createElement('option');
        opt.value = currentPike.id;
        opt.textContent = currentPike.name;
        select.appendChild(opt);
      }

      if (currentPike) select.value = currentPike.id;

      row.appendChild(info);
      row.appendChild(select);
      body.appendChild(row);
      rows.push({ plaidAcct, select });
    });

    const saveBtn = document.createElement('button');
    saveBtn.type      = 'button';
    saveBtn.className = 'btn btn-primary';
    saveBtn.style.marginTop = 'var(--space-4)';
    saveBtn.textContent = 'Save mappings';
    saveBtn.addEventListener('click', () => { saveMappings(item, rows); Pike.modal.close(); });
    body.appendChild(saveBtn);

    Pike.modal.open({ title: 'Map bank accounts', body });
  }

  function saveMappings(item, rows) {
    const today = todayKey();

    Pike.state.commit((d) => {
      if (!d.budget) d.budget = {};
      if (!d.budget.accounts) d.budget.accounts = [];

      rows.forEach(({ select }) => {
        const selection = select.value;

        if (selection === '__skip__') {
          // Unlink if previously mapped to this Plaid account
          const idx = d.budget.accounts.findIndex((a) => a.plaidAccountId === select.dataset.plaidAccountId);
          if (idx !== -1) {
            d.budget.accounts[idx].plaidAccountId = null;
            d.budget.accounts[idx].plaidItemId    = null;
          }
          return;
        }

        if (selection === '__create__') {
          const pikeType = select.dataset.plaidType;
          const balCents = parseInt(select.dataset.plaidBalance, 10) || 0;
          // Credit/loan balances are liabilities — store as negative
          const startingBalance = (pikeType === 'credit-card' || pikeType === 'loan') ? -Math.abs(balCents) : balCents;
          d.budget.accounts.push({
            id:                   uid('acc_'),
            name:                 select.dataset.plaidName,
            type:                 pikeType,
            institution:          item.institution_name || '',
            startingBalanceCents: startingBalance,
            startingBalanceDate:  today,
            archived:             false,
            plaidItemId:          item.id,
            plaidAccountId:       select.dataset.plaidAccountId,
            lastSyncedAt:         new Date().toISOString(),
          });
          return;
        }

        // Link to existing Pike account
        const idx = d.budget.accounts.findIndex((a) => a.id === selection);
        if (idx !== -1) {
          d.budget.accounts[idx].plaidItemId    = item.id;
          d.budget.accounts[idx].plaidAccountId = select.dataset.plaidAccountId;
          d.budget.accounts[idx].lastSyncedAt   = new Date().toISOString();
        }
      });
    });

    render();
  }

  // ── Delta sync ────────────────────────────────────────────────────────────────

  async function openSyncModal(item) {
    if (importingItemId) return;
    importingItemId = item.id;
    render();

    const loadingEl       = document.createElement('p');
    loadingEl.className   = 'plaid-status-line';
    loadingEl.textContent = `Syncing ${item.institution_name || 'this bank'}…`;

    Pike.modal.open({
      title: 'Sync transactions',
      body:  loadingEl,
      onClose: () => { importingItemId = null; render(); },
    });

    try {
      const res = await callEdge({ action: 'sync' }, { item_id: item.id });

      if (res.error) {
        replaceModalBody(buildErrorEl('Sync failed: ' + res.error));
        importingItemId = null;
        return;
      }

      const added    = res.added    || [];
      const modified = res.modified || [];
      const removed  = res.removed  || [];
      const nextCursor = res.next_cursor || null;

      const mappedAccounts = getMappedPikeAccounts(item.id);
      const accountMap     = {};
      mappedAccounts.forEach((a) => { if (a.plaidAccountId) accountMap[a.plaidAccountId] = a.id; });

      const existingIds = getExistingPlaidIds();

      // ── Classify added ──────────────────────────────────────────────────────
      const settledAdded    = added.filter((t) => !t.pending);
      const pendingCount    = added.filter((t) => t.pending).length;
      const newTxns         = settledAdded.filter((t) => !existingIds.has(t.transaction_id) && accountMap[t.account_id]);
      const alreadyInPike   = settledAdded.filter((t) =>  existingIds.has(t.transaction_id)).length;
      const unmappedCount   = settledAdded.filter((t) => !existingIds.has(t.transaction_id) && !accountMap[t.account_id]).length;

      // ── Classify modified ───────────────────────────────────────────────────
      // Settled modified already in Pike → update in place
      const toUpdate = modified.filter((t) => !t.pending && existingIds.has(t.transaction_id));
      // Settled modified NOT in Pike → was pending before first sync, now settled → add
      const newFromModified = modified.filter((t) => !t.pending && !existingIds.has(t.transaction_id) && accountMap[t.account_id]);

      // ── Classify removed ────────────────────────────────────────────────────
      const toRemoveIds = (removed || []).map((t) => t.transaction_id).filter((id) => existingIds.has(id));

      const allToAdd = [...newTxns, ...newFromModified];

      const previewEl = buildSyncPreview({
        allToAdd, toUpdate, toRemoveIds, pendingCount, alreadyInPike, unmappedCount, accountMap, mappedAccounts,
      });
      replaceModalBody(previewEl);

      previewEl.querySelector('.plaid-import-confirm-btn')?.addEventListener('click', () => {
        commitSync(allToAdd, toUpdate, toRemoveIds, accountMap, item.id, nextCursor);
        Pike.modal.close();
        importingItemId = null;
        render();
      });

      previewEl.querySelector('.plaid-import-cancel-btn')?.addEventListener('click', () => {
        Pike.modal.close();
        importingItemId = null;
        render();
      });

    } catch (e) {
      console.warn('Pike: sync failed', e);
      replaceModalBody(buildErrorEl('Failed to sync. Please try again.'));
      importingItemId = null;
    }
  }

  function replaceModalBody(el) {
    const bodyEl = document.getElementById('pike-modal-body');
    if (!bodyEl) return;
    bodyEl.innerHTML = '';
    bodyEl.appendChild(el);
  }

  function buildSyncPreview({ allToAdd, toUpdate, toRemoveIds, pendingCount, alreadyInPike, unmappedCount, accountMap, mappedAccounts }) {
    const wrap = document.createElement('div');
    wrap.className = 'plaid-import-preview';

    const stats = document.createElement('div');
    stats.className = 'plaid-import-stats';
    [
      { num: allToAdd.length,    label: 'new to import',          muted: false },
      { num: toUpdate.length,    label: 'to update',              muted: false },
      { num: toRemoveIds.length, label: 'to remove',              muted: false },
      ...(pendingCount  > 0 ? [{ num: pendingCount,  label: 'pending — skipped',    muted: true }] : []),
      ...(alreadyInPike > 0 ? [{ num: alreadyInPike, label: 'already imported',     muted: true }] : []),
      ...(unmappedCount > 0 ? [{ num: unmappedCount, label: 'account not mapped',   muted: true }] : []),
    ].forEach(({ num, label, muted }) => {
      const stat = document.createElement('div');
      stat.className = 'plaid-import-stat';
      const numEl = document.createElement('span');
      numEl.className = 'plaid-import-stat-num' + (muted ? ' is-muted' : '');
      numEl.textContent = String(num);
      const lblEl = document.createElement('span');
      lblEl.className = 'plaid-import-stat-label';
      lblEl.textContent = label;
      stat.appendChild(numEl);
      stat.appendChild(lblEl);
      stats.appendChild(stat);
    });
    wrap.appendChild(stats);

    // "to remove" note
    if (toRemoveIds.length > 0) {
      const note = document.createElement('p');
      note.className   = 'plaid-import-meta';
      note.textContent = `${toRemoveIds.length} transaction${toRemoveIds.length === 1 ? '' : 's'} removed by your bank will be marked removed and excluded from balances. Your category and notes on those transactions are preserved.`;
      wrap.appendChild(note);
    }

    if (allToAdd.length > 0) {
      const dates = allToAdd.map((t) => t.date).sort();
      const meta = document.createElement('p');
      meta.className   = 'plaid-import-meta';
      meta.textContent = `New: ${dates[0]} → ${dates[dates.length - 1]}`;
      wrap.appendChild(meta);

      const pikeIds   = [...new Set(allToAdd.map((t) => accountMap[t.account_id]).filter(Boolean))];
      const acctNames = pikeIds.map((id) => (mappedAccounts.find((a) => a.id === id) || {}).name || id);
      const meta2 = document.createElement('p');
      meta2.className   = 'plaid-import-meta';
      meta2.textContent = `Accounts: ${acctNames.join(', ')}`;
      wrap.appendChild(meta2);

      const previewHead = document.createElement('p');
      previewHead.className = 'plaid-txn-head';
      previewHead.style.marginTop = 'var(--space-3)';
      previewHead.textContent = allToAdd.length > 5 ? `Preview — first 5 of ${allToAdd.length}` : 'New transactions';
      wrap.appendChild(previewHead);

      const list = document.createElement('div');
      list.className = 'plaid-txn-list';
      allToAdd.slice(0, 5).forEach((t) => {
        const m   = mapTransaction(t);
        const row = document.createElement('div');
        row.className = 'plaid-txn-row';
        const left = document.createElement('div');
        left.className = 'plaid-txn-left';
        const merch = document.createElement('span');
        merch.className   = 'plaid-txn-merchant';
        merch.textContent = m.merchant;
        const dt = document.createElement('span');
        dt.className   = 'plaid-txn-date';
        dt.textContent = m.date;
        left.appendChild(merch);
        left.appendChild(dt);
        const amt = document.createElement('span');
        amt.className   = 'plaid-txn-amount' + (m.direction === 'inflow' ? ' is-income' : '');
        amt.textContent = (m.direction === 'outflow' ? '−' : '+') + fmtUSD(m.amountCents);
        row.appendChild(left);
        row.appendChild(amt);
        list.appendChild(row);
      });
      wrap.appendChild(list);
      if (allToAdd.length > 5) {
        const more = document.createElement('p');
        more.className   = 'plaid-txn-more';
        more.textContent = `…and ${allToAdd.length - 5} more`;
        wrap.appendChild(more);
      }
    }

    const btnRow = document.createElement('div');
    btnRow.className = 'plaid-import-btn-row';

    const hasWork = allToAdd.length > 0 || toUpdate.length > 0 || toRemoveIds.length > 0;
    if (hasWork) {
      const confirmBtn = document.createElement('button');
      confirmBtn.type      = 'button';
      confirmBtn.className = 'btn btn-primary plaid-import-confirm-btn';
      const parts = [];
      if (allToAdd.length)    parts.push(`import ${allToAdd.length}`);
      if (toUpdate.length)    parts.push(`update ${toUpdate.length}`);
      if (toRemoveIds.length) parts.push(`mark ${toRemoveIds.length} removed`);
      confirmBtn.textContent = parts.join(', ');
      confirmBtn.textContent = confirmBtn.textContent.charAt(0).toUpperCase() + confirmBtn.textContent.slice(1);
      btnRow.appendChild(confirmBtn);
    } else {
      const noneMsg = document.createElement('p');
      noneMsg.className   = 'plaid-status-line';
      noneMsg.textContent = 'Everything is up to date.';
      btnRow.appendChild(noneMsg);
    }

    const cancelBtn = document.createElement('button');
    cancelBtn.type      = 'button';
    cancelBtn.className = 'btn btn-ghost plaid-import-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    btnRow.appendChild(cancelBtn);

    wrap.appendChild(btnRow);
    return wrap;
  }

  function buildErrorEl(msg) {
    const p = document.createElement('p');
    p.className   = 'plaid-status-line';
    p.textContent = msg;
    return p;
  }

  // Returns the highest-priority enabled rule matching this merchant/description,
  // or null if none match. Never applied to already-categorized transactions.
  function matchRule(merchant, description, rules) {
    const norm = (s) => (s || '').toLowerCase().trim();
    const m = norm(merchant || description);
    if (!m) return null;
    const active = rules.filter((r) => r.enabled).sort((a, b) => (b.priority || 0) - (a.priority || 0));
    for (const r of active) {
      const v = norm(r.matchValue || '');
      if (!v) continue;
      if (r.matchType === 'merchantContains' && m.includes(v)) return r;
      if (r.matchType === 'merchantEquals'   && m === v)         return r;
    }
    return null;
  }

  function commitSync(toAdd, toUpdate, toRemoveIds, accountMap, itemId, nextCursor) {
    const now = new Date().toISOString();

    Pike.state.commit((d) => {
      if (!d.budget) d.budget = {};
      if (!d.budget.transactions) d.budget.transactions = [];

      // Build index for fast lookup by plaidTransactionId
      const byPlaidId = {};
      d.budget.transactions.forEach((t, i) => {
        if (t.plaidTransactionId) byPlaidId[t.plaidTransactionId] = i;
      });

      const rules = d.budget.rules || [];

      // ── Add new settled transactions ────────────────────────────────────────
      toAdd.forEach((t) => {
        const accountId = accountMap[t.account_id];
        if (!accountId) return;
        const amountCents = Math.round(Math.abs(t.amount) * 100);
        const direction   = t.amount > 0 ? 'outflow' : 'inflow';
        const merchant    = t.merchant_name || t.name || '';
        const description = t.name || '';
        const rule        = matchRule(merchant, description, rules);
        d.budget.transactions.push({
          id:                 uid('txn_'),
          accountId,
          date:               t.date,
          amountCents,
          direction,
          kind:               direction === 'inflow' ? 'income' : 'spending',
          categoryId:         rule ? rule.categoryId : null,
          merchant,
          description,
          transferPairId:     null,
          ruleAppliedId:      rule ? rule.id : null,
          splits:             [],
          notes:              '',
          createdAt:          now,
          updatedAt:          now,
          plaidTransactionId: t.transaction_id,
          plaidPending:       false,
        });
      });

      // ── Update modified transactions in place ───────────────────────────────
      // Only safe fields updated — categoryId, notes, splits are never touched.
      toUpdate.forEach((t) => {
        const idx = byPlaidId[t.transaction_id];
        if (idx === undefined) return;
        const amountCents = Math.round(Math.abs(t.amount) * 100);
        d.budget.transactions[idx].amountCents  = amountCents;
        d.budget.transactions[idx].direction    = t.amount > 0 ? 'outflow' : 'inflow';
        d.budget.transactions[idx].date         = t.date;
        d.budget.transactions[idx].merchant     = t.merchant_name || t.name || d.budget.transactions[idx].merchant;
        d.budget.transactions[idx].description  = t.name || d.budget.transactions[idx].description;
        d.budget.transactions[idx].plaidPending = false;
        d.budget.transactions[idx].updatedAt    = now;
      });

      // ── Mark removed transactions ───────────────────────────────────────────
      // Soft-delete only — preserves any manual category/notes the user added.
      // Budget aggregations skip plaidRemoved transactions.
      toRemoveIds.forEach((plaidTxnId) => {
        const idx = byPlaidId[plaidTxnId];
        if (idx === undefined) return;
        d.budget.transactions[idx].plaidRemoved = true;
        d.budget.transactions[idx].updatedAt    = now;
      });
    });

    // Advance the cursor only after a successful commit.
    // Fire-and-forget — if this fails, the next sync re-fetches the same delta
    // and the commit is idempotent (dedup + in-place updates handle duplicates).
    if (nextCursor && itemId) {
      callEdge({ action: 'save-cursor' }, { item_id: itemId, cursor: nextCursor })
        .catch((e) => console.warn('Pike: save-cursor failed', e));
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  function render() {
    const container = document.getElementById('plaid-accounts-section');
    if (!container) return;

    const wrap = document.createElement('div');
    wrap.className = 'plaid-section';

    // Section header
    const header = document.createElement('div');
    header.className = 'plaid-section-header';

    const eyebrow = document.createElement('p');
    eyebrow.className   = 'budget-eyebrow';
    eyebrow.textContent = 'Connected banks';
    header.appendChild(eyebrow);

    const connectBtn = document.createElement('button');
    connectBtn.type        = 'button';
    connectBtn.className   = 'btn btn-ghost btn-sm';
    connectBtn.textContent = connecting ? 'Connecting…' : '+ Add another bank';
    connectBtn.disabled    = connecting;
    connectBtn.addEventListener('click', connect);
    header.appendChild(connectBtn);
    wrap.appendChild(header);

    if (!statusLoaded) {
      const loading = document.createElement('p');
      loading.className   = 'plaid-status-line';
      loading.textContent = 'Checking connections…';
      wrap.appendChild(loading);
      container.innerHTML = '';
      container.appendChild(wrap);
      return;
    }

    if (!connectedItems.length) {
      const empty = document.createElement('p');
      empty.className   = 'plaid-status-line';
      empty.textContent = 'No banks connected.';
      wrap.appendChild(empty);
      container.innerHTML = '';
      container.appendChild(wrap);
      return;
    }

    // OAuth session note — Plaid may route "Add another bank" back to an already-
    // connected institution's OAuth flow due to browser session memory. If that
    // happens, search manually by institution name, or try a private/incognito window.
    const oauthNote = document.createElement('p');
    oauthNote.className   = 'plaid-status-line';
    oauthNote.textContent = 'Tip: if "Add another bank" opens an existing bank instead of institution search, type the new bank name in the search box, or use a private window.';
    wrap.appendChild(oauthNote);

    connectedItems.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'plaid-institution-card';

      // Card header: institution name + disconnect
      const cardHead = document.createElement('div');
      cardHead.className = 'plaid-institution-head';

      const instName = document.createElement('span');
      instName.className   = 'plaid-institution-name';
      instName.textContent = item.institution_name || 'Unknown institution';

      const discBtn = document.createElement('button');
      discBtn.type      = 'button';
      discBtn.className = 'budget-action-btn';
      discBtn.textContent = 'Disconnect';
      discBtn.addEventListener('click', () => disconnect(item.id));

      const manageBtn = document.createElement('button');
      manageBtn.type      = 'button';
      manageBtn.className = 'budget-action-btn';
      manageBtn.textContent = connecting ? '…' : 'Manage accounts';
      manageBtn.disabled    = connecting;
      manageBtn.addEventListener('click', () => openManageAccounts(item));

      cardHead.appendChild(instName);
      cardHead.appendChild(manageBtn);
      cardHead.appendChild(discBtn);
      card.appendChild(cardHead);

      // Account list with mapping status
      const acctData = previewAccounts.find((p) => p.item_id === item.id);
      if (acctData && acctData.accounts.length) {
        const acctList = document.createElement('div');
        acctList.className = 'plaid-account-list';

        acctData.accounts.forEach((acct) => {
          const pikeAcct = getPikeAccountForPlaid(acct.account_id);
          const row = document.createElement('div');
          row.className = 'plaid-account-row';

          const left = document.createElement('div');
          left.className = 'plaid-account-left';

          const acctName = document.createElement('span');
          acctName.className   = 'plaid-account-name';
          acctName.textContent = acct.name + (acct.mask ? ' ···' + acct.mask : '');

          const acctMeta = document.createElement('span');
          acctMeta.className = 'plaid-account-type';
          if (pikeAcct) {
            acctMeta.textContent = '→ ' + pikeAcct.name;
            acctMeta.classList.add('is-mapped');
          } else {
            acctMeta.textContent = '→ not mapped';
          }

          left.appendChild(acctName);
          left.appendChild(acctMeta);

          const bal    = acct.balances?.current ?? acct.balances?.available ?? 0;
          const acctBal = document.createElement('span');
          acctBal.className   = 'plaid-account-balance';
          acctBal.textContent = fmtUSD(Math.round(bal * 100));

          row.appendChild(left);
          row.appendChild(acctBal);
          acctList.appendChild(row);
        });

        card.appendChild(acctList);

        // Map accounts action
        const mapRow = document.createElement('div');
        mapRow.className = 'plaid-card-actions';

        const mapBtn = document.createElement('button');
        mapBtn.type      = 'button';
        mapBtn.className = 'btn btn-ghost btn-sm';
        mapBtn.textContent = getMappedPikeAccounts(item.id).length
          ? 'Edit account mappings'
          : 'Map accounts';
        mapBtn.addEventListener('click', () => openMappingModal(item, acctData.accounts));
        mapRow.appendChild(mapBtn);
        card.appendChild(mapRow);
      }

      // Transaction preview + import button
      const txnData = previewTxns.find((p) => p.item_id === item.id);
      if (txnData && txnData.added.length) {
        const txnSection = document.createElement('div');
        txnSection.className = 'plaid-txn-preview';

        const txnHead = document.createElement('p');
        txnHead.className   = 'plaid-txn-head';
        txnHead.textContent = `Recent transactions · ${txnData.added.length} found`;
        txnSection.appendChild(txnHead);

        const txnList = document.createElement('div');
        txnList.className = 'plaid-txn-list';

        txnData.added.slice(0, 5).forEach((t) => {
          const mapped = mapTransaction(t);
          const row    = document.createElement('div');
          row.className = 'plaid-txn-row';

          const left = document.createElement('div');
          left.className = 'plaid-txn-left';

          const merch = document.createElement('span');
          merch.className   = 'plaid-txn-merchant';
          merch.textContent = mapped.merchant;

          const dt = document.createElement('span');
          dt.className   = 'plaid-txn-date';
          dt.textContent = mapped.date;

          left.appendChild(merch);
          left.appendChild(dt);

          const amt = document.createElement('span');
          amt.className   = 'plaid-txn-amount' + (mapped.direction === 'inflow' ? ' is-income' : '');
          amt.textContent = (mapped.direction === 'outflow' ? '−' : '+') + fmtUSD(mapped.amountCents);

          row.appendChild(left);
          row.appendChild(amt);
          txnList.appendChild(row);
        });

        txnSection.appendChild(txnList);

        // Import action
        const importRow = document.createElement('div');
        importRow.className = 'plaid-card-actions';

        const mappedCount = getMappedPikeAccounts(item.id).length;
        if (mappedCount > 0) {
          const importBtn = document.createElement('button');
          importBtn.type        = 'button';
          importBtn.className   = 'btn btn-ghost btn-sm';
          importBtn.textContent = importingItemId === item.id ? 'Syncing…' : 'Sync transactions';
          importBtn.disabled    = importingItemId !== null;
          importBtn.addEventListener('click', () => openSyncModal(item));
          importRow.appendChild(importBtn);
        } else {
          const hint = document.createElement('p');
          hint.className   = 'plaid-status-line';
          hint.textContent = 'Map accounts above to enable import.';
          importRow.appendChild(hint);
        }

        txnSection.appendChild(importRow);
        card.appendChild(txnSection);
      }

      wrap.appendChild(card);
    });

    container.innerHTML = '';
    container.appendChild(wrap);
  }

  // ── Init ──────────────────────────────────────────────────────────────────────

  async function init() {
    await refreshStatus();
    if (connectedItems.length) await fetchPreview();
    render();
  }

  Pike.plaid = { init, render, connect, disconnect, refreshStatus, fetchPreview };
})(window);
