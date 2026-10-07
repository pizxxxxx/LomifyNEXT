import { get, writable } from 'svelte/store';
import { currentTrack, queue, isPlaying, playlists, notify, flushPlaylistStorage, settings } from './stores';
import { stopWave } from './wave';
import { whenSecretsReady } from './secretStorage';
import { mixHash, type DailyMix, type DailyMixSource } from './dailyMixesCore';

export interface DailyMixSelection { mix: DailyMix; source: DailyMixSource; account: string; id: string; shared?: boolean; sharedTrack?: boolean }
export const activeDailyMix = writable<DailyMixSelection | null>(null);
export const playingDailyMix = writable('');
export const savingDailyMix = writable('');
export const mixCountLabel = (count: number) => `${count} ${count % 10 === 1 && count % 100 !== 11 ? 'трек' : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 12 || count % 100 > 14) ? 'трека' : 'треков'}`;
export function mixSelection(mix: DailyMix, source: DailyMixSource, account: string): DailyMixSelection {
  return { mix, source, account, id: `${source}:${account}:${mix.kind}:${mix.day}` };
}
export function savedMixId(selection: DailyMixSelection): string {
  if (selection.shared) return selection.id.replaceAll(':', '_');
  return `daily_${selection.mix.kind === 'favorites' ? 'foryou' : selection.mix.kind}_${selection.mix.day}_${mixHash(`${selection.source}:${selection.account}`).toString(36)}`;
}
export async function playDailyMix(selection: DailyMixSelection, index = 0, toggle = false) {
  const track = selection.mix.tracks[index];
  if (!track) return;
  if (toggle) { isPlaying.update(value => !value); return; }
  await whenSecretsReady();
  if (selection.source === 'yandex' && !get(settings).yandexToken) {
    notify('Для этой музыки подключи Яндекс Музыку в Настройках, в разделе музыкальных сервисов.', 'info');
    return;
  }
  stopWave();
  playingDailyMix.set(selection.id);
  queue.set(selection.mix.tracks.slice(index + 1));
  currentTrack.set(track);
  isPlaying.set(true);
}
export async function saveDailyMix(selection: DailyMixSelection) {
  if (get(savingDailyMix) || !selection.mix.tracks.length) return;
  const id = savedMixId(selection);
  if (get(playlists).some(playlist => playlist.id === id)) { notify('Эта подборка уже в медиатеке.', 'info'); return; }
  savingDailyMix.set(selection.id);
  try {
    const date = new Date(`${selection.mix.day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    playlists.update(value => [...value, { id, title: `${selection.mix.title} - ${date}`, tracks: selection.mix.tracks.map(track => ({ ...track })), coverUrl: selection.mix.tracks[0].coverUrl, createdAt: Date.now() }]);
    await flushPlaylistStorage();
    notify('Подборка сохранена в медиатеку.', 'success');
  } catch {
    playlists.update(value => value.filter(playlist => playlist.id !== id));
    notify('Не удалось сохранить подборку. Повтори сохранение.', 'error');
  } finally { savingDailyMix.set(''); }
}
