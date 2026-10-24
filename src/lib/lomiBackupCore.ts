export const LOMI_MAX_BYTES = 64 * 1024 * 1024;
const MAX_TRACKS = 100_000;
export const BACKUP_SETTING_KEYS = [
  'theme', 'globalThemeEffect', 'accentFromCover', 'lyricsAlignment', 'lyricsOffset', 'lyricsAdlibs', 'lyricsAdlibStyle',
  'spatialAudio', 'spatialRoomSize', 'spatialIntensity', 'uiStyle', 'windowControlsStyle', 'uiScale', 'fontFamily',
  'design', 'glassMaterial', 'mattePalette', 'matteBlur', 'liquidGlassSeen', 'glassPanelWidth', 'glassPlaylistsCollapsed', 'glassQuality',
  'waveContinuation', 'coverTilt', 'coverGlare', 'cardSheen', 'panelPress', 'glyphWake', 'glyphWakeMode',
  'customProfileName', 'profileBannerUrl', 'waveCustomName', 'waveFreshTaste', 'fullscreenYandexVideo',
  'fullscreenYandexVideoFill', 'fullscreenYandexVideoFillDefaultApplied', 'showStartupNotice', 'crossfadeMs',
  'preloadNext', 'playbackRate', 'showLyricsByDefault', 'enableHoverPreview', 'hoverPreviewDelay'
] as const;
export interface LomiData {
  settings: Record<string, string | boolean | number | null>;
  stats: { listenSeconds: number; tracksPlayed: number; history: Record<string, any> };
  likes: any[]; dislikes: any[]; playlists: any[]; localTracks: any[];
  equalizer: { bands: number[]; preset: string; profiles: { id: string; name: string; gains: number[] }[] };
  achievements: Record<string, number>; searchHistory: string[]; volume: number;
  followedArtists: { name: string; source: string }[];
}
export interface LomiBackup { format: 'lomify-backup'; version: 1; appVersion: string; createdAt: string; data: LomiData }
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('В копии повреждена структура данных.');
  return value as Record<string, any>;
}
function text(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('В копии найдено некорректное текстовое поле.');
  return value;
}
function number(value: unknown, max = 1e10): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) throw new Error('В копии найдено некорректное числовое поле.');
  return value;
}
function array(value: unknown, max = MAX_TRACKS): any[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('В копии повреждён или слишком велик список.');
  return value;
}
function image(value: unknown): string {
  if (!value) return '';
  const src = text(value, 2 * 1024 * 1024);
  if (/^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i.test(src)) return src;
  try {
    const url = new URL(src);
    if (url.protocol !== 'https:' || url.username || url.password) return '';
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return ''; }
}
function track(value: unknown, history = false): any {
  const input = object(value);
  const result: any = { title: text(input.title), artist: text(input.artist), coverUrl: image(input.coverUrl) };
  if (input.id !== undefined) result.id = typeof input.id === 'number' ? number(input.id) : text(input.id, 1024);
  if (input.source !== undefined) result.source = text(input.source, 64);
  if (input.artists !== undefined) result.artists = array(input.artists, 100).map(value => text(value, 1024));
  if (input.duration !== undefined) result.duration = number(input.duration, 604800);
  if (input.genre !== undefined) result.genre = text(input.genre, 1024);
  if (!history && (result.id === undefined || result.id === '')) throw new Error('В копии отсутствует идентификатор трека.');
  if (history) {
    result.count = number(input.count, 1e9);
    if (input.lastPlayedAt !== undefined) result.lastPlayedAt = number(input.lastPlayedAt, Date.now() + 86400000);
  } else {
    result.audioUrl = '';
    if (input.likedAt !== undefined) result.likedAt = number(input.likedAt, Date.now() + 86400000);
    if (input.isLocal || input.source === 'Локальный') {
      result.isLocal = true;
      const path = text(input.audioUrl || '', 8192);
      if (/^(?:[a-z]:[\\/]|\/|file:\/\/)/i.test(path)) result.audioUrl = path;
    }
    if (input.playbackSource === 'soundcloud') result.playbackSource = 'soundcloud';
    for (const key of ['importedFrom', 'importSourceId', 'spotifyId', 'appleMusicId']) if (typeof input[key] === 'string') result[key] = text(input[key], 1024);
  }
  return result;
}
function gains(value: unknown) {
  const values = array(value, 10);
  if (values.length !== 10 || values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < -12 || value > 12)) throw new Error('В копии повреждены настройки эквалайзера.');
  return [...values] as number[];
}
const SETTING_ENUMS: Record<string, readonly string[]> = {
  design: ['classic', 'aurora', 'liquid-glass'], glassMaterial: ['optical', 'matte'],
  mattePalette: ['graphite-rose', 'espresso-orange', 'black-red', 'electric-blue', 'acid-black', 'blue-yellow'],
  glassQuality: ['high', 'normal', 'off'], uiStyle: ['style1', 'style2'], windowControlsStyle: ['windows', 'macos'],
  uiScale: ['auto', '100', '110', '125', '133', '150', '175', '200'],
  lyricsAlignment: ['left', 'right', 'fullscreen'], lyricsAdlibStyle: ['overlay', 'backdrop'], glyphWakeMode: ['classic', 'physical']
};
const SETTING_NUMBERS: Record<string, [number, number]> = {
  lyricsOffset: [-60000, 60000], spatialRoomSize: [0, 1], spatialIntensity: [.3, 1.5],
  crossfadeMs: [0, 30000], playbackRate: [.25, 4], hoverPreviewDelay: [0, 10000], glassPanelWidth: [180, 560]
};
function setting(key: string, value: unknown): string | number | boolean | null {
  const invalid = () => { throw new Error(`В копии повреждена настройка ${key}.`); };
  if (key === 'glassPanelWidth' && value === null) return null;
  if (SETTING_ENUMS[key]) return typeof value === 'string' && SETTING_ENUMS[key].includes(value) ? value : invalid();
  if (SETTING_NUMBERS[key]) {
    const [min, max] = SETTING_NUMBERS[key];
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : invalid();
  }
  if (key === 'profileBannerUrl') return image(value);
  if (['theme', 'fontFamily', 'customProfileName', 'waveCustomName'].includes(key)) return text(value, 200);
  return typeof value === 'boolean' ? value : invalid();
}
export function normalizeLomiData(raw: unknown): LomiData {
  const input = object(raw), settings: LomiData['settings'] = {}, stats = object(input.stats);
  const history: Record<string, any> = Object.create(null);
  const historyEntries = Object.entries(object(stats.history));
  if (historyEntries.length > MAX_TRACKS) throw new Error('В копии слишком большая история.');
  for (const [key, value] of historyEntries) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 8192) throw new Error('В копии некорректный ключ истории.');
    history[key] = track(value, true);
  }
  const rawSettings = object(input.settings);
  for (const key of BACKUP_SETTING_KEYS) {
    const value = rawSettings[key];
    if (value === undefined) continue;
    settings[key] = setting(key, value);
  }
  const eq = object(input.equalizer);
  const profiles = array(eq.profiles, 200).map(value => {
    const p = object(value), id = text(p.id, 64), name = text(p.name, 60).trim().replace(/\s+/g, ' ');
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id) || !name) throw new Error('В копии повреждён профиль звука.');
    return { id, name, gains: gains(p.gains) };
  });
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('В копии повторяются профили звука.');
  if (new Set(profiles.map(profile => profile.name.toLocaleLowerCase('ru'))).size !== profiles.length) throw new Error('В копии повторяются названия профилей звука.');
  const ids = new Set<string>();
  const playlists = array(input.playlists, 5000).map(value => {
    const p = object(value), id = typeof p.id === 'number' ? String(number(p.id)) : text(p.id, 1024);
    if (!id || ids.has(id)) throw new Error('В копии повторяются идентификаторы плейлистов.');
    ids.add(id);
    const result: any = { id, title: text(p.title), tracks: array(p.tracks).map(value => track(value)) };
    if (p.customCoverUrl) result.customCoverUrl = image(p.customCoverUrl);
    if (typeof p.origin === 'string') result.origin = text(p.origin, 64);
    if (typeof p.sourceId === 'string') result.sourceId = text(p.sourceId, 1024);
    // Remote account bindings/revisions are deliberately not restored on another PC.
    return result;
  });
  if (playlists.reduce((count, playlist) => count + playlist.tracks.length, 0) > 300_000) throw new Error('В копии слишком много песен в плейлистах.');
  const achievements: Record<string, number> = {};
  for (const [key, value] of Object.entries(object(input.achievements))) {
    if (!/^[a-z0-9-]{1,80}$/.test(key)) throw new Error('В копии некорректное достижение.');
    achievements[key] = number(value, Date.now() + 86400000);
  }
  const localIds = new Set<string>();
  const localTracks = array(input.localTracks).map(value => {
    const result = { ...track(value), isLocal: true };
    if (result.id === undefined || result.id === '' || localIds.has(String(result.id))) throw new Error('В копии повреждены идентификаторы локальных треков.');
    localIds.add(String(result.id)); return result;
  });
  return { settings, stats: { listenSeconds: number(stats.listenSeconds), tracksPlayed: number(stats.tracksPlayed, 1e9), history },
    likes: array(input.likes).map(value => track(value)), dislikes: array(input.dislikes).map(value => track(value)), playlists,
    localTracks,
    equalizer: { bands: gains(eq.bands), preset: text(eq.preset, 200), profiles }, achievements,
    followedArtists: array(input.followedArtists ?? [], 5000).map(value => { const item = object(value); return { name: text(item.name, 1024), source: text(item.source, 64) }; }),
    searchHistory: array(input.searchHistory, 1000).map(value => text(value)), volume: Math.min(1, number(input.volume, 1)) };
}
export function createLomiBackup(data: unknown, appVersion: string): LomiBackup {
  return { format: 'lomify-backup', version: 1, appVersion, createdAt: new Date().toISOString(), data: normalizeLomiData(data) };
}
export function parseLomiBackup(source: string): LomiBackup {
  if (new TextEncoder().encode(source).byteLength > LOMI_MAX_BYTES) throw new Error('Копия больше 64 МБ.');
  let raw: any;
  try { raw = JSON.parse(source.replace(/^\uFEFF/, '')); } catch { throw new Error('Не удалось прочитать .lomi. Файл повреждён или имеет другой формат.'); }
  raw = object(raw);
  if (raw.format !== 'lomify-backup') throw new Error('Это не резервная копия Lomify. Выбери файл .lomi.');
  if (raw.version !== 1) throw new Error('Эта версия копии пока не поддерживается. Обнови Lomify.');
  if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) throw new Error('В копии повреждена дата создания.');
  return { format: 'lomify-backup', version: 1, createdAt: raw.createdAt, appVersion: text(raw.appVersion, 80), data: normalizeLomiData(raw.data) };
}
