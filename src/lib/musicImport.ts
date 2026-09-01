import { get } from 'svelte/store';
import { searchSoundCloud } from './api';
import { likedTracks, playlists, settings } from './stores';
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
  origin: 'spotify' | 'file';
  originUrl?: string;
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
}

export function normalizeImportText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('ru-RU')
    .replace(/\b(feat|ft)\.?\b/g, ' ')
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .trim();
}

function tokenSimilarity(left: string, right: string): number {
  const a = new Set(normalizeImportText(left).split(' ').filter(Boolean));
  const b = new Set(normalizeImportText(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap++;
  return (2 * overlap) / (a.size + b.size);
}

function scoreCandidate(seed: MusicImportSeed, candidate: any): number {
  const seedTitle = normalizeImportText(seed.title);
  const candidateTitle = normalizeImportText(String(candidate?.title || ''));
  let titleScore = tokenSimilarity(seedTitle, candidateTitle) * 50;
  if (seedTitle === candidateTitle) titleScore = 55;
  else if (seedTitle.includes(candidateTitle) || candidateTitle.includes(seedTitle)) {
    titleScore = Math.max(titleScore, 40);
  }

  const expectedArtists = seed.artists.map(normalizeImportText).filter(Boolean);
  const actualArtists = (candidate?.artists?.length ? candidate.artists : [candidate?.artist])
    .map((artist: unknown) => normalizeImportText(String(artist || '')))
    .filter(Boolean);
  let artistScore = 0;
  for (const expected of expectedArtists) {
    for (const actual of actualArtists) {
      if (expected === actual) artistScore = Math.max(artistScore, 35);
      else if (expected.includes(actual) || actual.includes(expected)) artistScore = Math.max(artistScore, 27);
      else artistScore = Math.max(artistScore, tokenSimilarity(expected, actual) * 30);
    }
  }

  const duration = Number(candidate?.duration) || 0;
  const difference = duration && seed.durationMs
    ? Math.abs(duration - seed.durationMs)
    : Number.POSITIVE_INFINITY;
  const durationScore = difference <= 3000 ? 15 : difference <= 9000 ? 8 : 0;
  if (titleScore < 35 || artistScore < 12) return 0;
  return titleScore + artistScore + durationScore;
}

function bestMatch(seed: MusicImportSeed, candidates: any[]): any | null {
  let best: any | null = null;
  let score = 0;
  for (const candidate of candidates) {
    const candidateScore = scoreCandidate(seed, candidate);
    if (candidateScore > score) {
      best = candidate;
      score = candidateScore;
    }
  }
  return score >= 65 ? best : null;
}

function decorateMatch(match: any, collection: MusicImportCollection, seed: MusicImportSeed) {
  const imported = {
    ...match,
    importedFrom: collection.origin,
    importSourceId: seed.id,
    importSourceUrl: seed.externalUrl
  };
  if (collection.origin === 'spotify') {
    imported.spotifyId = seed.id;
    imported.spotifyUrl = seed.externalUrl;
  }
  return imported;
}

async function matchTrack(
  seed: MusicImportSeed,
  collection: MusicImportCollection,
  signal?: AbortSignal
): Promise<any | null> {
  if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
  const query = `${seed.artists[0] || ''} ${seed.title}`.trim();
  const yandexToken = get(settings).yandexToken;
  if (yandexToken) {
    try {
      const candidates = await searchYandex(yandexToken, query, 8);
      const match = bestMatch(seed, candidates);
      if (match) return decorateMatch(match, collection, seed);
    } catch (error) {
      console.warn('[music-import] Yandex match failed', error);
    }
  }

  if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
  try {
    const candidates = await searchSoundCloud(query, 10);
    const match = bestMatch(seed, candidates);
    return match ? decorateMatch(match, collection, seed) : null;
  } catch (error) {
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
    const cacheKey = `${normalizeImportText(`${track.artists[0] || ''} ${track.title}`)}:${Math.round(track.durationMs / 3000)}`;
    let pending = cache.get(cacheKey);
    if (!pending) {
      pending = matchTrack(track, collection, signal);
      cache.set(cacheKey, pending);
    }
    const result = await pending;
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
      currentTrack: `${track.artists[0] || 'Неизвестный артист'} — ${track.title}`
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
      const additions = likedMatches.filter((track) => !existing.some((known) => sameLocalTrack(known, track)));
      likedAdded = additions.length;
      return [...additions, ...existing];
    });
  }

  const playlistCollections = indexed.filter(({ collection }) => collection.kind === 'playlist');
  playlists.update((existing) => {
    const next = [...existing];
    for (const { collection, key } of playlistCollections) {
      const id = `${collection.origin}:${collection.id}`;
      const importedTracks = matches.get(key)?.filter(Boolean) || [];
      const index = next.findIndex((playlist) => playlist.id === id);
      const currentTracks = index >= 0 ? next[index]?.tracks || [] : [];
      const value = {
        ...(index >= 0 ? next[index] : {}),
        id,
        title: collection.name,
        tracks: uniqueTracks([...importedTracks, ...currentTracks]),
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

  const result = {
    total: work.length,
    matched,
    skipped,
    likedAdded,
    playlistsImported: playlistCollections.length
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
