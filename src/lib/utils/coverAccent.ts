/**
 * Pulls a usable accent colour out of the current track's artwork.
 *
 * The app shipped with `--app-primary: #1DB954` (Spotify's green) and thirteen
 * themes that each swap that one variable, so the interface never reacted to
 * what was actually playing. Feeding the accent from the cover makes the window
 * breathe with the music instead — `body[data-global-theme]` already mixes the
 * accent into the background, so the whole surface follows along.
 *
 * Everything here degrades quietly: a cover that will not decode, a canvas the
 * browser refuses to read back, or artwork with no colour in it all return
 * `null`, and the caller keeps the user's chosen theme colour.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Covers repeat constantly (queue, history, back-navigation). */
const cache = new Map<string, Rgb | null>();
const CACHE_LIMIT = 120;

/** Downscale target. 24x24 is 576 samples — plenty for a dominant hue, and the
 *  GPU does the averaging for us during the draw. */
const SAMPLE_SIZE = 24;

function rgbToHsl({ r, g, b }: Rgb): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];

  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const hue = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue(h + 1 / 3) * 255),
    g: Math.round(hue(h) * 255),
    b: Math.round(hue(h - 1 / 3) * 255),
  };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // sndcdn.com serves `Access-Control-Allow-Origin: *`, so the canvas stays
    // untainted and readable. Anything that does not gets caught below.
    img.crossOrigin = 'anonymous';
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('cover failed to load'));
    img.src = url;
  });
}

/**
 * Buckets pixels by hue and returns the most *present* colourful bucket rather
 * than the mathematically dominant pixel: covers are mostly dark backgrounds,
 * and averaging them yields mud every time. Near-black, near-white and grey
 * pixels are dropped before the vote so a monochrome sleeve falls through to
 * `null` instead of producing a dead grey accent.
 */
function pickAccent(data: Uint8ClampedArray): Rgb | null {
  const BUCKETS = 24;
  const weight = new Float64Array(BUCKETS);
  const satSum = new Float64Array(BUCKETS);
  const lumSum = new Float64Array(BUCKETS);
  const count = new Float64Array(BUCKETS);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue; // transparent
    const [h, s, l] = rgbToHsl({ r: data[i], g: data[i + 1], b: data[i + 2] });
    if (s < 0.16) continue; // grey — carries no hue worth using
    if (l < 0.1 || l > 0.94) continue; // crushed black / blown white

    const bucket = Math.min(BUCKETS - 1, Math.floor(h * BUCKETS));
    // Weight by saturation so a small vivid area beats a large washed-out one —
    // that small vivid area is what a person would call "the colour of the
    // cover". Mid lightness is favoured over both extremes.
    weight[bucket] += s * s * (1 - Math.abs(l - 0.5) * 1.2);
    satSum[bucket] += s;
    lumSum[bucket] += l;
    count[bucket] += 1;
  }

  let best = -1;
  let bestWeight = 0;
  for (let i = 0; i < BUCKETS; i++) {
    if (weight[i] > bestWeight) {
      bestWeight = weight[i];
      best = i;
    }
  }
  if (best === -1 || count[best] < 4) return null;

  const hue = (best + 0.5) / BUCKETS;
  const sat = satSum[best] / count[best];
  const lum = lumSum[best] / count[best];

  // Normalise into a band that works as an accent on a near-black UI: readable
  // against #0a0a0c, still bright enough for a progress bar or a focus ring,
  // never so hot that white text on top of it breaks.
  return hslToRgb(
    hue,
    Math.min(0.82, Math.max(0.5, sat * 1.15)),
    Math.min(0.62, Math.max(0.44, lum * 0.95 + 0.12)),
  );
}

/**
 * Resolves to the artwork's accent colour, or `null` when there is nothing
 * usable to take (no URL, decode failure, tainted canvas, monochrome cover).
 * Results — including the failures — are cached per URL.
 */
export async function extractCoverAccent(url: string | undefined | null): Promise<Rgb | null> {
  if (!url || typeof document === 'undefined') return null;
  if (cache.has(url)) return cache.get(url) ?? null;

  let result: Rgb | null = null;
  try {
    const img = await loadImage(url);
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });
    if (ctx) {
      ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      // Throws a SecurityError on a tainted canvas — treated like any other
      // "no colour available" outcome.
      result = pickAccent(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
    }
  } catch {
    result = null;
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, result);
  return result;
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
