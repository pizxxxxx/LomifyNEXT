import { writable } from 'svelte/store';
import { sanitizeWaveHistory, waveHistoryEntry, WAVE_HISTORY_LIMIT, type WaveHistoryEntry } from './waveHistoryCore';
const KEY = 'lomifynext_wave_history';
let initial: WaveHistoryEntry[] = [];
if (typeof localStorage !== 'undefined') {
  try { initial = sanitizeWaveHistory(JSON.parse(localStorage.getItem(KEY) || '[]')); } catch { /* A damaged history starts empty. */ }
}
export const waveListeningHistory = writable(initial);
if (typeof localStorage !== 'undefined') waveListeningHistory.subscribe(entries => {
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch { /* Playback remains usable when storage is full. */ }
});
export function recordWaveListen(track: any, playedAt = Date.now()) {
  const entry = waveHistoryEntry(track, playedAt);
  if (entry) waveListeningHistory.update(entries => [entry, ...entries].slice(0, WAVE_HISTORY_LIMIT));
}
