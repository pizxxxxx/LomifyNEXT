import { get } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { currentTrack, isPlaying, progress, duration, settings } from './stores';
import { getLyrics } from './api';
import { fetch as nativeFetch } from '@tauri-apps/plugin-http';
import { coverUrlAtSize, coverUrlForTrack, downloadedCoverCache } from './offlineCovers';

async function artworkPng(url: string): Promise<string> {
  if (!url) return '';
  let response: Response;
  try { response = await window.fetch(url, { signal: AbortSignal.timeout(8000) }); }
  catch { response = await nativeFetch(url, { signal: AbortSignal.timeout(8000) }); }
  if (!response.ok) throw new Error(`Cover HTTP ${response.status}`);
  // The HTTP plugin overrides Response.headers; blob() can therefore lose the
  // original MIME type. Give WebView an explicitly typed image for decoding.
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 5_000_000) return '';
  const blob = new Blob([bytes], { type: response.headers.get('content-type') || 'image/jpeg' });
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
    context.drawImage(image, (image.width-size)/2, (image.height-size)/2, size, size, 0, 0, 160, 160);
    const encoded = canvas.toDataURL('image/png').split(',')[1] || '';
    return encoded.length <= 200_000 ? encoded : '';
  } finally { URL.revokeObjectURL(objectUrl); }
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
  const unsubscribe = currentTrack.subscribe(track => {
    const next = track ? `${track.source}:${track.id}:${track.title}:${track.artist}` : '';
    if (next === identity) return;
    identity = next;
    const request = ++generation;
    lyrics = '';
    artwork = '';
    artworkStatus = track ? 'loading' : 'idle';
    if (track) {
      void artworkPng(coverUrlAtSize(coverUrlForTrack(track, get(downloadedCoverCache)), 200)).then(value => {
        if (!stopped && request === generation) { artwork = value; artworkStatus = value ? 'ready' : 'empty'; void publish(); }
      }).catch(error => {
        if (!stopped && request === generation) {
          artworkStatus = String(error).slice(0, 240);
          console.warn('[Rockium] Cover could not be decoded:', error);
          void publish();
        }
      });
      void getLyrics(track.title, track.artist, track).then(text => {
        if (!stopped && request === generation) {
          lyrics = (text || '').slice(0, 100_000);
          void publish();
        }
      }).catch(() => {
        if (!stopped && request === generation) void publish();
      });
    }
    void publish();
  });

  async function publish() {
    if (stopped || busy) return;
    busy = true;
    const track = get(currentTrack);
    try {
      await invoke('rockium_publish', { snapshot: {
        version: 1, title: track?.title || '', artist: track?.artist || '',
        playing: !!track && get(isPlaying), position: Math.max(0, get(progress)),
        duration: Math.max(0, get(duration)), lyrics, artwork, artwork_status: artworkStatus,
        offset: (get(settings).lyricsOffset || 0) / 1000 - 0.08,
      }});
      reportedFailure = false;
    } catch (error) {
      if (!reportedFailure) console.warn('[Rockium] Local lyrics bridge unavailable:', error);
      reportedFailure = true;
    } finally { busy = false; }
  }
  const timer = setInterval(() => void publish(), 500);
  return () => { stopped = true; generation++; clearInterval(timer); unsubscribe(); };
}
