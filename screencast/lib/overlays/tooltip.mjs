// Browser tooltips are drawn by the operating system and never reach a recording: the title of the control
// under the pointer is shown in a bubble instead (from ter's demo/tooltip.js), unless it repeats the control's visible
// text (a navigation item's bubble only covered the caption). Idempotent by its style tag.
export const TOOLTIP = `(() => {
  if (document.querySelector('style[data-sail-tip]')) return;
  const style = document.createElement('style'); style.setAttribute('data-sail-tip', '');
  style.textContent = \`.sail-tip { position: fixed; z-index: 2147483646; max-width: 34rem; padding: 10px 14px; background: #0B1F33; color: #fff;
    font: 18px/1.4 '72', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.35); pointer-events: none; }\`;
  document.head.appendChild(style);
  let tip = null;
  const hide = () => { if (tip) { tip.remove(); tip = null; } };
  document.addEventListener('mouseover', (e) => {
    const holder = e.target && e.target.closest && e.target.closest('[title]');
    const text = holder && holder.getAttribute('title');
    hide();
    if (!text || holder.textContent.trim() === text.trim()) return;
    tip = document.createElement('div'); tip.className = 'sail-tip'; tip.textContent = text; document.body.appendChild(tip);
    const r = holder.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - t.width - 8));
    const top = r.bottom + 8 + t.height > window.innerHeight ? Math.max(8, r.top - t.height - 8) : r.bottom + 8;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  }, true);
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget || !(e.relatedTarget.closest && e.relatedTarget.closest('[title]'))) hide(); }, true);
})();`;
