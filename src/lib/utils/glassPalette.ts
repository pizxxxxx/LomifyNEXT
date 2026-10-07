import { hslToRgb, rgbToHex, rgbToHsl } from './coverAccent.ts';

export interface GlassPalette { accent: string; glow: string; shade: string }
export const DEFAULT_GLASS_PALETTE: GlassPalette = { accent: '#c4cfdf', glow: '#253345', shade: '#141922' };

/** Three dominant hue groups from a 32x32 sample. Text always uses a pastel accent. */
export function glassPaletteFromPixels(pixels: Uint8ClampedArray): GlassPalette {
  const buckets = Array.from({ length: 24 }, () => ({ weight: 0, saturation: 0 }));
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const [h, s, l] = rgbToHsl({ r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] });
    if (s < 0.12 || l < 0.06 || l > 0.96) continue;
    const weight = s * (1 - Math.abs(l - 0.5));
    const bucket = buckets[Math.min(23, Math.floor(h * 24))];
    bucket.weight += weight;
    bucket.saturation += s * weight;
  }
  const ranked = buckets.map((bucket, index) => ({ ...bucket, hue: (index + 0.5) / 24 }))
    .filter(bucket => bucket.weight > 0).sort((a, b) => b.weight - a.weight);
  if (!ranked.length) return { ...DEFAULT_GLASS_PALETTE };
  const first = ranked[0];
  const second = ranked.find(bucket => Math.min(Math.abs(bucket.hue - first.hue), 1 - Math.abs(bucket.hue - first.hue)) > 0.12) || first;
  const saturation = first.saturation / first.weight;
  return {
    accent: rgbToHex(hslToRgb(first.hue, Math.min(0.52, Math.max(0.22, saturation * 0.48)), 0.77)),
    glow: rgbToHex(hslToRgb(first.hue, Math.min(0.75, saturation), 0.23)),
    shade: rgbToHex(hslToRgb(second.hue, Math.min(0.58, second.saturation / second.weight), 0.12))
  };
}

const cache = new Map<string, Promise<GlassPalette>>();
export function extractGlassPalette(url: string): Promise<GlassPalette> {
  if (!url || typeof document === 'undefined') return Promise.resolve({ ...DEFAULT_GLASS_PALETTE });
  const cached = cache.get(url);
  if (cached) return cached;
  const task = new Promise<GlassPalette>((resolve) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    const finish = (value: GlassPalette) => {
      clearTimeout(timeout);
      image.onload = image.onerror = null;
      resolve(value);
    };
    const timeout = setTimeout(() => finish({ ...DEFAULT_GLASS_PALETTE }), 5000);
    image.onerror = () => finish({ ...DEFAULT_GLASS_PALETTE });
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 32;
        const ctx = canvas.getContext('2d');
        if (!ctx) return finish({ ...DEFAULT_GLASS_PALETTE });
        ctx.drawImage(image, 0, 0, 32, 32);
        finish(glassPaletteFromPixels(ctx.getImageData(0, 0, 32, 32).data));
      } catch { finish({ ...DEFAULT_GLASS_PALETTE }); }
    };
    image.src = url;
  });
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(url, task);
  return task;
}
