/* Virtual Pike — Quotes module
 * Seeds default quotes, provides session-based rotation, renders quote card on
 * Today and a full library in the Quotes section.
 */

(function (global) {
  'use strict';

  const SESSION_KEY = 'pike-quote-idx';

  const DEFAULT_QUOTES = [
    {
      id: 'q1',
      text: 'You still love planning, you still love organizing, you still love making it beautiful — but you do it because you want to, not because everything will fall apart if you don\'t. You operate from a well of desire, not a pit of desperation.',
      author: '',
    },
    {
      id: 'q2',
      text: 'Until I see another\'s behavior with compassion, I have not understood it.',
      author: '',
    },
    {
      id: 'q3',
      text: 'You don\'t heal by changing who you are; you heal by learning how to be yourself in the world.',
      author: '',
    },
    {
      id: 'q4',
      text: 'No one creates your feelings. No one is to blame for your situation. You are the author of your condition. Taking responsibility always leads to a revelation of what your next step needs to be.',
      author: '',
    },
    {
      id: 'q5',
      text: 'Every action you take is a vote for the type of person you wish to become. No single instance will transform your beliefs, but as the votes build up, so does the evidence of your new identity.',
      author: 'James Clear',
    },
    {
      id: 'q6',
      text: 'It is easy to get bogged down trying to find the optimal plan for change. We are so focused on figuring out the best approach that we never get around to taking action. As Voltaire once wrote, "The best is the enemy of the good."',
      author: 'James Clear',
    },
    {
      id: 'q7',
      text: 'In times of change, learners inherit the earth, while the learned find themselves beautifully equipped to deal with a world that no longer exists.',
      author: 'Eric Hoffer',
    },
    {
      id: 'q8',
      text: 'Opinion is really the lowest form of human knowledge. It requires no accountability, no understanding. The highest form of knowledge is empathy, for it requires us to suspend our egos and live in another\'s world.',
      author: 'Bill Bullard',
    },
  ];

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function uid() {
    return 'q-' + Math.random().toString(36).slice(2, 9);
  }

  function init() {
    const data = global.Pike.state.data;
    if (!data.quotes || data.quotes.length === 0) {
      global.Pike.state.commit((d) => {
        d.quotes = DEFAULT_QUOTES.map((q) => ({ ...q, addedAt: new Date().toISOString() }));
      });
    }
  }

  // ── Session-based quote: pick once per browser session ─────────────────────
  function getSessionQuote() {
    const quotes = global.Pike.state.data.quotes || [];
    if (!quotes.length) return null;

    let idx = parseInt(sessionStorage.getItem(SESSION_KEY), 10);
    if (!Number.isFinite(idx) || idx < 0 || idx >= quotes.length) {
      idx = Math.floor(Math.random() * quotes.length);
      sessionStorage.setItem(SESSION_KEY, idx);
    }
    return quotes[idx];
  }

  // ── Render Today quote card ────────────────────────────────────────────────
  function render() {
    const el = document.getElementById('today-quote-card');
    if (!el) return;
    const q = getSessionQuote();
    if (!q) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `
      <blockquote class="today-quote-text">${esc(q.text)}</blockquote>
      ${q.author ? `<cite class="today-quote-author">— ${esc(q.author)}</cite>` : ''}
    `;
  }

  // ── Render Quotes library section ─────────────────────────────────────────
  function renderLibrary() {
    const container = document.getElementById('quotes-library');
    if (!container) return;

    const quotes = global.Pike.state.data.quotes || [];

    if (!quotes.length) {
      container.innerHTML = `<p class="quotes-empty">No quotes yet. Add one below.</p>`;
      return;
    }

    container.innerHTML = quotes.map((q, i) => `
      <div class="quote-card" data-id="${esc(q.id)}">
        <div class="quote-card-number">${String(i + 1).padStart(2, '0')}</div>
        <div class="quote-card-body">
          <blockquote class="quote-card-text">${esc(q.text)}</blockquote>
          ${q.author ? `<cite class="quote-card-author">— ${esc(q.author)}</cite>` : ''}
        </div>
        <button class="quote-delete-btn" data-id="${esc(q.id)}" type="button" aria-label="Delete quote">×</button>
      </div>
    `).join('');

    container.querySelectorAll('.quote-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => deleteQuote(btn.dataset.id));
    });
  }

  // ── Add / delete ──────────────────────────────────────────────────────────
  function addQuote(text, author) {
    const trimText = (text || '').trim();
    if (!trimText) return;
    global.Pike.state.commit((d) => {
      if (!d.quotes) d.quotes = [];
      d.quotes.push({ id: uid(), text: trimText, author: (author || '').trim(), addedAt: new Date().toISOString() });
    });
    // Clear session index so the new quote pool is valid
    sessionStorage.removeItem(SESSION_KEY);
  }

  function deleteQuote(id) {
    global.Pike.state.commit((d) => {
      d.quotes = (d.quotes || []).filter((q) => q.id !== id);
    });
    sessionStorage.removeItem(SESSION_KEY);
  }

  // ── Open add-quote modal ──────────────────────────────────────────────────
  function openAddModal() {
    if (!global.Pike.modal) return;

    global.Pike.modal.open({
      title: 'Add a quote',
      body: `
        <div class="quote-modal-form">
          <div class="field-group">
            <label class="field-label" for="qm-text">Quote</label>
            <textarea id="qm-text" class="input quote-modal-textarea" rows="4"
              placeholder="Paste or type a quote…" autofocus></textarea>
          </div>
          <div class="field-group">
            <label class="field-label" for="qm-author">Author <span class="field-optional">(optional)</span></label>
            <input id="qm-author" class="input" type="text" placeholder="e.g. James Clear">
          </div>
          <div class="modal-actions">
            <button id="qm-save" class="btn btn-primary" type="button">Save</button>
          </div>
        </div>
      `,
      onOpen(modalEl) {
        const textEl   = modalEl.querySelector('#qm-text');
        const authorEl = modalEl.querySelector('#qm-author');
        const saveBtn  = modalEl.querySelector('#qm-save');
        saveBtn.addEventListener('click', () => {
          if (!textEl.value.trim()) { textEl.focus(); return; }
          addQuote(textEl.value, authorEl.value);
          global.Pike.modal.close();
        });
        // Cmd/Ctrl+Enter to save
        textEl.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveBtn.click();
        });
      },
    });
  }

  // ── Wire add button ───────────────────────────────────────────────────────
  function wireAddBtn() {
    const btn = document.getElementById('quotes-add-btn');
    if (btn && !btn._wired) {
      btn.addEventListener('click', openAddModal);
      btn._wired = true;
    }
  }

  function initLibrary() {
    wireAddBtn();
    renderLibrary();
  }

  global.Pike = global.Pike || {};
  global.Pike.quotes = { init, render, renderLibrary, initLibrary, getSessionQuote, addQuote, deleteQuote };
})(window);
