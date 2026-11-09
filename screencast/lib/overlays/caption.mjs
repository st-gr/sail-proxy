// The caption bar of the video cards (bottom left, deep navy, blue edge, "Step n of N" above the text).
// window.__sailCaption(text, { step, total }) shows it, window.__sailCaptionOff() hides it. Idempotent.
export const CAPTION = `(() => {
  if (window.__sailCaption) return;
  const style = document.createElement('style'); style.setAttribute('data-sail-caption', '');
  style.textContent = \`.sail-cap { position: fixed; left: 0; bottom: 44px; max-width: 62%; padding: 14px 28px 14px 24px; z-index: 2147483645;
      font: 600 26px/1.3 '72', -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; color: #fff; background: rgba(11, 31, 51, .92);
      border-radius: 0 10px 10px 0; box-shadow: inset 8px 0 0 #33B1FF; pointer-events: none; opacity: 0; transition: opacity .3s; }
    .sail-cap.on { opacity: 1; }
    .sail-cap small { display: block; font-size: 15px; font-weight: 600; letter-spacing: .1em; text-transform: uppercase; color: #8FD0FF; margin-bottom: 2px; }\`;
  document.head.appendChild(style);
  let bar = null;
  // page.screencast writes a frame only when the next one arrives: on an idle page the frame with the caption would
  // never reach the clip, so once a caption is shown an invisible pixel keeps repainting (as on the cast page).
  const paint = () => {
    if (document.querySelector('.sail-cap-paint')) return;
    const px = document.createElement('div'); px.className = 'sail-cap-paint';
    px.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;z-index:2147483645;pointer-events:none;background:#000';
    document.body.appendChild(px); let k = 0; setInterval(() => { px.style.opacity = k++ % 2 ? '0.01' : '0.02'; }, 100);
  };
  window.__sailCaption = (text, opts) => {
    const { step, total } = opts || {};
    if (!bar) { bar = document.createElement('div'); bar.className = 'sail-cap'; document.body.appendChild(bar); }
    bar.textContent = '';
    if (step) { const s = document.createElement('small'); s.textContent = total ? 'Step ' + step + ' of ' + total : 'Step ' + step; bar.appendChild(s); }
    bar.appendChild(document.createTextNode(text)); bar.classList.add('on'); paint();
  };
  window.__sailCaptionOff = () => { if (bar) bar.classList.remove('on'); };
})();`;
