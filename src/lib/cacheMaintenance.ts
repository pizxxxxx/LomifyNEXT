import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { currentTrack, likedTracks, listenStats, settings } from '$lib/stores';
import { buildTrackUrn } from '$lib/utils/trackUrn';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

type CleanupPartReport = {
  removedFiles: number;
  freedBytes: number;
};

export type SmartCleanupReport = {
  removedFiles: number;
  freedBytes: number;
  audio: CleanupPartReport;
  images: CleanupPartReport;
};

export type CacheUsage = {
  audioBytes: number;
  likedBytes: number;
  imageBytes: number;
};

function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function finiteSetting(value: unknown, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export async function getCacheUsage(): Promise<CacheUsage> {
  if (!isTauri()) return { audioBytes: 0, likedBytes: 0, imageBytes: 0 };
  const [audioBytes, likedBytes, imageBytes] = await Promise.all([
    invoke<number>('track_cache_size'),
    invoke<number>('track_liked_cache_size'),
    invoke<number>('image_cache_size')
  ]);
  return { audioBytes, likedBytes, imageBytes };
}

export async function runSmartCacheCleanup(options: { force?: boolean } = {}) {
  if (!isTauri()) return null;

  const appSettings = get(settings);
  const now = Date.now();
  if (!options.force) {
    if (appSettings.autoCacheCleanup === false) return null;
    if (now - Number(appSettings.lastCacheCleanupAt || 0) < CLEANUP_INTERVAL_MS) return null;
  }

  const retentionDays = finiteSetting(appSettings.cacheRetentionDays, 30, 7, 365);
  const totalLimitMb = finiteSetting(appSettings.cacheMaxMb, 2048, 256, 16_384);
  const audioLimitMb = Math.max(128, Math.floor(totalLimitMb * 0.8));
  const imageLimitMb = Math.max(128, totalLimitMb - audioLimitMb);
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  const likes = get(likedTracks);
  const history = Object.values(get(listenStats).history || {});
  const playing = get(currentTrack);

  const likedUrns = likes.map(buildTrackUrn).filter(Boolean);
  const protectedUrns = new Set<string>();
  const protectedUrls = new Set<string>();

  for (const track of likes) {
    if (track?.coverUrl) protectedUrls.add(track.coverUrl);
  }
  if (playing) {
    protectedUrns.add(buildTrackUrn(playing));
    if (playing.coverUrl) protectedUrls.add(playing.coverUrl);
  }
  for (const entry of history) {
    if (!entry.lastPlayedAt || entry.lastPlayedAt < cutoff) continue;
    if (entry.source) protectedUrns.add(buildTrackUrn(entry));
    if (entry.coverUrl) protectedUrls.add(entry.coverUrl);
  }

  const [audio, images] = await Promise.all([
    invoke<CleanupPartReport>('track_smart_cleanup', {
      request: {
        likedUrns,
        protectedUrns: [...protectedUrns],
        maxAgeDays: retentionDays,
        limitMb: audioLimitMb
      }
    }),
    invoke<CleanupPartReport>('image_cache_prune', {
      request: {
        protectedUrls: [...protectedUrls],
        maxAgeDays: retentionDays,
        limitMb: imageLimitMb
      }
    })
  ]);

  settings.update(value => ({ ...value, lastCacheCleanupAt: Date.now() }));
  window.dispatchEvent(new CustomEvent('trackCacheChanged'));
  window.dispatchEvent(new CustomEvent('cacheCleared'));
  return {
    removedFiles: audio.removedFiles + images.removedFiles,
    freedBytes: audio.freedBytes + images.freedBytes,
    audio,
    images
  } satisfies SmartCleanupReport;
}
