// Injected into every recorded document: the focused field gets a halo, every click leaves a ripple and
// rings its target long enough to be seen in a video (from ter's demo/halo.js; UI5 wrappers kept, the
// navigation item and table row added). Idempotent by its style tag.
export const HALO = `(() => {
  if (document.querySelector('style[data-sail-halo]')) return;
  const style = document.createElement('style'); style.setAttribute('data-sail-halo', '');
  style.textContent = \`
    .sail-halo { outline: 3px solid #f59e0b !important; outline-offset: 3px !important; border-radius: 8px;
      box-shadow: 0 0 0 7px rgba(245, 158, 11, 0.35), 0 0 22px 9px rgba(245, 158, 11, 0.55) !important; }
    .sail-ripple { position: fixed; z-index: 2147483647; pointer-events: none; width: 36px; height: 36px; margin: -18px 0 0 -18px;
      border: 5px solid #f59e0b; border-radius: 50%; animation: sail-ripple 1000ms ease-out forwards; }
    @keyframes sail-ripple { from { transform: scale(0.35); opacity: 1; } to { transform: scale(3.6); opacity: 0; } }\`;
  document.head.appendChild(style);
  const WRAPPER = '.sapMInputBase, .sapMSlt, .sapMCb, .sapMBtn, .sapMITBItem, .sapTntNLI, .sapMLnk, .sapMListTblRow, ui5-button';
  const NATIVE = 'button, a, input, textarea, select';
  const boxOf = (el) => (el && el.closest ? el.closest(WRAPPER) || el.closest(NATIVE) || el : el);
  let ringed = null;
  const ring = (el) => { if (ringed && ringed !== el) ringed.classList.remove('sail-halo'); ringed = el; if (el) el.classList.add('sail-halo'); };
  const unring = (el) => { if (el) el.classList.remove('sail-halo'); if (ringed === el) ringed = null; };
  document.addEventListener('focusin', (e) => ring(boxOf(e.target)), true);
  document.addEventListener('focusout', (e) => { const el = boxOf(e.target); setTimeout(() => { if (!el.contains(document.activeElement)) unring(el); }, 250); }, true);
  document.addEventListener('pointerdown', (e) => {
    const r = document.createElement('div'); r.className = 'sail-ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px';
    document.body.appendChild(r); setTimeout(() => r.remove(), 1000);
    const el = boxOf(e.target); ring(el); setTimeout(() => { if (!el.contains(document.activeElement)) unring(el); }, 1500);
  }, true);
})();`;
