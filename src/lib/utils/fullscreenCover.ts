/** Provider-specific large images; local/cache URLs stay local. No network work
 * here, so lists and miniature artwork keep their existing memory budget. */
export function fullscreenCoverCandidates(source: string): string[] {
  if (!source) return [];
  let url: URL;
  try { url = new URL(source); } catch { return [source]; }
  if (url.protocol !== 'https:') return [source];
  if (url.hostname === 'avatars.yandex.net' || url.hostname.endsWith('.yandex.net')) {
    const large = source.replace('%%', '1000x1000').replace(/\/\d+x\d+(?=($|[?#]))/, '/1000x1000');
    return [...new Set([large, source])];
  }
  if (url.hostname.endsWith('.sndcdn.com')) {
    const pattern = /-(t\d+x\d+|large|badge|small|tiny|mini|crop|original)\.(jpg|jpeg|png)(?=$|[?#])/i;
    if (pattern.test(source)) {
      const original = source.replace(pattern, '-original.$2');
      const alternative = original.replace(/\.(jpg|jpeg|png)(?=$|[?#])/i, (_, extension) => extension.toLowerCase() === 'png' ? '.jpg' : '.png');
      return [...new Set([original, alternative, source])];
    }
  }
  return [source];
}

export async function loadFullscreenCover(source: string): Promise<string> {
  const candidates = fullscreenCoverCandidates(source);
  for (const candidate of candidates) {
    if (candidate === source) return source;
    const available = await new Promise<boolean>(resolve => {
      const img = new Image();
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return; settled = true;
        clearTimeout(timer); img.onload = img.onerror = null;
        if (!ok) img.src = '';
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 3500);
      img.decoding = 'async';
      img.onload = () => finish(img.naturalWidth > 0);
      img.onerror = () => finish(false);
      img.src = candidate;
    });
    if (available) return candidate;
  }
  return source;
}
