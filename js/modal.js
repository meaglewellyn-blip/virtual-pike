/* Virtual Pike — reusable modal
 *
 *   Pike.modal.open({
 *     title: 'Add event',
 *     body: HTMLElement | string,    // string is interpreted as HTML
 *     onClose: () => void,           // optional
 *   });
 *
 *   Pike.modal.close();
 */

(function (global) {
  'use strict';

  let onCloseFn = null;

  function $(id) { return document.getElementById(id); }

  function open({ title = '', body = '', onClose = null } = {}) {
    const root = $('pike-modal');
    const titleEl = $('pike-modal-title');
    const bodyEl = $('pike-modal-body');
    if (!root || !titleEl || !bodyEl) return;

    titleEl.textContent = title;
    bodyEl.innerHTML = '';
    if (typeof body === 'string') {
      bodyEl.innerHTML = body;
    } else if (body instanceof HTMLElement) {
      bodyEl.appendChild(body);
    }

    onCloseFn = onClose;
    root.hidden = false;
    document.body.style.overflow = 'hidden';

    // Focus the first focusable element
    setTimeout(() => {
      const focusable = bodyEl.querySelector('input, textarea, select, button');
      if (focusable) focusable.focus();
    }, 0);
  }

  function close() {
    const root = $('pike-modal');
    if (!root) return;
    root.hidden = true;
    document.body.style.overflow = '';
    const fn = onCloseFn;
    onCloseFn = null;
    if (typeof fn === 'function') fn();
  }

  function init() {
    const root = $('pike-modal');
    if (!root) return;

    root.addEventListener('click', (e) => {
      if (e.target && e.target.dataset && e.target.dataset.modalClose === '1') {
        close();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !root.hidden) {
        close();
      }
    });
  }

  global.Pike = global.Pike || {};
  global.Pike.modal = { init, open, close };
})(window);
