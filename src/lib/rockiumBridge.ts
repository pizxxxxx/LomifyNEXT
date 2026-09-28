import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { currentTrack, isPlaying, progress, duration, settings, lyricsReloadTrigger } from './stores';
import { getLyrics } from './api';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { coverUrlAtSize, coverUrlForTrack, downloadedCoverCache } from './offlineCovers';

function extractCoverUrl(track: any): string {
  if (!track) return '';
  let url = `${track.coverUrl || track.artwork_url || track.ogImage || track.coverUri || track.avatarUrl || track.user?.avatar_url || track.album?.coverUrl || ''}`.trim();
  if (!url) return '';
  if (url.startsWith('//')) url = 'https:' + url;
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
    url = 'https://' + url;
  }
  return url;
}

async function artworkPng(rawUrl: string): Promise<string> {
  if (!rawUrl) return '';
  let url = rawUrl.trim();
  if (url.startsWith('//')) url = 'https:' + url;
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('data:')) {
    url = 'https://' + url;
  }

  if (url.startsWith('data:image/png;base64,')) {
    const raw = url.slice(22).trim();
    if (raw.length <= 200_000) return raw;
  }

  let response: Response;
  try {
    response = await window.fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    response = await nativeFetch(url, { signal: AbortSignal.timeout(8000) });
  }
  if (!response.ok) throw new Error(`Cover HTTP ${response.status}`);

  const bytes = await response.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > 8_000_000) return '';
  const mime = response.headers.get('content-type') || 'image/jpeg';
  const blob = new Blob([bytes], { type: mime });
  const objectUrl = URL.createObjectURL(blob);
  const image = new Image();
  try {
    image.src = objectUrl;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 160;
    const context = canvas.getContext('2d');
    if (!context) return '';
    const size = Math.min(image.width, image.height);
    context.drawImage(image, (image.width - size) / 2, (image.height - size) / 2, size, size, 0, 0, 160, 160);
    const dataUrl = canvas.toDataURL('image/png');
    const comma = dataUrl.indexOf(',');
    const encoded = comma !== -1 ? dataUrl.slice(comma + 1) : '';
    return encoded.length <= 200_000 ? encoded : '';
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** One publisher for the mounted player, including when its lyrics view is closed. */
export function startRockiumBridge(): () => void {
  let stopped = false;
  let busy = false;
  let generation = 0;
  let identity = '';
  let lyrics = '';
  let artwork = '';
  let artworkStatus = 'idle';
  let reportedFailure = false;
  let lastConfiguredEnabled: boolean | null = null;
  let lastConfiguredServerEnabled: boolean | null = null;

  function configure(enabled: boolean, serverEnabled: boolean) {
    if (lastConfiguredEnabled === enabled && lastConfiguredServerEnabled === serverEnabled) return;
    lastConfiguredEnabled = enabled;
    lastConfiguredServerEnabled = serverEnabled;
    invoke('rockium_configure', { enabled, serverEnabled }).catch(err => {
      console.warn('[Rockium] Failed to configure bridge:', err);
    });
  }

  function loadCover(track: any, request: number, attempt = 1) {
    const raw = extractCoverUrl(track);
    if (!raw) {
      artwork = '';
      artworkStatus = 'empty';
      void publish();
      return;
    }
    const resolvedUrl = coverUrlForTrack({ ...track, coverUrl: raw }, get(downloadedCoverCache));
    const sized = coverUrlAtSize(resolvedUrl, 200);
    void artworkPng(sized).then(value => {
      if (!stopped && request === generation) {
        artwork = value;
        artworkStatus = value ? 'ready' : 'empty';
        void publish();
      }
    }).catch(error => {
      if (!stopped && request === generation) {
        if (attempt < 2) {
          setTimeout(() => {
            if (!stopped && request === generation && !artwork) {
              loadCover(track, request, attempt + 1);
            }
          }, 1500);
        } else {
          artworkStatus = String(error).slice(0, 240);
          console.warn('[Rockium] Cover could not be decoded:', error);
          void publish();
        }
      }
    });
  }

  function loadTrackLyrics(track: any, request: number, force = false) {
    void getLyrics(track.title, track.artist, track, force).then(text => {
      if (!stopped && request === generation) {
        lyrics = (text || '').slice(0, 100_000);
        void publish();
      }
    }).catch(() => {
      if (!stopped && request === generation) void publish();
    });
  }

  const unsubs = [
    currentTrack.subscribe(track => {
      const next = track ? `${track.source}:${track.id}:${track.title}:${track.artist}` : '';
      if (next === identity) return;
      identity = next;
      const request = ++generation;
      lyrics = '';
      artwork = '';
      artworkStatus = track ? 'loading' : 'idle';
      if (track) {
        loadCover(track, request);
        loadTrackLyrics(track, request);
      }
      void publish();
    }),
    lyricsReloadTrigger.subscribe(() => {
      const track = get(currentTrack);
      if (track) {
        loadTrackLyrics(track, generation, true);
      }
    }),
    isPlaying.subscribe(() => { void publish(); }),
    settings.subscribe(s => {
      const enabled = s.rockiumEnabled !== false;
      const serverEnabled = s.rockiumServerEnabled !== false;
      configure(enabled, serverEnabled);
      void publish();
    }),
  ];

  async function publish() {
    if (stopped || busy) return;
    const currentSettings = get(settings);
    if (currentSettings.rockiumEnabled === false) return;

    busy = true;
    const track = get(currentTrack);
    try {
      await invoke('rockium_publish', { snapshot: {
        version: 1, title: track?.title || '', artist: track?.artist || '',
        playing: !!track && get(isPlaying), position: Math.max(0, get(progress)),
        duration: Math.max(0, get(duration)), lyrics, artwork, artwork_status: artworkStatus,
        offset: (currentSettings.lyricsOffset || 0) / 1000 - 0.08,
      }});
      reportedFailure = false;
    } catch (error) {
      if (!reportedFailure) console.warn('[Rockium] Local lyrics bridge unavailable:', error);
      reportedFailure = true;
    } finally { busy = false; }
  }

  const timer = setInterval(() => void publish(), 500);
  return () => { stopped = true; generation++; clearInterval(timer); unsubs.forEach(u => u()); };
}
