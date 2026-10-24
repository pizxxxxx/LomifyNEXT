import { get } from 'svelte/store';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { settings, listenStats, likedTracks, dislikedTracks, playlists, playlistsReady, flushPlaylistStorage, flushListenStats, searchHistory, equalizerBands, activeEqualizerPreset, equalizerProfiles, equalizerSaveError, globalVolume, isPlaying } from './stores';
import { publicSettings, settingsSecretsRemoved, whenSecretsReady } from './secretStorage';
import { achievementUnlocks, suspendAchievements, ACHIEVEMENTS_KEY } from './achievements';
import { normalizeAchievementUnlocks } from './achievementsCore';
import { getTracks, replaceTracks } from './db';
import { normalizeEqualizerState } from './equalizer';
import { APP_VERSION } from './version';
import { createLomiBackup, parseLomiBackup, LOMI_MAX_BYTES, type LomiBackup } from './lomiBackupCore';
let restoring = false;
export function backupRestoreInProgress() { return restoring; }
export async function captureLomiBackup(): Promise<LomiBackup> {
  await Promise.all([playlistsReady, whenSecretsReady()]);
  return createLomiBackup({ settings: get(settings), stats: get(listenStats), likes: get(likedTracks), dislikes: get(dislikedTracks),
    playlists: get(playlists), localTracks: await getTracks(), achievements: get(achievementUnlocks), searchHistory: get(searchHistory),
    volume: get(globalVolume), followedArtists: get(settings).followedArtists, equalizer: { bands: get(equalizerBands), preset: get(activeEqualizerPreset), profiles: get(equalizerProfiles) } }, APP_VERSION);
}
export async function saveLomiBackup(backup: LomiBackup, recovery = false): Promise<boolean> {
  const content = JSON.stringify(backup);
  if (new TextEncoder().encode(content).byteLength > LOMI_MAX_BYTES) throw new Error('Копия больше 64 МБ. Уменьши размер своих обложек или число плейлистов.');
  const name = `Lomify-${recovery ? 'до-восстановления-' : ''}${new Date().toISOString().slice(0, 10)}.lomi`;
  if (isTauri()) {
    return invoke<boolean>('save_lomi_backup', { content, recovery });
  } else {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  return true;
}
export async function restoreLomiBackup(backup: LomiBackup): Promise<void> {
  if (restoring) throw new Error('Восстановление уже выполняется.');
  restoring = true;
  let before: Awaited<ReturnType<typeof snapshot>> | null = null;
  const originalSettings = { ...get(settings) };
  let paused = false;
  let oldStorage = new Map<string, string | null>();
  const keys = ['lomifynext_settings', 'lomifynext_stats', 'lomifynext_likes', 'lomifynext_dislikes', 'lomifynext_search_history', 'lomifynext_equalizer', ACHIEVEMENTS_KEY];
  try {
    const data = parseLomiBackup(JSON.stringify(backup)).data;
    await Promise.all([playlistsReady, whenSecretsReady()]);
    if (!settingsSecretsRemoved()) throw new Error('Сначала заверши перенос подключений в системное хранилище. Данные не изменены.');
    await flushPlaylistStorage();
    settings.update(value => ({ ...value, syncPlatformsLikes: false, syncYandexPlaylists: false, syncSoundCloudPlaylists: false }));
    paused = true;
    const [{ settleLikesSync }, { settlePlaylistSync }] = await Promise.all([import('./likes'), import('./playlistSync')]);
    await Promise.all([settleLikesSync(), settlePlaylistSync()]);
    await flushPlaylistStorage();
    before = await snapshot();
    oldStorage = new Map(keys.map(key => [key, localStorage.getItem(key)]));
    oldStorage.set('lomifynext_settings', JSON.stringify(publicSettings(originalSettings)));
    isPlaying.set(false);
    suspendAchievements(true);
    const nextSettings = { ...originalSettings, ...data.settings, followedArtists: data.followedArtists, syncPlatformsLikes: false, syncYandexPlaylists: false, syncSoundCloudPlaylists: false } as typeof originalSettings;
    const eq = normalizeEqualizerState(data.equalizer);
    // Fail on quota/access errors before publishing replacement stores. IndexedDB
    // and localStorage have separate transactions; retain exact originals for rollback.
    for (const [key, value] of [
      ['lomifynext_settings', publicSettings(nextSettings)], ['lomifynext_stats', data.stats],
      ['lomifynext_likes', data.likes], ['lomifynext_dislikes', data.dislikes],
      ['lomifynext_search_history', data.searchHistory], ['lomifynext_equalizer', eq],
      [ACHIEVEMENTS_KEY, normalizeAchievementUnlocks(data.achievements)]
    ] as const) localStorage.setItem(key, JSON.stringify(value));
    // Persist IndexedDB changes before publishing the replacement library to the UI.
    await replaceTracks(data.localTracks);
    playlists.set(data.playlists); await flushPlaylistStorage();
    likedTracks.set(data.likes); dislikedTracks.set(data.dislikes); listenStats.set(data.stats); flushListenStats();
    searchHistory.set(data.searchHistory);
    equalizerProfiles.set(eq.profiles); equalizerBands.set(eq.bands); activeEqualizerPreset.set(eq.preset);
    if (get(equalizerSaveError)) throw new Error('Не удалось записать настройки звука.');
    achievementUnlocks.set(normalizeAchievementUnlocks(data.achievements));
    localStorage.setItem(ACHIEVEMENTS_KEY, JSON.stringify(get(achievementUnlocks)));
    globalVolume.set(data.volume);
    settings.set(nextSettings);
    localStorage.setItem('lomifynext_settings', JSON.stringify(publicSettings(get(settings))));
    window.dispatchEvent(new Event('lomify:library-restored'));
  } catch (error) {
    if (before) {
      // Keep the original in-memory objects/account links, even when disk is full.
      try {
        playlists.set(before.playlists); await flushPlaylistStorage();
        await replaceTracks(before.localTracks);
        likedTracks.set(before.likes); dislikedTracks.set(before.dislikes);
        listenStats.set(before.stats); flushListenStats(); searchHistory.set(before.searchHistory);
        equalizerProfiles.set(before.equalizer.profiles); equalizerBands.set(before.equalizer.bands); activeEqualizerPreset.set(before.equalizer.preset);
        achievementUnlocks.set(before.achievements); globalVolume.set(before.volume);
        settings.set(originalSettings!);
        for (const [key, value] of oldStorage) value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
      } catch { throw new Error('Восстановление прервано из-за ошибки хранилища. Текущие данные есть в сохранённом перед восстановлением файле .lomi. Освободи место и загрузи его.'); }
    } else if (paused) settings.set(originalSettings);
    throw error;
  } finally { suspendAchievements(false); restoring = false; }
}
async function snapshot() {
  return { playlists: get(playlists), localTracks: await getTracks(), likes: get(likedTracks), dislikes: get(dislikedTracks),
    stats: get(listenStats), searchHistory: get(searchHistory), achievements: get(achievementUnlocks), volume: get(globalVolume),
    equalizer: { profiles: get(equalizerProfiles), bands: get(equalizerBands), preset: get(activeEqualizerPreset) } };
}
