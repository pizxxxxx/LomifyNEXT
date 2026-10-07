export interface TasteSeed { id: string | number; source: 'soundcloud' | 'yandex'; artist: string; weight: number; recentAt: number }
export interface TasteProfile {
  artists: Map<string, number>;
  genres: Map<string, number>;
  displayNames: Map<string, string>;
  seeds: TasteSeed[];
  strength: number;
}

const key = (value: unknown) => `${value ?? ''}`.toLocaleLowerCase('ru').replace(/\s+/g, ' ').trim();
const DAY = 86400000;
function freshness(timestamp: unknown, halfLife: number, floor: number, now: number): number {
  const time = Number(timestamp);
  if (!Number.isFinite(time) || time <= 0) return floor;
  return floor + (1 - floor) * 2 ** (-Math.max(0, now - time) / DAY / halfLife);
}

export function buildTasteProfile(
  likes: any[] = [], stats: any = null, playlists: any[] = [],
  lastFmArtists: { name: string; playcount: number }[] = [],
  discovery: { name: string; match: number }[] = [], now = Date.now()
): TasteProfile {
  const artists = new Map<string, number>(), genres = new Map<string, number>(), displayNames = new Map<string, string>();
  const seeds = new Map<string, TasteSeed>();
  const bump = (map: Map<string, number>, raw: unknown, weight: number) => {
    const normalized = key(raw);
    if (!normalized) return;
    map.set(normalized, (map.get(normalized) || 0) + weight);
    if (map === artists && !displayNames.has(normalized)) displayNames.set(normalized, `${raw}`);
  };
  const seed = (track: any, weight: number, recentAt = 0) => {
    if (!track?.id || !['soundcloud', 'yandex'].includes(track.source)) return;
    const identity = `${track.source}:${track.id}`;
    const previous = seeds.get(identity);
    seeds.set(identity, {
      id: track.id, source: track.source, artist: key(track.artist),
      weight: Math.max(previous?.weight || 0, weight), recentAt: Math.max(previous?.recentAt || 0, recentAt)
    });
  };
  likes.forEach((track, index) => {
    // Existing libraries have newest likes first but no timestamps. Keep every like eligible.
    const recency = track.likedAt ? freshness(track.likedAt, 45, 0.35, now)
      : 0.45 + 0.55 * (1 - index / Math.max(1, likes.length - 1));
    bump(artists, track.artist, 5 * recency);
    bump(genres, track.genre, 2.5 * recency);
    seed(track, 3 * recency, Number(track.likedAt) || 0);
  });
  const history: any[] = Object.values(stats?.history || {});
  for (const entry of history) {
    const repeats = Math.max(1, Number(entry.count) || 1);
    const recency = freshness(entry.lastPlayedAt, 14, 0.08, now);
    bump(artists, entry.artist, Math.min(5, 1 + Math.log2(repeats + 1) * 1.25) * recency);
    bump(genres, entry.genre, Math.min(2, Math.log2(repeats + 1) * 0.45) * recency);
    seed(entry, 6 * recency, Number(entry.lastPlayedAt) || 0);
  }
  lastFmArtists.forEach((artist, index) => {
    bump(artists, artist.name, Math.max(1.4, 3.2 - index * 0.38)
      + Math.min(1.2, Math.log2(Math.max(1, artist.playcount) + 1) * 0.18));
  });
  discovery.forEach(artist => bump(artists, artist.name, 0.55 + artist.match * 0.7));
  // A large imported playlist must not outweigh explicit likes or recent listening.
  const playlistArtists = new Map<string, number>(), playlistGenres = new Map<string, number>();
  let playlistCount = 0;
  for (const playlist of playlists) for (const track of playlist.tracks || []) {
    playlistCount++;
    bump(playlistArtists, track.artist, 0.85);
    bump(playlistGenres, track.genre, 0.4);
    if (track.artist && !displayNames.has(key(track.artist))) displayNames.set(key(track.artist), track.artist);
    seed(track, 0.4);
  }
  playlistArtists.forEach((weight, artist) => bump(artists, artist, Math.min(3, weight)));
  playlistGenres.forEach((weight, genre) => bump(genres, genre, Math.min(2, weight)));
  return {
    artists, genres, displayNames, seeds: [...seeds.values()],
    strength: likes.length * 2 + history.length + Math.min(12, playlistCount * 0.25)
      + Math.min(8, lastFmArtists.length * 1.25) + Math.min(3, discovery.length * 0.25)
  };
}

/** Weighted samples from the entire library, with a recent anchor and varied artists. */
export function chooseTasteSeeds(profile: TasteProfile, source: TasteSeed['source'], count: number, random = Math.random): (string | number)[] {
  const candidates = profile.seeds.filter(seed => seed.source === source);
  const ordered = candidates.map(seed => ({ seed, rank: -Math.log(Math.max(Number.EPSILON, random())) / seed.weight }))
    .sort((a, b) => a.rank - b.rank).map(item => item.seed);
  const recent = [...candidates].filter(seed => seed.recentAt > Date.now() - 14 * DAY).sort((a, b) => b.recentAt - a.recentAt)[0];
  const selected: TasteSeed[] = recent ? [recent] : [];
  const seen = new Set(selected.map(seed => `${seed.id}`));
  const artists = new Set(selected.map(seed => seed.artist));
  for (const allowSameArtist of [false, true]) for (const seed of ordered) {
    if (selected.length >= count) break;
    if (seen.has(`${seed.id}`) || (!allowSameArtist && artists.has(seed.artist))) continue;
    selected.push(seed); seen.add(`${seed.id}`); artists.add(seed.artist);
  }
  return selected.slice(0, count).map(seed => seed.id);
}
