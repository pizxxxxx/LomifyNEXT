import type { MusicImportCollection, MusicImportSeed } from './musicImport';

export const APPLE_MUSIC_WEB_URL = 'https://music.apple.com/';
export const APPLE_MUSIC_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const APPLE_MUSIC_MAX_PAGE_CHARS = 8 * 1024 * 1024;
const MAX_TRACKS = 50_000;
type RecordValue = Record<string, any>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

export function parseAppleMusicPlaylistUrl(input: string): { url: string; id: string } {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('Вставь полную ссылку на плейлист Apple Music.'); }
  if (url.protocol !== 'https:' || url.hostname !== 'music.apple.com' || url.port || url.username || url.password) {
    throw new Error('Нужна ссылка вида https://music.apple.com/ru/playlist/название/pl.…');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const playlistIndex = parts.indexOf('playlist');
  const id = parts.at(-1) || '';
  if (playlistIndex < 0 || playlistIndex > 1 || (playlistIndex === 1 && !/^[a-z]{2}(?:-[a-z]{2})?$/i.test(parts[0]))
    || ![2, 3].includes(parts.length - playlistIndex) || !/^pl\.[a-z0-9-]+$/i.test(id)) {
    throw new Error('Это не ссылка на плейлист. В Apple Music открой плейлист, нажми Поделиться и Скопировать ссылку.');
  }
  url.search = '';
  url.hash = '';
  return { url: url.href, id };
}

function appleTrackUrl(value: unknown): string {
  try {
    const url = new URL(text(value));
    if (url.protocol !== 'https:' || url.hostname !== 'music.apple.com' || url.port || url.username || url.password) return '';
    const id = url.searchParams.get('i');
    url.search = '';
    if (id && /^\d+$/.test(id)) url.searchParams.set('i', id);
    url.hash = '';
    return url.href;
  } catch { return ''; }
}

function songId(url: string): string {
  if (!url) return '';
  const parsed = new URL(url);
  const id = parsed.searchParams.get('i') || parsed.pathname.split('/').filter(Boolean).at(-1) || '';
  return /^\d+$/.test(id) ? id : '';
}

function durationMs(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const match = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i.exec(text(value));
  return match ? Math.round((Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) * 1000) : 0;
}

function attribute(attributes: string, name: string): string {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? '';
}

/** Read public, already-rendered metadata only. Never execute page scripts or extract account tokens. */
export function parseAppleMusicPlaylistPage(html: string, inputUrl: string): MusicImportCollection {
  const requested = parseAppleMusicPlaylistUrl(inputUrl);
  if (html.length > APPLE_MUSIC_MAX_PAGE_CHARS) throw new Error('Страница слишком большая. Используй XML-файл плейлиста.');
  const schemas: RecordValue[] = [];
  let server: RecordValue = {};
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = attribute(match[1], 'type');
    const id = attribute(match[1], 'id');
    if (type !== 'application/ld+json' && id !== 'serialized-server-data') continue;
    try {
      const value = JSON.parse(match[2]);
      if (id === 'serialized-server-data') server = record(value);
      else {
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) schemas.push(...(Array.isArray(item?.['@graph']) ? item['@graph'] : [item]).map(record));
      }
    } catch { /* Other page data cannot be used as a playlist. */ }
  }
  const schema = schemas.find(value => [value['@type']].flat().includes('MusicPlaylist'));
  if (!schema) throw new Error('Плейлист недоступен. Проверь, что он публичный и открывается в браузере, или выбери XML-файл.');
  if (schema.url && parseAppleMusicPlaylistUrl(schema.url).id !== requested.id) {
    throw new Error('Apple вернул другой плейлист. Скопируй ссылку на нужный плейлист ещё раз.');
  }
  const expected = Number(schema.numTracks);
  const advertised = Array.isArray(schema.track) ? schema.track
    : Array.isArray(schema.track?.itemListElement) ? schema.track.itemListElement.map((item: any) => item.item ?? item) : [];
  if (!Number.isInteger(expected) || expected < 0 || expected > MAX_TRACKS || expected !== advertised.length) {
    throw new Error('Apple показал неполный список треков. Для полного переноса выбери XML-файл плейлиста.');
  }
  const byId = new Map<string, RecordValue>();
  for (const entry of Array.isArray(server.data) ? server.data : []) {
    if (entry?.intent?.contentDescriptor?.identifiers?.storeAdamID !== requested.id) continue;
    for (const section of Array.isArray(entry?.data?.sections) ? entry.data.sections : []) {
      for (const item of Array.isArray(section.items) ? section.items : []) {
        if (item?.contentDescriptor?.kind !== 'song') continue;
        const id = String(item.contentDescriptor.identifiers?.storeAdamID || '');
        if (id && text(item.title)) byId.set(id, item);
      }
    }
  }
  const tracks: MusicImportSeed[] = advertised.map((value: unknown) => {
    const item = record(value);
    const externalUrl = appleTrackUrl(item.url);
    const id = songId(externalUrl);
    const row = byId.get(id);
    const artists: string[] = Array.isArray(row?.subtitleLinks)
      ? row.subtitleLinks.map((artist: any) => text(artist.title)).filter(Boolean)
      : [item.byArtist].flat().map((artist: any) => text(artist?.name)).filter(Boolean);
    const title = text(row?.title) || text(item.name);
    if (!id || !title || !artists.length) {
      throw new Error('У части треков не удалось прочитать название или артиста. Используй XML-файл, чтобы не потерять песни.');
    }
    return { id, title, artists, durationMs: durationMs(row?.duration) || durationMs(item.duration), externalUrl };
  });
  return { id: requested.id, kind: 'playlist', origin: 'apple-music', name: text(schema.name) || 'Плейлист Apple Music', originUrl: requested.url, tracks };
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16);
}

/** Whitelist music metadata. Local file locations and account identifiers never enter imported tracks. */
export function appleMusicCollectionsFromPlist(value: unknown, fileName = 'Apple Music.xml'): MusicImportCollection[] {
  const library = record(value);
  const sourceTracks = record(library.Tracks);
  if (Object.keys(sourceTracks).length > MAX_TRACKS) throw new Error('В файле больше 50 000 треков. Экспортируй отдельные плейлисты.');
  const seeds = new Map<string, MusicImportSeed>();
  const favourites: MusicImportSeed[] = [];
  for (const [key, value] of Object.entries(sourceTracks)) {
    const row = record(value);
    if (row.Podcast || row.Movie) continue;
    const title = text(row.Name);
    const artist = text(row.Artist);
    if (!title || !artist) continue;
    const externalUrl = appleTrackUrl(row['Apple Music URL'] || row.URL);
    const seed = {
      id: songId(externalUrl) || `xml:${text(row['Persistent ID']) || key}`,
      title, artists: [artist], durationMs: durationMs(row['Total Time']), externalUrl
    };
    seeds.set(String(row['Track ID'] ?? key), seed);
    if (row.Loved === true || row.Favorite === true) favourites.push(seed);
  }
  const collections: MusicImportCollection[] = [];
  let hasUserPlaylist = false;
  const playlists = Array.isArray(library.Playlists) ? library.Playlists : [];
  for (const [index, value] of playlists.entries()) {
    const playlist = record(value);
    if (playlist.Master || playlist.Folder || playlist['Distinguished Kind']) continue;
    if (!Array.isArray(playlist['Playlist Items'])) continue;
    hasUserPlaylist = true;
    const tracks = playlist['Playlist Items'].flatMap((item: any) => {
      const track = seeds.get(String(item?.['Track ID']));
      return track ? [{ ...track, artists: [...track.artists] }] : [];
    });
    const name = text(playlist.Name) || fileName.replace(/\.(?:xml|plist)$/i, '');
    if (tracks.length) collections.push({ id: `xml:${text(playlist['Playlist Persistent ID']) || stableId(`${fileName}:${index}:${name}`)}`, kind: 'playlist', name, origin: 'apple-music', tracks, sourceSkipped: playlist['Playlist Items'].length - tracks.length });
  }
  if (!hasUserPlaylist && seeds.size) collections.push({
    id: `xml:${stableId(fileName)}`, kind: 'playlist', name: fileName.replace(/\.(?:xml|plist)$/i, ''), origin: 'apple-music', tracks: [...seeds.values()]
  });
  if (favourites.length) collections.push({ id: `xml:favourites:${stableId(fileName)}`, kind: 'liked', name: 'Любимые Apple Music', origin: 'apple-music', tracks: favourites });
  if (!collections.length) throw new Error('В файле нет песен с названием и артистом. Выбери XML, экспортированный из Music или iTunes.');
  return collections;
}

export function parseAppleMusicXml(xml: string, fileName: string): MusicImportCollection[] {
  if (xml.length > APPLE_MUSIC_MAX_FILE_BYTES) throw new Error('Выбери XML-файл размером до 20 МБ.');
  if (/<!ENTITY\b|<!DOCTYPE[^>]*\[/i.test(xml)) throw new Error('Этот XML содержит неподдерживаемые объявления. Повтори экспорт плейлиста из Music или iTunes.');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'plist') throw new Error('Не удалось прочитать XML. Выбери файл экспорта Music или iTunes.');
  let nodes = 0;
  const parse = (element: Element, depth = 0): any => {
    if (++nodes > 1_000_000 || depth > 40) throw new Error('XML слишком сложный. Экспортируй отдельный плейлист.');
    const children = Array.from(element.children);
    switch (element.localName) {
      case 'dict': {
        const value = Object.create(null);
        if (children.length % 2) throw new Error('Структура XML повреждена. Повтори экспорт.');
        for (let index = 0; index < children.length; index += 2) {
          if (children[index].localName !== 'key') throw new Error('Структура XML повреждена. Повтори экспорт.');
          const key = children[index].textContent || '';
          if (Object.hasOwn(value, key)) throw new Error('В XML повторяются поля. Повтори экспорт.');
          value[key] = parse(children[index + 1], depth + 1);
        }
        return value;
      }
      case 'array': return children.map(child => parse(child, depth + 1));
      case 'integer': case 'real': return Number(element.textContent);
      case 'true': return true;
      case 'false': return false;
      case 'string': case 'date': case 'data': return element.textContent || '';
      default: throw new Error('Формат XML не поддерживается. Повтори экспорт из Music или iTunes.');
    }
  };
  const root = document.documentElement.firstElementChild;
  if (!root || root.localName !== 'dict') throw new Error('В XML нет медиатеки Music или iTunes.');
  return appleMusicCollectionsFromPlist(parse(root), fileName);
}
