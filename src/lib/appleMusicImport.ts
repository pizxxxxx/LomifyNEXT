import { safeFetch } from './api';
import { APPLE_MUSIC_MAX_PAGE_CHARS, parseAppleMusicPlaylistPage, parseAppleMusicPlaylistUrl } from './appleMusicImportCore';
import type { MusicImportCollection } from './musicImport';

export async function loadAppleMusicPlaylist(input: string, signal?: AbortSignal): Promise<MusicImportCollection> {
  const requested = parseAppleMusicPlaylistUrl(input);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, 20_000);
  try {
    const response = await safeFetch(requested.url, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok) throw new Error('Apple Music не открыл плейлист. Проверь публичный доступ и ссылку или выбери XML-файл.');
    if (response.url && parseAppleMusicPlaylistUrl(response.url).id !== requested.id) throw new Error('Apple перенаправил на другую страницу. Скопируй ссылку на плейлист ещё раз.');
    if (Number(response.headers.get('content-length')) > APPLE_MUSIC_MAX_PAGE_CHARS) throw new Error('Страница слишком большая. Используй XML-файл плейлиста.');
    const html = await response.text();
    if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    return parseAppleMusicPlaylistPage(html, requested.url);
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
    if (controller.signal.aborted) throw new Error('Apple Music не ответил за 20 секунд. Повтори попытку или выбери XML-файл.');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
