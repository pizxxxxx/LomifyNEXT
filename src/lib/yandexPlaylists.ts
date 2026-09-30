import { ymJson, mapYandexTrack, normalizeYandexToken, yandexAccountStatus } from '$lib/yandex';
const API = 'https://api.music.yandex.net';
export interface RemoteYandexPlaylist {
  id: string; title: string; tracks: any[]; coverUrl: string;
  ownerId: string; kind: string; revision: number;
}
function form(values: Record<string, string | number>) {
  return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString() };
}
function path(ownerId: string, kind: string) {
  return API + '/users/' + encodeURIComponent(ownerId) + '/playlists/' + encodeURIComponent(kind);
}
function artwork(raw: unknown): string {
  const value = String(raw || '').replace('%%', '400x400');
  return value ? (value.startsWith('http') ? value : 'https://' + value) : '';
}
export async function playlistAccount(rawToken: string): Promise<string> {
  const account = await yandexAccountStatus(normalizeYandexToken(rawToken));
  if (!account.uid) throw new Error('Не удалось определить аккаунт Яндекса. Подключи его заново.');
  return String(account.uid);
}
export async function listYandexPlaylists(token: string, accountId: string): Promise<any[]> {
  const result = await ymJson(API + '/users/' + encodeURIComponent(accountId) + '/playlists/list', token);
  if (!Array.isArray(result)) throw new Error('Яндекс не вернул список плейлистов. Повтори позже.');
  return result.map(item => ({
    ownerId: String(item.owner?.uid ?? item.owner?.id ?? accountId),
    kind: String(item.kind ?? ''), revision: Number(item.revision), title: String(item.title || '')
  })).filter(item => item.kind);
}
export async function readYandexPlaylist(token: string, ownerId: string, kind: string): Promise<RemoteYandexPlaylist> {
  const result = await ymJson(path(ownerId, kind), token);
  if (!result || !Array.isArray(result.tracks) || !Number.isFinite(Number(result.revision))) {
    throw new Error('Яндекс вернул неполный плейлист. Местная копия сохранена.');
  }
  const entries: any[] = result.tracks;
  if (Number(result.trackCount ?? entries.length) !== entries.length) {
    throw new Error('Загрузились не все треки плейлиста. Повтори позже.');
  }
  const missing = [...new Set(entries.filter(entry => !entry.track?.title && !entry.title).map(entry => String(entry.id)))];
  const hydrated = new Map<string, any>();
  for (let start = 0; start < missing.length; start += 100) {
    const tracks = await ymJson(API + '/tracks?trackIds=' + encodeURIComponent(missing.slice(start, start + 100).join(',')), token);
    if (!Array.isArray(tracks)) throw new Error('Не удалось загрузить сведения о треках.');
    for (const track of tracks) hydrated.set(String(track.id), track);
  }
  const tracks = entries.map(entry => {
    const id = String(entry.id ?? entry.track?.id ?? '');
    if (!id) throw new Error('В ответе Яндекса отсутствует номер трека. Местная копия сохранена.');
    const full = entry.track ?? hydrated.get(id) ?? entry;
    const track = mapYandexTrack(full) || { id, source: 'yandex' };
    return { ...track, id, albumId: String(entry.albumId ?? track.albumId ?? ''),
      title: track.title || 'Недоступный трек', unavailable: !full.title || full.available === false };
  });
  return { id: 'ym_playlist_' + ownerId + '_' + kind, ownerId, kind,
    revision: Number(result.revision), title: String(result.title || 'Плейлист'),
    coverUrl: artwork(result.cover?.uri ?? result.cover?.itemsUri?.[0]) || tracks[0]?.coverUrl || '', tracks };
}
export async function prepareYandexTracks(token: string, tracks: any[]): Promise<any[]> {
  if (tracks.some(track => track.source !== 'yandex' || !String(track.id ?? '').match(/^\d+$/))) {
    throw new Error('В Яндекс можно отправить плейлист из треков Яндекс Музыки. Треки других сервисов сохрани в отдельной подборке.');
  }
  const missing = [...new Set(tracks.filter(track => !track.albumId).map(track => String(track.id)))];
  const albums = new Map<string, string>();
  for (let start = 0; start < missing.length; start += 100) {
    const result = await ymJson(API + '/tracks?trackIds=' + encodeURIComponent(missing.slice(start, start + 100).join(',')), token);
    if (!Array.isArray(result)) throw new Error('Не удалось проверить треки перед отправкой.');
    for (const track of result) if (track.albums?.[0]?.id) albums.set(String(track.id), String(track.albums[0].id));
  }
  return tracks.map(track => {
    const albumId = String(track.albumId || albums.get(String(track.id)) || '');
    if (!albumId.match(/^\d+$/)) throw new Error('Яндекс не сообщил альбом для трека «' + track.title + '». Плейлист сохранён в Lomify.');
    return { ...track, albumId };
  });
}
export async function changeYandexTracks(token: string, remote: RemoteYandexPlaylist, tracks: any[]): Promise<void> {
  const prepared = await prepareYandexTracks(token, tracks);
  const diff = [];
  if (remote.tracks.length) diff.push({ op: 'delete', from: 0, to: remote.tracks.length });
  if (prepared.length) diff.push({ op: 'insert', at: 0, tracks: prepared.map(track => ({ id: String(track.id), albumId: String(track.albumId) })) });
  if (!diff.length) return;
  await ymJson(path(remote.ownerId, remote.kind) + '/change', token,
    form({ kind: remote.kind, revision: remote.revision, diff: JSON.stringify(diff) }));
}
export async function renameYandexPlaylist(token: string, remote: RemoteYandexPlaylist, title: string): Promise<void> {
  await ymJson(path(remote.ownerId, remote.kind) + '/name', token, form({ value: title }));
}
export async function createYandexPlaylist(token: string, accountId: string, title: string): Promise<RemoteYandexPlaylist> {
  const result = await ymJson(API + '/users/' + encodeURIComponent(accountId) + '/playlists/create', token,
    form({ title, visibility: 'private' }));
  if (result?.kind === undefined) throw new Error('Не удалось получить созданный плейлист. Проверь его в Яндекс Музыке перед повторной отправкой.');
  return { id: 'ym_playlist_' + accountId + '_' + result.kind, ownerId: accountId, kind: String(result.kind),
    title, tracks: [], coverUrl: '', revision: Number(result.revision || 1) };
}
export function isRevisionConflict(error: unknown): boolean {
  const value = error as { code?: string; status?: number; message?: string };
  return value?.status === 409 || /revision|wrong-version|conflict/i.test(String(value?.code || '') + ' ' + String(value?.message || ''));
}
