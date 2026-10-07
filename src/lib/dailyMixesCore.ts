export type DailyMixKind = 'favorites' | 'repeat' | 'discover' | 'releases';
export type DailyMixSource = 'soundcloud' | 'yandex';
export interface DailyTrack {
  id: string;
  title: string;
  artist: string;
  source: DailyMixSource;
  coverUrl: string;
  audioUrl: '';
  duration?: number;
  artists?: string[];
  albumId?: string;
  albumTitle?: string;
  releaseDate?: string;
  permalinkUrl?: string;
}
export interface DailyMix {
  kind: DailyMixKind;
  title: string;
  description: string;
  day: string;
  tracks: DailyTrack[];
}
export interface DailyMixInput {
  day: string;
  now: number;
  source: DailyMixSource;
  account: string;
  likes: any[];
  history: Record<string, any>;
  playlists: any[];
  disliked: any[];
  recommendations: any[];
  recommendationsDay: string;
  releases: any[];
  releasesDay: string;
}
export interface DailyMixSnapshot {
  version: 1;
  context: string;
  day: string;
  updatedAt: number;
  mixes: DailyMix[];
  variation?: number;
}

export const DAILY_MIX_SIZE = 30;
const DAY_MS = 86_400_000;
const definitions: Array<Pick<DailyMix, 'kind' | 'title' | 'description'>> = [
  { kind: 'favorites', title: 'Для тебя', description: 'Новые песни по твоему вкусу. Лайки помогают выбрать музыку, но сами сюда не попадают.' },
  { kind: 'repeat', title: 'На повторе', description: 'Треки, к которым ты возвращаешься за последний месяц. Свежие прослушивания важнее старых.' },
  { kind: 'discover', title: 'Открытия', description: 'Похожие на твой вкус песни, которых ещё нет в твоей медиатеке и истории.' },
  { kind: 'releases', title: 'Новые релизы', description: 'Свежая музыка знакомых исполнителей за последние два месяца.' }
];

export function localMixDay(now = Date.now()): string {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function mixHash(text: string): number {
  let value = 2166136261;
  for (const character of text) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  value ^= value >>> 16;
  return value >>> 0;
}

export function mixTrackIdentity(track: any): string {
  return `${track?.source || ''}:${track?.id || ''}`;
}

const normalize = (value: unknown) => String(value || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').trim();
const songKey = (track: any) => `${normalize(track?.artist)}\u0000${normalize(track?.title)}`;
const decay = (timestamp: unknown, now: number, days: number, fallback = 0.25) => {
  const value = Number(timestamp);
  return Number.isFinite(value) && value > 0 ? Math.exp(-Math.max(0, now - value) / (DAY_MS * days)) : fallback;
};

function publicUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    for (const key of [...url.searchParams.keys()]) {
      if (/token|authorization|session|secret|signature|api_sig|policy|key-pair-id/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch { return ''; }
}

function metadata(track: any, source: DailyMixSource): DailyTrack | null {
  if (!track || Array.isArray(track.tracks) || track.isLocal || track.isBanned || track.isUnavailable || track.source !== source || track.id == null || !String(track.id).trim() || !track.title || !track.artist) return null;
  const value: DailyTrack = {
    id: String(track.id), title: String(track.title).slice(0, 1000), artist: String(track.artist).slice(0, 1000),
    source, coverUrl: publicUrl(track.coverUrl), audioUrl: ''
  };
  if (Number.isFinite(track.duration)) value.duration = track.duration;
  if (Array.isArray(track.artists)) value.artists = track.artists.filter((artist: unknown) => typeof artist === 'string').slice(0, 20);
  for (const key of ['albumId', 'albumTitle', 'releaseDate'] as const) if (track[key] != null) value[key] = String(track[key]).slice(0, 1000);
  if (track.permalinkUrl) value.permalinkUrl = publicUrl(track.permalinkUrl);
  return value;
}

function unique(tracks: any[], source: DailyMixSource, blocked: Set<string>): DailyTrack[] {
  const ids = new Set<string>();
  const songs = new Set<string>();
  const output: DailyTrack[] = [];
  for (const raw of tracks) {
    const track = metadata(raw, source);
    if (!track) continue;
    const id = mixTrackIdentity(track), song = songKey(track);
    if (ids.has(id) || songs.has(song) || blocked.has(id) || blocked.has(song)) continue;
    ids.add(id); songs.add(song); output.push(track);
  }
  return output;
}

function select(pool: DailyTrack[], seed: string, score: (track: DailyTrack) => number): DailyTrack[] {
  const ranked = pool.map((track) => {
    const random = (mixHash(`${seed}:${mixTrackIdentity(track)}`) + 1) / 4_294_967_297;
    return { track, rank: -Math.log(random) / Math.max(0.01, score(track)) };
  }).sort((a, b) => a.rank - b.rank).slice(0, DAILY_MIX_SIZE);
  const ordered: DailyTrack[] = [];
  while (ranked.length) {
    const lastArtist = ordered.length > 1 && normalize(ordered.at(-1)?.artist) === normalize(ordered.at(-2)?.artist)
      ? normalize(ordered.at(-1)?.artist) : '';
    const alternative = lastArtist ? ranked.findIndex(({ track }) => normalize(track.artist) !== lastArtist) : -1;
    ordered.push(ranked.splice(alternative < 0 ? 0 : alternative, 1)[0].track);
  }
  return ordered;
}

export function dailyMixContext(input: Pick<DailyMixInput, 'source' | 'account'>): string {
  return `${input.source}:${mixHash(input.account).toString(36)}`;
}

export function dailyReleaseArtists(likes: any[], history: Record<string, any>, source: DailyMixSource, now = Date.now()): string[] {
  const artists = new Map<string, { name: string; score: number }>();
  const add = (track: any, score: number) => {
    if (!track?.artist || (track.source && track.source !== source) || track.isLocal) return;
    const key = normalize(track.artist);
    const previous = artists.get(key);
    artists.set(key, { name: String(track.artist), score: (previous?.score || 0) + score });
  };
  for (const track of likes) add(track, 5 * decay(track.likedAt, now, 45));
  for (const track of Object.values(history || {})) add(track, (2 + Math.log1p(track.count || 0)) * decay(track.lastPlayedAt, now, 14));
  return [...artists.values()].sort((a, b) => b.score - a.score).slice(0, 6).map((artist) => artist.name);
}

export function buildDailyMixes(input: DailyMixInput, cached?: DailyMixSnapshot | null, force = false): DailyMixSnapshot {
  const context = dailyMixContext(input);
  const sameContext = cached?.version === 1 && cached.context === context;
  const previousVariation = sameContext && Number.isSafeInteger(cached.variation) ? cached.variation! : 0;
  const variation = force ? previousVariation + 1 : previousVariation;
  const blocked = new Set([...input.disliked, ...input.likes].flatMap((track) => [mixTrackIdentity(track), songKey(track)]));
  const catalog = unique([...input.likes, ...input.recommendations, ...input.releases], input.source, blocked);
  const bySong = new Map(catalog.map((track) => [songKey(track), track]));
  const history = Object.values(input.history || {});
  const byHistory = new Map(history.map((entry) => [songKey(entry), entry]));
  const known = [...input.likes, ...history, ...input.playlists.flatMap((playlist) => playlist.tracks || [])];
  const knownSongs = new Set(known.map(songKey));
  const knownIds = new Set(known.filter((track) => track?.source === input.source && track?.id != null).map(mixTrackIdentity));
  const repeat = unique(history.filter((entry) => Number(entry.lastPlayedAt) >= input.now - 30 * DAY_MS)
    .map((entry) => ({ ...entry, ...(bySong.get(songKey(entry)) || {}) })), input.source, blocked);
  const discoveries = unique(input.recommendations, input.source, blocked).filter((track) => !knownSongs.has(songKey(track)) && !knownIds.has(mixTrackIdentity(track)));
  const releases = unique(input.releases, input.source, blocked).filter((track) => {
    const releasedAt = Date.parse(track.releaseDate || '');
    return Number.isFinite(releasedAt) && releasedAt <= input.now + 7 * DAY_MS && input.now - releasedAt <= 60 * DAY_MS;
  });
  const pools = { favorites: discoveries, repeat, discover: discoveries, releases };
  const scores = {
    favorites: () => 1,
    repeat: (track: DailyTrack) => { const played = byHistory.get(songKey(track)); return (1 + Math.log1p(played?.count || 0)) * decay(played?.lastPlayedAt, input.now, 14); },
    discover: () => 1,
    releases: (track: DailyTrack) => 1 + 4 * decay(Date.parse(track.releaseDate || ''), input.now, 30)
  };
  const mixes = definitions.map((definition): DailyMix => {
    const old = sameContext && Array.isArray(cached?.mixes) ? cached.mixes.find((mix) => mix?.kind === definition.kind && (definition.kind !== 'favorites' || mix.title === definition.title) && /^\d{4}-\d{2}-\d{2}$/.test(mix.day)) : undefined;
    const fresh = definition.kind === 'discover' || definition.kind === 'favorites' ? input.recommendationsDay === input.day
      : definition.kind === 'releases' ? input.releasesDay === input.day : true;
    const previous = old ? unique(Array.isArray(old.tracks) ? old.tracks : [], input.source, blocked)
      .filter((track) => (definition.kind !== 'discover' && definition.kind !== 'favorites') || old.day === input.day || (!knownSongs.has(songKey(track)) && !knownIds.has(mixTrackIdentity(track)))) : [];
    if ((!fresh || (!force && old?.day === input.day && previous.length > 0)) && previous.length > 0) {
      return { ...definition, day: old!.day, tracks: previous.slice(0, DAILY_MIX_SIZE) };
    }
    const seed = `${context}:${input.day}:${definition.kind}:${variation}`;
    const pool = pools[definition.kind];
    const previousIds = new Set(previous.map(mixTrackIdentity));
    // Manual refresh first fills from songs outside the previous composition.
    // A small repeat/release pool may have no alternatives; retain honest metadata.
    const alternatives = force ? pool.filter(track => !previousIds.has(mixTrackIdentity(track))) : pool;
    if (force && fresh && previous.length && !alternatives.length && old?.day === input.day) {
      return { ...definition, day: input.day, tracks: (pool.length ? previous.filter(track => pool.some(candidate => mixTrackIdentity(candidate) === mixTrackIdentity(track))) : previous).slice(0, DAILY_MIX_SIZE) };
    }
    const newTracks = fresh ? select(alternatives, seed, scores[definition.kind]) : [];
    const chosen = new Set(newTracks.map(mixTrackIdentity));
    const tracks = [...newTracks, ...(fresh ? select(pool.filter(track => !chosen.has(mixTrackIdentity(track))), seed, scores[definition.kind]) : [])].slice(0, DAILY_MIX_SIZE);
    return { ...definition, day: input.day, tracks };
  });
  return { version: 1, context, day: input.day, updatedAt: input.now, mixes, variation };
}

/** Remove likes by service identity and by song, including alternate editions. */
export function withoutLikedDailyTracks(tracks: DailyTrack[], likes: any[]): DailyTrack[] {
  const blocked = new Set(likes.flatMap(track => [mixTrackIdentity(track), songKey(track)]));
  return tracks.filter(track => !blocked.has(mixTrackIdentity(track)) && !blocked.has(songKey(track)));
}
