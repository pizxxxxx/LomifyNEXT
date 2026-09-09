/**
 * Дизлайки (скрытые треки): единая точка правды и синхронизация.
 *
 * Трек с отметкой «не рекомендовать»:
 *   1. Больше не попадается в «Моей волне» (фильтруется при получении порций станции).
 *   2. Исключается из очередей и автогенерации похожих треков.
 *   3. Исключается из рекомендаций на главной странице.
 *   4. Для треков из Яндекс Музыки отметка отправляется в аккаунт через API (/dislikes/tracks).
 *   5. Если трек был в «Любимых» (лайках), лайк снимается, так как эти состояния взаимоисключающие.
 */

import { get } from 'svelte/store';
import { dislikedTracks, likedTracks, queue, settings } from './stores';
import { setTrackLiked } from './likes';
import { yandexSetDislikes } from './yandex';

function trackId(track: any): string | null {
  const id = `${track?.id ?? ''}`.trim();
  return id ? id : null;
}

/**
 * Проверка совпадения треков: по названию и исполнителю, либо по id при совпадении источника.
 */
export function sameTrack(a: any, b: any): boolean {
  if (!a || !b) return false;
  if (a.title && b.title && a.artist && b.artist) {
    if (
      a.title.trim().toLowerCase() === b.title.trim().toLowerCase() &&
      a.artist.trim().toLowerCase() === b.artist.trim().toLowerCase()
    ) {
      return true;
    }
  }
  const idA = trackId(a);
  const idB = trackId(b);
  if (idA && idB && idA === idB) {
    if (a.source && b.source && a.source === b.source) return true;
    if (!a.source || !b.source) return true;
  }
  return false;
}

/**
 * Проверяет, скрыт ли трек (поставлен ли дизлайк).
 */
export function isTrackDisliked(list: any[], track: any): boolean {
  if (!track || !Array.isArray(list) || list.length === 0) return false;
  return list.some((t) => sameTrack(t, track));
}

/**
 * Поставить или снять дизлайк (скрыть или вернуть трек).
 */
export async function setTrackDisliked(track: any, disliked: boolean): Promise<void> {
  if (!track) return;
  const list = get(dislikedTracks);
  const exists = list.some((t) => sameTrack(t, track));

  if (disliked) {
    if (!exists) {
      dislikedTracks.set([track, ...list]);
    }
    // Если трек был в любимых — снимаем лайк
    if (get(likedTracks).some((t) => sameTrack(t, track))) {
      setTrackLiked(track, false);
    }
    // Удаляем все вхождения трека из текущей очереди
    const currentQueue = get(queue);
    const filteredQueue = currentQueue.filter((t) => !sameTrack(t, track));
    if (filteredQueue.length !== currentQueue.length) {
      queue.set(filteredQueue);
    }
  } else {
    if (exists) {
      dislikedTracks.set(list.filter((t) => !sameTrack(t, track)));
    }
  }

  // Синхронизация с аккаунтом Яндекс Музыки
  const token = get(settings).yandexToken;
  const id = trackId(track);
  if (token && id && (track.source === 'yandex' || track.service === 'yandex' || !track.source)) {
    try {
      await yandexSetDislikes(token, [id], disliked);
    } catch (e) {
      console.warn('[dislikes] Яндекс не принял отметку скрытия', e);
    }
  }
}

/**
 * Переключить статус скрытия трека. Возвращает новое состояние.
 */
export async function toggleTrackDislike(track: any): Promise<boolean> {
  const currentDisliked = isTrackDisliked(get(dislikedTracks), track);
  const next = !currentDisliked;
  await setTrackDisliked(track, next);
  return next;
}

/**
 * Очистить весь список скрытых треков.
 */
export function clearAllDislikes(): void {
  dislikedTracks.set([]);
}
