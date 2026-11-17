// Output sizes of the documentation videos. 1080p is how every clip and card is recorded; 1440p (2560×1440) is the
// size YouTube serves in its higher quality tier, as for the teaser: the cards are drawn into 2560×1440 pixels (the
// 1920×1080 layout zoomed by 4/3, so their text is sharp), the recorded clips are scaled up once.
import { H264 } from './encoder.mjs';

const SIZES = { '1080p': { w: 1920, h: 1080, rate: '12M' }, '1440p': { w: 2560, h: 1440, rate: '28M' } };

function px(size) {
  const p = SIZES[size];
  if (!p) throw new Error(`unknown size ${size}`);
  return p;
}

export const encodeFor = (size) => {
  const { w, h, rate } = px(size);
  return ['-r', '30', '-vf', `scale=${w}:${h}:flags=lanczos,format=yuv420p`, '-c:v', H264, '-b:v', rate, '-pix_fmt', 'yuv420p', '-an'];
};

export const sizeTag = (size) => (px(size) && size === '1080p' ? '' : `_${size}`);

// 'cards/intro.mp4' → 'cards-1440p/intro.mp4': the 1440p copies live next to the recorded ones.
export const sizedFile = (file, size) => (px(size) && size === '1080p' ? file : file.replace(/^(cards|clips)\//, `$1-${size}/`));

export const cardViewport = (size) => { const { w, h } = px(size); return { width: w, height: h, zoom: w / 1920 }; };
export const bitrateFor = (size) => px(size).rate;
