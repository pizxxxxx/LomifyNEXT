const normalizeSong = (value: string) => value.toLocaleLowerCase('ru').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

export interface SongReference { title: string; artist: string; artists?: string[]; duration?: number }
export interface UncensoredTrack extends SongReference { id: string | number; source: string; coverUrl: string; audioUrl: string; originalArtist?: string; isBanned?: boolean }
const explicit = /\b(?:uncensored|un[- ]censored|explicit|dirty)\b|без\s+цензур[ыа]|нецензур/iu;
const clean = /\b(?:clean|censored|radio edit)\b|\bцензурная\b/iu;
const alternate = /\b(?:remix|sped\s?up|slowed|reverb|cover|live|instrumental|nightcore)\b|ремикс|караоке|замедлен|ускорен/iu;
const edition = /\s*[(\[][^(\[]*(?:uncensored|explicit|dirty|clean|censored|без\s+цензуры|radio edit)[^)\]]*[)\]]/giu;

export function uncensoredQueries(track: SongReference): string[] {
  const title = track.title.replace(edition, '').trim();
  const artist = track.artists?.[0] || track.artist.split(/,| feat\.? | ft\.? /iu)[0];
  const base = `${artist} ${title}`.trim().slice(0, 180);
  return [`${base} uncensored`, `${base} без цензуры`, base];
}

export function rankUncensored<T extends UncensoredTrack>(original: SongReference, candidates: T[]): { track: T; marked: boolean }[] {
  const title = original.title.replace(edition, '').trim();
  const artists = (original.artists?.length ? original.artists : original.artist.split(/,| feat\.? | ft\.? /iu))
    .map(normalizeSong).filter(value => value.length >= 3);
  const seen = new Set<string>();
  return candidates.flatMap(track => {
    const key = `${track.source}:${track.id}`;
    if (track.source !== 'soundcloud' || !track.id || track.isBanned || seen.has(key)) return [];
    seen.add(key);
    const marked = explicit.test(track.title);
    if (!marked && clean.test(track.title)) return [];
    if (alternate.test(track.title) && !alternate.test(original.title)) return [];
    const normalized = normalizeSong(`${track.title} ${track.originalArtist || track.artist}`);
    if (!artists.some(artist => ` ${normalized} `.includes(` ${artist} `))) return [];
    const wanted = normalizeSong(title), uploaded = normalizeSong(track.title.replace(edition, ''));
    // Require the whole song name, including word boundaries. A shared first word is not a match.
    const score = uploaded === wanted ? 1000 : ` ${uploaded} `.includes(` ${wanted} `) ? 580 : 0;
    if (!wanted || !score) return [];
    // Different duration often means a remix, compilation or preview of another song.
    if (original.duration && track.duration && Math.abs(original.duration - track.duration) > Math.max(15000, original.duration * .18)) return [];
    return [{ track, marked, score: score + (marked ? 1200 : 0) }];
  }).sort((a, b) => b.score - a.score).slice(0, 5).map(({ track, marked }) => ({ track, marked }));
}

/** Explicitly chosen editions must never be replaced by a twin on another service. */
export function allowServiceTwin(track: { playbackSource?: string }, enabled: boolean): boolean {
  return enabled && !track.playbackSource;
}
