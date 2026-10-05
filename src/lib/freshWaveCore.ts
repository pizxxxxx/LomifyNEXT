export type WaveSource = 'soundcloud' | 'yandex';
export interface WaveTasteInput {
  source: WaveSource; likes: any[]; history: Record<string, any>; disliked: any[]; now?: number;
}
export interface FreshWavePlan {
  recent: any[]; stable: any[]; exploration: number; windowDays: number;
}
const DAY = 86400000;
export const waveSongKey = (track: any) => `${track?.artist || ''}\0${track?.title || ''}`.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
export const waveTrackKey = (track: any) => `${track?.source}:${track?.id}`;
const artistKey = (track: any) => `${track?.artist || ''}`.toLocaleLowerCase('ru').trim();
const timestamp = (raw: unknown, now: number) => Number.isFinite(Number(raw)) && Number(raw) > 0 && Number(raw) <= now ? Number(raw) : 0;
export function realLikeTimestamp(raw: unknown, now = Date.now()): number {
  return timestamp(typeof raw === 'string' && !/^\d+$/.test(raw) ? Date.parse(raw) : raw, now);
}

/** Dates belong to real likes/qualified plays; an imported library is never dated today. */
export function createFreshWavePlan(input: WaveTasteInput, random = Math.random): FreshWavePlan {
  const now = input.now ?? Date.now();
  const blocked = new Set(input.disliked.flatMap(track => [waveTrackKey(track), waveSongKey(track)]));
  const candidates = new Map<string, { track: any; at: number; likedAt: number; playedAt: number; weight: number }>();
  const add = (track: any, likedAt = 0, playedAt = 0, weight = 1) => {
    if (!track?.id || track.source !== input.source || track.isBanned || track.isUnavailable || track.isLocal || blocked.has(waveTrackKey(track)) || blocked.has(waveSongKey(track))) return;
    const old = candidates.get(waveTrackKey(track));
    candidates.set(waveTrackKey(track), { track, at: Math.max(likedAt, playedAt, old?.at || 0), likedAt: Math.max(likedAt, old?.likedAt || 0), playedAt: Math.max(playedAt, old?.playedAt || 0), weight: Math.max(weight, old?.weight || 0) });
  };
  input.likes.forEach((track, index) => add(track, timestamp(track.likedAt, now), 0, 1 + 1 / (1 + index / 20)));
  for (const entry of Object.values(input.history || {})) add(entry, 0, timestamp(entry.lastPlayedAt, now), 2 + Math.min(2, Math.log1p(Number(entry.count) || 0)));
  const all = [...candidates.values()];
  let windowDays = 14;
  let recent = all.filter(item => item.likedAt >= now - 7 * DAY || item.playedAt >= now - 14 * DAY);
  let exploration = .1;
  if (!recent.length) {
    windowDays = 28; exploration = .2;
    recent = all.filter(item => item.at >= now - 28 * DAY);
  }
  if (!recent.length) {
    windowDays = 0; exploration = .3;
    // No current signals: keep the most recent known preferences and broaden gently.
    // Undated imports stay in the stable group, without invented week timestamps.
    recent = [...all].filter(item => item.at > 0).sort((a, b) => b.at - a.at).slice(0, 12);
  }
  const recentIds = new Set(recent.map(item => waveTrackKey(item.track)));
  const sample = (pool: typeof all, count: number) => {
    const ordered = pool.map(item => ({ item, rank: -Math.log(Math.max(Number.EPSILON, random())) / item.weight })).sort((a, b) => a.rank - b.rank);
    const artists = new Set<string>(), selected: any[] = [];
    for (const { item } of ordered) {
      if (artists.has(artistKey(item.track))) continue;
      artists.add(artistKey(item.track)); selected.push(item.track);
      if (selected.length >= count) break;
    }
    return selected;
  };
  const stable = all.filter(item => !recentIds.has(waveTrackKey(item.track)));
  return { recent: sample(recent, 3), stable: sample(stable.length ? stable : all, 2), exploration, windowDays };
}

/** Target 70/20/10, widening discovery only when no recent activity exists. */
export function assembleFreshWave(
  pools: { recent: any[]; stable: any[]; discover: any[] }, input: WaveTasteInput,
  exploration = .1, seen: ReadonlySet<string> = new Set(), skipped: ReadonlyMap<string, number> = new Map(), limit = 20, random = Math.random
): any[] {
  const blocked = new Set([...input.likes, ...input.disliked].flatMap(track => [waveTrackKey(track), waveSongKey(track)]));
  const filter = (pool: any[]) => pool.filter(track => track?.id && track.source === input.source && !track.isBanned && !track.isUnavailable && !track.isLocal && !blocked.has(waveTrackKey(track)) && !blocked.has(waveSongKey(track)) && !seen.has(waveTrackKey(track)) && (skipped.get(artistKey(track)) || 0) < 2)
    .map(track => ({ track, order: random() })).sort((a, b) => a.order - b.order).map(item => item.track);
  const lists = { recent: filter(pools.recent), stable: filter(pools.stable), discover: filter(pools.discover) };
  const targets = { recent: limit - Math.round(limit * .2) - Math.round(limit * exploration), stable: Math.round(limit * .2), discover: Math.round(limit * exploration) };
  const counts = { recent: 0, stable: 0, discover: 0 }, artists = new Map<string, number>(), ids = new Set<string>(), songs = new Set<string>(), output: any[] = [];
  const kinds = ['recent', 'stable', 'discover'] as const;
  const take = (kind: typeof kinds[number], allowAdjacent = false) => {
    let index = -1, leastUsed = Infinity;
    lists[kind].forEach((track, candidate) => {
      const used = artists.get(artistKey(track)) || 0;
      if (!ids.has(waveTrackKey(track)) && !songs.has(waveSongKey(track)) && used < 3 && used < leastUsed && (allowAdjacent || artistKey(track) !== artistKey(output.at(-1)))) { index = candidate; leastUsed = used; }
    });
    if (index < 0) return false;
    const track = lists[kind].splice(index, 1)[0];
    output.push(track); ids.add(waveTrackKey(track)); songs.add(waveSongKey(track)); artists.set(artistKey(track), (artists.get(artistKey(track)) || 0) + 1); counts[kind]++; return true;
  };
  while (output.length < limit) {
    const order = [...kinds].sort((a, b) => (counts[a] / Math.max(1, targets[a])) - (counts[b] / Math.max(1, targets[b])));
    if (!order.some(kind => counts[kind] < targets[kind] && take(kind)) && !order.some(kind => take(kind)) && !order.some(kind => take(kind, true))) break;
  }
  return output;
}
