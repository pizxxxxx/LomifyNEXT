import { get } from 'svelte/store';
import { searchSoundCloud } from './api';
import { flushPlaylistStorage, likedTracks, playlists, playlistsReady, settings } from './stores';
import { whenSecretsReady } from './secretStorage';
import { bestImportMatch, normalizeImportText } from './musicImportMatching';
export { normalizeImportText } from './musicImportMatching';
import { searchYandex } from './yandex';

export interface MusicImportSeed {
  id: string;
  title: string;
  artists: string[];
  durationMs: number;
  externalUrl: string;
}

export interface MusicImportCollection {
  id: string;
  kind: 'liked' | 'playlist';
  name: string;
  origin: 'spotify' | 'file' | 'apple-music';
  originUrl?: string;
  sourceSkipped?: number;
  tracks: MusicImportSeed[];
}

export interface MusicImportProgress {
  phase: 'fetching' | 'matching' | 'saving' | 'done';
  total: number;
  current: number;
  matched: number;
  skipped: number;
  currentTrack: string;
}

export interface MusicImportResult {
  total: number;
  matched: number;
  skipped: number;
  likedAdded: number;
  playlistsImported: number;
  unmatched: MusicImportSeed[];
}

function decorateMatch(match: any, collection: MusicImportCollection, seed: MusicImportSeed) {
  const imported: any = {
    ...match,
    importedFrom: collection.origin,
    importSourceId: seed.id,
    importSourceUrl: seed.externalUrl
  };
  if (collection.origin === 'apple-music') {
    imported.appleMusicId = seed.id;
    imported.appleMusicUrl = seed.externalUrl;
  }
  if (collection.origin === 'spotify') {
    imported.spotifyId = seed.id;
    imported.spotifyUrl = seed.externalUrl;
  }
  return imported;
}

async function importRequest<T>(request: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(new DOMException('Запрос импорта отменён или не ответил', 'AbortError'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, 20_000);
  try { return await Promise.race([request(controller.signal), aborted]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', rejectAbort); }
}

async function matchTrack(
  seed: MusicImportSeed,
  signal?: AbortSignal
): Promise<any | null> {
  if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
  const query = `${seed.artists[0] || ''} ${seed.title}`.trim();
  const yandexToken = get(settings).yandexToken;
  if (yandexToken) {
    try {
      const candidates = await importRequest(requestSignal => searchYandex(yandexToken, query, 8, 0, requestSignal), signal);
      const match = bestImportMatch(seed, candidates);
      if (match) return match;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
      console.warn('[music-import] Yandex match failed', error);
    }
  }

  if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
  try {
    const candidates = await importRequest(requestSignal => searchSoundCloud(query, 10, true, requestSignal), signal);
    const match = bestImportMatch(seed, candidates);
    return match;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
    console.warn('[music-import] SoundCloud match failed', error);
    return null;
  }
}

function sameLocalTrack(left: any, right: any): boolean {
  if (left?.source && right?.source && left?.id != null && right?.id != null) {
    return left.source === right.source && String(left.id) === String(right.id);
  }
  return normalizeImportText(`${left?.artist} ${left?.title}`) ===
    normalizeImportText(`${right?.artist} ${right?.title}`);
}

function uniqueTracks(tracks: any[]): any[] {
  const result: any[] = [];
  for (const track of tracks) {
    if (!result.some((known) => sameLocalTrack(known, track))) result.push(track);
  }
  return result;
}

async function concurrent<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const run = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

export async function importMusicCollections(
  collections: MusicImportCollection[],
  onProgress: (progress: MusicImportProgress) => void,
  signal?: AbortSignal
): Promise<MusicImportResult> {
  if (!collections.length) throw new Error('В выбранных данных нет треков для импорта');
  await playlistsReady;
  await whenSecretsReady();
  if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');

  const indexed = collections.map((collection, index) => ({
    collection,
    key: `${index}:${collection.origin}:${collection.id}`
  }));
  const work = indexed.flatMap(({ collection, key }) =>
    collection.tracks.map((track, index) => ({ collection, key, track, index }))
  );
  if (!work.length) throw new Error('В выбранных данных нет треков для импорта');

  const matches = new Map<string, Array<any | null>>();
  for (const { collection, key } of indexed) {
    matches.set(key, Array(collection.tracks.length).fill(null));
  }

  const cache = new Map<string, Promise<any | null>>();
  let current = 0;
  let matched = 0;
  let skipped = 0;
  onProgress({ phase: 'matching', total: work.length, current, matched, skipped, currentTrack: '' });

  await concurrent(work, 3, async ({ collection, key, track, index }) => {
    if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
    const cacheKey = JSON.stringify([track.artists.map(normalizeImportText), normalizeImportText(track.title), track.durationMs]);
    let pending = cache.get(cacheKey);
    if (!pending) {
      pending = matchTrack(track, signal);
      cache.set(cacheKey, pending);
    }
    const match = await pending;
    const result = match ? decorateMatch(match, collection, track) : null;
    if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
    matches.get(key)![index] = result;
    current++;
    if (result) matched++;
    else skipped++;
    onProgress({
      phase: 'matching',
      total: work.length,
      current,
      matched,
      skipped,
      currentTrack: `${track.artists[0] || 'Неизвестный артист'} - ${track.title}`
    });
  });

  if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
  onProgress({
    phase: 'saving',
    total: work.length,
    current,
    matched,
    skipped,
    currentTrack: 'Сохраняю медиатеку…'
  });

  let likedAdded = 0;
  const likedMatches = indexed
    .filter(({ collection }) => collection.kind === 'liked')
    .flatMap(({ key }) => matches.get(key)?.filter(Boolean) || []);
  if (likedMatches.length) {
    likedTracks.update((existing) => {
      const additions = uniqueTracks(likedMatches).filter((track) => !existing.some((known) => sameLocalTrack(known, track)));
      likedAdded = additions.length;
      return [...additions, ...existing];
    });
  }

  const playlistCollections = indexed.filter(({ collection }) => collection.kind === 'playlist');
  let playlistsImported = 0;
  playlists.update((existing) => {
    const next = [...existing];
    for (const { collection, key } of playlistCollections) {
      const id = `${collection.origin}:${collection.id}`;
      const importedTracks = matches.get(key)?.filter(Boolean) || [];
      if (!importedTracks.length) continue;
      playlistsImported++;
      const index = next.findIndex((playlist) => playlist.id === id);
      const currentTracks = index >= 0 ? next[index]?.tracks || [] : [];
      const value = {
        ...(index >= 0 ? next[index] : {}),
        id,
        title: collection.name,
        tracks: [...importedTracks, ...currentTracks.filter((track: any) => !importedTracks.some(imported => sameLocalTrack(track, imported)))],
        origin: collection.origin,
        originId: collection.id,
        originUrl: collection.originUrl || '',
        importedAt: Date.now()
      };
      if (index >= 0) next[index] = value;
      else next.push(value);
    }
    return next;
  });

  if (playlistsImported) await flushPlaylistStorage();

  const unmatched = work.filter(({ key, index }) => !matches.get(key)?.[index]).map(({ track }) => track);
  const result = {
    total: work.length,
    matched,
    skipped,
    likedAdded,
    playlistsImported,
    unmatched
  };
  onProgress({
    phase: 'done',
    total: work.length,
    current: work.length,
    matched,
    skipped,
    currentTrack: ''
  });
  return result;
}
