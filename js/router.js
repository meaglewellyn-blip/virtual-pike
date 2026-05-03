/* Virtual Pike — hash-based section router */

(function (global) {
  'use strict';

  const SECTIONS = ['today', 'week', 'rhythms', 'travel', 'people', 'reminders', 'braindump', 'tasks', 'quotes', 'settings'];
  const DEFAULT = 'today';

  function currentSection() {
    const raw = (location.hash || '').replace(/^#/, '').trim();
    return SECTIONS.includes(raw) ? raw : DEFAULT;
  }

  function activate(section) {
    const target = SECTIONS.includes(section) ? section : DEFAULT;

    document.querySelectorAll('.section').forEach((el) => {
      el.classList.toggle('is-active', el.id === `section-${target}`);
    });
    document.querySelectorAll('.nav-link').forEach((el) => {
      el.classList.toggle('is-active', el.dataset.section === target);
    });

    document.dispatchEvent(new CustomEvent('pike:section', { detail: { section: target } }));
  }

  function init() {
    activate(currentSection());
    window.addEventListener('hashchange', () => activate(currentSection()));

    document.querySelectorAll('.nav-link').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const section = el.dataset.section;
        if (!section) return;
        history.replaceState(null, '', `#${section}`);
        activate(section);
      });
    });
  }

  global.Pike = global.Pike || {};
  global.Pike.router = { init, activate, currentSection };
})(window);
