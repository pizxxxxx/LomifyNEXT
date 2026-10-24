import { derived, get, writable } from 'svelte/store';
import { listenStats, likedTracks, playlists, playlistsReady, notify } from './stores';
import { achievementFacts, achievementProgress, normalizeAchievementUnlocks, type AchievementUnlocks } from './achievementsCore';
export const ACHIEVEMENTS_KEY = 'lomifynext_achievements';
export const achievementUnlocks = writable<AchievementUnlocks>({});
export const achievements = derived([listenStats, likedTracks, playlists, achievementUnlocks], ([stats, likes, lists, unlocked]) => achievementProgress(achievementFacts(stats, likes, lists), unlocked));
let started = false;
let suspended = false;
export function suspendAchievements(value: boolean) {
  suspended = value;
  if (!value) achievementUnlocks.update(current => ({ ...current }));
}
export function startAchievements() {
  if (started) return () => {};
  started = true;
  try { achievementUnlocks.set(normalizeAchievementUnlocks(JSON.parse(localStorage.getItem(ACHIEVEMENTS_KEY) || '{}'))); } catch { /* Local progress remains available. */ }
  let initial = true;
  void playlistsReady.then(() => { initial = false; });
  let storageWarning = false;
  const save = achievementUnlocks.subscribe(value => {
    try { localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(value)); }
    catch { if (!storageWarning) { storageWarning = true; notify('Не удалось сохранить достижения. Проверь свободное место.', 'error'); } }
  });
  const check = achievements.subscribe(items => {
    if (suspended) return;
    const earned = items.filter(item => !item.unlocked && item.value >= item.goal);
    if (earned.length) {
      const next = { ...get(achievementUnlocks) };
      for (const item of earned) next[item.id] = Date.now();
      achievementUnlocks.set(next);
      if (!initial) notify(earned.length === 1 ? `Достижение открыто: ${earned[0].title}` : `Открыто достижений: ${earned.length}`, 'success');
    }
  });
  return () => { check(); save(); started = false; };
}
