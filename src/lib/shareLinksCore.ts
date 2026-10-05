import { mixHash, type DailyMixKind, type DailyMixSource, type DailyTrack } from './dailyMixesCore';
import type { DailyMixSelection } from './dailyMixActions';

const LIMIT = 16000;
export const SHARE_PAGE_URL = 'https://pizxxxxx.github.io/LomifyNEXT/share/';
const sourceValid = (value: unknown): value is DailyMixSource => value === 'soundcloud' || value === 'yandex';
const idValid = (value: unknown): value is string => typeof value === 'string' && /^\d{1,25}(?::\d{1,25})?$/.test(value);
const kinds: DailyMixKind[] = ['favorites', 'repeat', 'discover', 'releases'];
const text = (value: unknown, size: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, size) : '';
const base64 = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export function trackShareLink(track: { id?: unknown; source?: unknown; title?: unknown; artist?: unknown }): string {
  const id = String(track.id || '');
  if (!sourceValid(track.source) || !idValid(id)) throw new Error('У этого трека нет ссылки Lomify.');
  const url = new URL('lomifynext://track');
  url.searchParams.set('v', '1'); url.searchParams.set('source', track.source); url.searchParams.set('id', id);
  url.searchParams.set('title', text(track.title, 180)); url.searchParams.set('artist', text(track.artist, 180));
  return browserShareLink(url.toString());
}
export function mixShareLink(selection: DailyMixSelection): string {
  const { mix, source } = selection;
  const tracks = mix.tracks.filter(track => idValid(String(track.id))).slice(0, 30).map(track => [String(track.id), text(track.title, 80), text(track.artist, 60)]);
  if (!tracks.length) throw new Error('В подборке пока нет треков для отправки.');
  const url = `lomifynext://mix?v=1&data=${base64([source, mix.kind, text(mix.title, 80), mix.day, tracks])}`;
  if (url.length > LIMIT) throw new Error('Подборка слишком большая для ссылки.');
  return browserShareLink(url);
}

function browserShareLink(deepLink: string): string {
  const native = new URL(deepLink);
  return `${SHARE_PAGE_URL}#${native.hostname}${native.search}`;
}

/** The web page launches only the validated application URL, never an arbitrary scheme. */
export function toDeepLink(raw: string): string | null {
  if (!parseShareLink(raw)) return null;
  const url = new URL(raw);
  return url.protocol === 'lomifynext:' ? raw : `lomifynext://${url.hash.slice(1)}`;
}

export function platformTrackLink(track: { id?: unknown; source?: unknown; title?: unknown; artist?: unknown }): string {
  if (track.source === 'yandex' && idValid(String(track.id))) return `https://music.yandex.ru/track/${String(track.id).split(':')[0]}`;
  const query = encodeURIComponent(`${text(track.artist, 180)} ${text(track.title, 180)}`.trim());
  return `https://soundcloud.com/search/sounds?q=${query}`;
}

/** Links contain only bounded service IDs and display text; never URLs or playback commands. */
export function parseShareLink(raw: string): DailyMixSelection | null {
  if (typeof raw !== 'string' || raw.length > LIMIT) return null;
  try {
    let url = new URL(raw);
    if (url.protocol === 'https:') {
      if (`${url.origin}${url.pathname}` !== SHARE_PAGE_URL || url.search || url.username || url.password || !url.hash) return null;
      url = new URL(`lomifynext://${url.hash.slice(1)}`);
    }
    if (url.protocol !== 'lomifynext:' || url.username || url.password || url.port || (url.pathname && url.pathname !== '/') || url.searchParams.get('v') !== '1') return null;
    if (url.hostname === 'track') {
      const source = url.searchParams.get('source'), id = url.searchParams.get('id');
      if (!sourceValid(source) || !idValid(id)) return null;
      const title = text(url.searchParams.get('title'), 180) || 'Присланный трек';
      const artist = text(url.searchParams.get('artist'), 180) || 'Исполнитель';
      return { id: `shared:${source}:${id}`, source, account: 'shared', sharedTrack: true, mix: { kind: 'discover', title, description: artist, day: '', tracks: [{ id, source, title, artist, coverUrl: '', audioUrl: '' }] } };
    }
    if (url.hostname !== 'mix') return null;
    const data = url.searchParams.get('data') || '';
    if (!/^[A-Za-z0-9_-]+$/.test(data)) return null;
    const bytes = Uint8Array.from(atob(data.replaceAll('-', '+').replaceAll('_', '/')), character => character.charCodeAt(0));
    const [source, kind, title, day, rows] = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!sourceValid(source) || !kinds.includes(kind) || typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || !Array.isArray(rows) || rows.length < 1 || rows.length > 30) return null;
    const tracks: DailyTrack[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== 3 || !idValid(row[0]) || !text(row[1], 80) || !text(row[2], 60)) return null;
      if (seen.has(row[0])) continue;
      seen.add(row[0]); tracks.push({ id: row[0], source, title: text(row[1], 80), artist: text(row[2], 60), coverUrl: '', audioUrl: '' });
    }
    return { id: `shared:mix:${mixHash(data).toString(36)}`, source, account: 'shared', shared: true, mix: { kind, title: text(title, 80) || 'Присланная подборка', description: 'Подборка, которой с тобой поделились в Lomify. Состав сохранён в ссылке.', day, tracks } };
  } catch { return null; }
}
