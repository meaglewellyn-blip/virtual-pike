/* Virtual Pike — Quotes module
 * Seeds default quotes, provides daily rotation, renders quote card on Today.
 */

(function (global) {
  'use strict';

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

  function escapeHTML(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function init() {
    const data = global.Pike.state.data;
    if (!data.quotes || data.quotes.length === 0) {
      global.Pike.state.commit((d) => {
        d.quotes = DEFAULT_QUOTES.map((q) => ({ ...q, addedAt: new Date().toISOString() }));
      });
    }
  }

  function getDailyQuote() {
    const quotes = global.Pike.state.data.quotes || [];
    if (!quotes.length) return null;
    const daysSinceEpoch = Math.floor(Date.now() / 86400000);
    return quotes[daysSinceEpoch % quotes.length];
  }

  function render() {
    const el = document.getElementById('today-quote-card');
    if (!el) return;
    const q = getDailyQuote();
    if (!q) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `
      <blockquote class="today-quote-text">${escapeHTML(q.text)}</blockquote>
      ${q.author ? `<cite class="today-quote-author">— ${escapeHTML(q.author)}</cite>` : ''}
    `;
  }

  global.Pike = global.Pike || {};
  global.Pike.quotes = { init, render, getDailyQuote };
})(window);
