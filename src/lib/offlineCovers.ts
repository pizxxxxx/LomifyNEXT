import { invoke } from '@tauri-apps/api/core';
import { writable } from 'svelte/store';
import { buildTrackUrn } from '$lib/utils/trackUrn';

export interface DownloadedCoverCacheState {
  proxyPort: number;
  cachedUrns: Set<string>;
}

export const downloadedCoverCache = writable<DownloadedCoverCacheState>({
  proxyPort: 0,
  cachedUrns: new Set<string>()
});

/**
 * Ask the two artwork CDNs used by Lomify for an image close to its rendered size.
 * A 48px list row does not need a decoded 500x500 bitmap (roughly 1 MB in RGBA) for
 * every visible item. Unknown and local URLs stay untouched.
 */
export function coverUrlAtSize(url: string, requestedSize: number): string {
  if (!url) return '';
  const size = Math.max(32, Math.min(1000, Math.round(requestedSize)));

  if (url.includes('avatars.yandex.net') || url.includes('.yandex.net/get-music-content')) {
    return url
      .replace('%%', `${size}x${size}`)
      .replace(/\/\d+x\d+(?=($|[?#]))/, `/${size}x${size}`);
  }

  if (url.includes('sndcdn.com')) {
    const supported = [50, 120, 200, 300, 500];
    const soundCloudSize = supported.find((candidate) => candidate >= size) ?? 500;
    return url.replace(
      /-(t\d+x\d+|large|badge|small|tiny|mini|crop)(?=\.(jpg|jpeg|png)(?:$|[?#]))/i,
      `-t${soundCloudSize}x${soundCloudSize}`
    );
  }

  return url;
}

function encodePayload(values: string[]): string {
  const bytes = new TextEncoder().encode(JSON.stringify(values));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return encodeURIComponent(btoa(binary));
}

/**
 * Return the local cover endpoint only for tracks whose audio is on disk. The
 * endpoint reads `audio_covers/` first and uses the original URL only to
 * backfill downloads made by older versions.
 */
export function coverUrlForTrack(
  track: any,
  state: DownloadedCoverCacheState
): string {
  const remoteUrl = `${track?.coverUrl ?? ''}`.trim();
  if (!remoteUrl || !state.proxyPort || !track) return remoteUrl;

  const urn = buildTrackUrn(track);
  if (!state.cachedUrns.has(urn)) return remoteUrl;

  const payload = encodePayload([urn, remoteUrl]);
  return `http://127.0.0.1:${state.proxyPort}/downloaded-cover/${payload}`;
}

/** Initialize the native proxy port and keep the synchronous URN set current. */
export async function initDownloadedCoverCache(): Promise<() => void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return () => {};
  }

  try {
    const [[, proxyPort], urns] = await Promise.all([
      invoke<[number, number]>('get_server_ports'),
      invoke<string[]>('track_list_cached')
    ]);
    downloadedCoverCache.set({ proxyPort, cachedUrns: new Set(urns) });
  } catch (error) {
    console.warn('[covers] не удалось открыть локальные обложки', error);
  }

  const onTrackCacheChanged = (event: Event) => {
    const detail = (event as CustomEvent<{ urn?: string; cached?: boolean }>).detail;
    if (!detail?.urn) return;
    const urn = detail.urn;
    downloadedCoverCache.update((state) => {
      const cachedUrns = new Set(state.cachedUrns);
      if (detail.cached) cachedUrns.add(urn);
      else cachedUrns.delete(urn);
      return { ...state, cachedUrns };
    });
  };

  window.addEventListener('trackCacheChanged', onTrackCacheChanged);
  return () => window.removeEventListener('trackCacheChanged', onTrackCacheChanged);
}
