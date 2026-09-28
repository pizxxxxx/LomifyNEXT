import { flushPlaylistStorage, playlists, playlistsReady } from '$lib/stores';
import { dedupePlaylists, playlistIdentity } from '$lib/playlistStorage';
import { importSoundCloudPlaylistByUrl } from '$lib/api';
import { importYandexPlaylistByUrl } from '$lib/yandex';

export async function importLinkedPlaylist(urlText: string, yandexToken: string) {
  let url: URL;
  try { url = new URL(urlText.trim()); } catch { throw new Error('Вставь полную ссылку на плейлист.'); }
  if (url.protocol !== 'https:') throw new Error('Ссылка на плейлист должна начинаться с https://.');
  if (['music.yandex.ru', 'music.yandex.com'].includes(url.hostname)) {
    return importYandexPlaylistByUrl(yandexToken, url.href);
  }
  if (url.hostname === 'soundcloud.com' || url.hostname.endsWith('.soundcloud.com')) {
    return importSoundCloudPlaylistByUrl(url.href);
  }
  throw new Error('Поддерживаются ссылки на плейлисты SoundCloud и Яндекс Музыки.');
}

export async function saveImportedPlaylists(imported: any[]): Promise<void> {
  await playlistsReady;
  playlists.update(existing => {
    const updated = dedupePlaylists(existing);
    let newCount = 0;
    for (const playlist of imported) {
      const key = playlistIdentity(playlist);
      const index = key ? updated.findIndex(item => playlistIdentity(item) === key) : -1;
      if (index >= 0) {
        const customCoverUrl = updated[index].customCoverUrl;
        updated[index] = customCoverUrl ? { ...playlist, customCoverUrl } : playlist;
      }
      else updated.splice(newCount++, 0, playlist);
    }
    return dedupePlaylists(updated);
  });
  await flushPlaylistStorage();
}
