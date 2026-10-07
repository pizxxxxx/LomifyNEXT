import { writable, get } from 'svelte/store';
import { currentTrack, isPlaying, queue, trackHistory, dislikedTracks, notify } from './stores';
import { isTrackDisliked } from './dislikes';

// Shared with the existing Player. Style switches do not remount the audio controller.
export const playbackShuffle = writable(false);
export const playbackRepeat = writable(0);
export const glassSidebarOpen = writable(true);
export const glassQueueOpen = writable(true);
export const glassPanelMode = writable<'queue' | 'lyrics' | 'support'>('queue');
export const glassScreenSettings = writable({ open: false, motion: true });
// Live drag state stays in memory; the final width is persisted on pointer release.
export const glassPanelDragWidth = writable<number | null>(null);
export function showGlassLyrics() {
  glassPanelMode.set('lyrics');
  glassQueueOpen.set(true);
}
export function toggleGlassQueue() {
  if (get(glassQueueOpen) && get(glassPanelMode) === 'queue') glassQueueOpen.set(false);
  else { glassPanelMode.set('queue'); glassQueueOpen.set(true); }
}
export const glassLibraryRequest = writable<{ playlistId?: string; create?: boolean } | null>(null);
export const sleepDeadline = writable<number | null>(null);
export const glassQueueContext = writable<{ title: string; cover: string; total: number; trackKeys: string[] } | null>(null);
const trackKey = (track: any) => `${track.source}:${track.id || `${track.artist}:${track.title}`}`;
export function setGlassQueueContext(title: string, cover: string, tracks: any[]) {
  glassQueueContext.set({ title, cover, total: tracks.length, trackKeys: tracks.map(trackKey) });
}
currentTrack.subscribe(track => {
  const context = get(glassQueueContext);
  if (context && (!track || !context.trackKeys.includes(trackKey(track)))) glassQueueContext.set(null);
});

export function playQueueItem(index: number) {
  const items = get(queue);
  const track = items[index];
  if (!track || isTrackDisliked(get(dislikedTracks), track)) return;
  const playing = get(currentTrack);
  if (playing) trackHistory.update(history => [...history, playing]);
  queue.set(items.slice(index + 1));
  currentTrack.set(track);
  isPlaying.set(true);
}

/** One timer owned by Player, checked on resume to handle a suspended Windows session. */
export function startSleepTimer(): () => void {
  const check = () => {
    const deadline = get(sleepDeadline);
    if (deadline !== null && Date.now() >= deadline) {
      sleepDeadline.set(null);
      isPlaying.set(false);
      notify('Таймер сна остановил музыку.', 'info');
    }
  };
  const interval = setInterval(check, 1000);
  const unsubscribe = sleepDeadline.subscribe(check);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  return () => { clearInterval(interval); unsubscribe(); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
}
