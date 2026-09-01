import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { openUrl } from '@tauri-apps/plugin-opener';
import { get } from 'svelte/store';
import { likedTracks, playlists, settings } from './stores';
import { searchSoundCloud } from './api';
import { searchYandex } from './yandex';
import {
  importMusicCollections,
  normalizeImportText,
  type MusicImportCollection,
  type MusicImportSeed
} from './musicImport';

const SPOTIFY_SESSION_KEY = 'lomifynext_spotify_session';
const SPOTIFY_API = 'https://api.spotify.com/v1';
const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_SCOPES = [
  'user-read-private',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative'
].join(' ');

export const SPOTIFY_DASHBOARD_URL = 'https://developer.spotify.com/dashboard';
export const SPOTIFY_PRIVACY_URL = 'https://www.spotify.com/account/privacy/';
// Dashboard фактически валидирует loopback URI только с явным портом, поэтому frontend и
// нативный listener используют один фиксированный адрес. Он должен совпадать посимвольно.
export const SPOTIFY_REDIRECT_SETUP = 'http://127.0.0.1:43827/callback';

interface SpotifySession {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface SpotifyOauthStart {
  redirectUri: string;
}

interface SpotifyOauthCallback {
  code?: string;
  error?: string;
  state?: string;
}

interface SpotifyTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

export interface SpotifyProfile {
  id: string;
  accountId: string;
  displayName: string;
  avatarUrl: string;
  externalUrl: string;
}

export interface SpotifyImportSource {
  id: string;
  kind: 'saved' | 'playlist';
  name: string;
  total: number;
  owner: string;
  externalUrl: string;
  importable: boolean;
  unavailableReason?: string;
}

interface SpotifyTrackSeed {
  id: string;
  title: string;
  artists: string[];
  durationMs: number;
  externalUrl: string;
}

export interface SpotifyImportProgress {
  phase: 'fetching' | 'matching' | 'saving' | 'done';
  total: number;
  current: number;
  matched: number;
  skipped: number;
  currentTrack: string;
}

export interface SpotifyImportResult {
  total: number;
  matched: number;
  skipped: number;
  likedAdded: number;
  playlistsImported: number;
}

export interface SpotifyBackupTextFile {
  name: string;
  text: string;
}

class SpotifyApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason = ''
  ) {
    super(message);
  }
}

function browserStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function readSession(): SpotifySession | null {
  const raw = browserStorage()?.getItem(SPOTIFY_SESSION_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as SpotifySession;
    return value?.clientId && value?.refreshToken ? value : null;
  } catch {
    return null;
  }
}

function writeSession(session: SpotifySession) {
  browserStorage()?.setItem(SPOTIFY_SESSION_KEY, JSON.stringify(session));
}

export function hasSpotifySession(clientId?: string): boolean {
  const session = readSession();
  return Boolean(session && (!clientId || session.clientId === clientId.trim()));
}

export function disconnectSpotify() {
  browserStorage()?.removeItem(SPOTIFY_SESSION_KEY);
}

function randomText(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function spotifyHttp(url: string, init?: RequestInit): Promise<Response> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    return tauriFetch(url, init);
  }
  return window.fetch(url, init);
}

async function responseError(response: Response): Promise<SpotifyApiError> {
  let message = `Spotify ответил ${response.status}`;
  let reason = '';
  try {
    const body = await response.json();
    message = body?.error?.message || body?.error_description || body?.error || message;
    reason = body?.error?.reason || body?.reason || '';
  } catch {
    // У некоторых отказов тело пустое или не JSON — статус всё равно остаётся полезным.
  }
  if (response.status === 429 && reason === 'QUOTA_EXCEEDED') {
    message = 'Квота Spotify Development Mode исчерпана. Попробуй позже.';
  } else if (response.status === 429) {
    message = 'Spotify временно ограничил частоту запросов. Повтори импорт позже.';
  } else if (response.status === 403) {
    message = 'Spotify не дал доступ. Проверь Premium и allowlist приложения.';
  }
  return new SpotifyApiError(message, response.status, reason);
}

async function exchangeCode(
  clientId: string,
  code: string,
  redirectUri: string,
  verifier: string
): Promise<SpotifySession> {
  const response = await spotifyHttp(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier
    }).toString()
  });
  if (!response.ok) throw await responseError(response);
  const token = (await response.json()) as SpotifyTokenResponse;
  if (!token.access_token || !token.refresh_token) {
    throw new Error('Spotify не вернул refresh token — подключи аккаунт ещё раз');
  }
  return {
    clientId,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + Math.max(60, token.expires_in || 3600) * 1000
  };
}

async function refreshSession(session: SpotifySession): Promise<SpotifySession> {
  const response = await spotifyHttp(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: session.clientId,
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken
    }).toString()
  });
  if (!response.ok) throw await responseError(response);
  const token = (await response.json()) as SpotifyTokenResponse;
  const refreshed = {
    ...session,
    accessToken: token.access_token,
    refreshToken: token.refresh_token || session.refreshToken,
    expiresAt: Date.now() + Math.max(60, token.expires_in || 3600) * 1000
  };
  writeSession(refreshed);
  return refreshed;
}

async function validSession(clientId: string): Promise<SpotifySession> {
  const session = readSession();
  if (!session || session.clientId !== clientId.trim()) {
    throw new Error('Сначала подключи Spotify');
  }
  if (session.expiresAt - Date.now() > 60_000) return session;
  return refreshSession(session);
}

async function spotifyApi<T>(clientId: string, path: string, retryAuth = true): Promise<T> {
  const session = await validSession(clientId);
  const response = await spotifyHttp(`${SPOTIFY_API}${path}`, {
    headers: { Authorization: `Bearer ${session.accessToken}` }
  });
  if (response.status === 401 && retryAuth) {
    await refreshSession(session);
    return spotifyApi<T>(clientId, path, false);
  }
  if (!response.ok) throw await responseError(response);
  return response.json() as Promise<T>;
}

function mapProfile(body: any): SpotifyProfile {
  return {
    id: String(body?.id || ''),
    accountId: String(body?.account_id || body?.id || ''),
    displayName: String(body?.display_name || 'Spotify'),
    avatarUrl: String(body?.images?.[0]?.url || ''),
    externalUrl: String(body?.external_urls?.spotify || '')
  };
}

export async function authorizeSpotify(clientIdRaw: string): Promise<SpotifyProfile> {
  const clientId = clientIdRaw.trim();
  if (!/^[a-z0-9]{20,64}$/i.test(clientId)) {
    throw new Error('Client ID выглядит неверно');
  }
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error('Подключение Spotify запускается только в desktop-приложении');
  }

  const state = randomText(32);
  const verifier = randomText(96);
  const challenge = await pkceChallenge(verifier);
  let unlisten: UnlistenFn | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveCallback!: (payload: SpotifyOauthCallback) => void;
  let rejectCallback!: (error: Error) => void;
  const callback = new Promise<SpotifyOauthCallback>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });

  try {
    unlisten = await listen<SpotifyOauthCallback>('spotify:oauth-callback', (event) => {
      resolveCallback(event.payload);
    });
    timer = setTimeout(
      () => rejectCallback(new Error('Время входа в Spotify истекло')),
      5 * 60 * 1000 + 5000
    );
    const started = await invoke<SpotifyOauthStart>('spotify_oauth_start');
    const authUrl = new URL('https://accounts.spotify.com/authorize');
    authUrl.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: started.redirectUri,
      state,
      scope: SPOTIFY_SCOPES,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      show_dialog: 'true'
    }).toString();
    await openUrl(authUrl.toString());

    const result = await callback;
    if (result.state !== state) throw new Error('Spotify вернул неверный state — вход отменён');
    if (result.error) {
      throw new Error(result.error === 'access_denied' ? 'Доступ к Spotify не выдан' : result.error);
    }
    if (!result.code) throw new Error('Spotify не вернул код авторизации');

    const session = await exchangeCode(clientId, result.code, started.redirectUri, verifier);
    writeSession(session);
    return mapProfile(await spotifyApi<any>(clientId, '/me'));
  } finally {
    if (timer) clearTimeout(timer);
    unlisten?.();
  }
}

export async function getSpotifyProfile(clientId: string): Promise<SpotifyProfile> {
  return mapProfile(await spotifyApi<any>(clientId, '/me'));
}

async function pagedItems(clientId: string, path: string): Promise<any[]> {
  const all: any[] = [];
  let offset = 0;
  while (true) {
    const separator = path.includes('?') ? '&' : '?';
    const page = await spotifyApi<any>(clientId, `${path}${separator}limit=50&offset=${offset}`);
    const items = Array.isArray(page?.items) ? page.items : [];
    all.push(...items);
    if (!page?.next || items.length === 0) break;
    offset += items.length;
  }
  return all;
}

export async function listSpotifyImportSources(
  clientId: string,
  knownProfile?: SpotifyProfile | null
): Promise<SpotifyImportSource[]> {
  const profile = knownProfile || (await getSpotifyProfile(clientId));
  const [saved, playlistRows] = await Promise.all([
    spotifyApi<any>(clientId, '/me/tracks?limit=1&offset=0'),
    pagedItems(clientId, '/me/playlists')
  ]);

  const sources: SpotifyImportSource[] = [
    {
      id: 'saved',
      kind: 'saved',
      name: 'Любимые треки',
      total: Number(saved?.total) || 0,
      owner: profile.displayName,
      externalUrl: 'https://open.spotify.com/collection/tracks',
      importable: true
    }
  ];

  for (const playlist of playlistRows) {
    const ownerId = String(playlist?.owner?.id || '');
    const collaborative = playlist?.collaborative === true;
    const importable = ownerId === profile.id || collaborative;
    sources.push({
      id: String(playlist?.id || ''),
      kind: 'playlist',
      name: String(playlist?.name || 'Без названия'),
      total: Number(playlist?.items?.total ?? playlist?.tracks?.total) || 0,
      owner: String(playlist?.owner?.display_name || 'Spotify'),
      externalUrl: String(playlist?.external_urls?.spotify || ''),
      importable,
      unavailableReason: importable ? undefined : 'Spotify не отдаёт треки чужих подписок'
    });
  }
  return sources.filter((source) => source.id);
}

function mapSeed(item: any): SpotifyTrackSeed | null {
  const track = item?.item ?? item?.track ?? item;
  if (!track || track.type !== 'track' || !track.id || !track.name) return null;
  const artists = (track.artists || []).map((artist: any) => String(artist?.name || '')).filter(Boolean);
  return {
    id: String(track.id),
    title: String(track.name),
    artists,
    durationMs: Number(track.duration_ms) || 0,
    externalUrl: String(track.external_urls?.spotify || '')
  };
}

async function loadSourceTracks(clientId: string, source: SpotifyImportSource): Promise<SpotifyTrackSeed[]> {
  const rows = source.kind === 'saved'
    ? await pagedItems(clientId, '/me/tracks')
    : await pagedItems(clientId, `/playlists/${encodeURIComponent(source.id)}/items`);
  return rows.map(mapSeed).filter((track): track is SpotifyTrackSeed => Boolean(track));
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('ru-RU')
    .replace(/\b(feat|ft)\.?\b/g, ' ')
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .trim();
}

function tokenSimilarity(left: string, right: string): number {
  const a = new Set(normalizeText(left).split(' ').filter(Boolean));
  const b = new Set(normalizeText(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap++;
  return (2 * overlap) / (a.size + b.size);
}

function scoreCandidate(seed: SpotifyTrackSeed, candidate: any): number {
  const seedTitle = normalizeText(seed.title);
  const candidateTitle = normalizeText(String(candidate?.title || ''));
  let titleScore = tokenSimilarity(seedTitle, candidateTitle) * 50;
  if (seedTitle === candidateTitle) titleScore = 55;
  else if (seedTitle.includes(candidateTitle) || candidateTitle.includes(seedTitle)) titleScore = Math.max(titleScore, 40);

  const seedArtists = seed.artists.map(normalizeText).filter(Boolean);
  const candidateArtists = (candidate?.artists?.length ? candidate.artists : [candidate?.artist])
    .map((artist: unknown) => normalizeText(String(artist || '')))
    .filter(Boolean);
  let artistScore = 0;
  for (const expected of seedArtists) {
    for (const actual of candidateArtists) {
      if (expected === actual) artistScore = Math.max(artistScore, 35);
      else if (expected.includes(actual) || actual.includes(expected)) artistScore = Math.max(artistScore, 27);
      else artistScore = Math.max(artistScore, tokenSimilarity(expected, actual) * 30);
    }
  }

  const duration = Number(candidate?.duration) || 0;
  const difference = duration && seed.durationMs ? Math.abs(duration - seed.durationMs) : Number.POSITIVE_INFINITY;
  const durationScore = difference <= 3000 ? 15 : difference <= 9000 ? 8 : 0;
  if (titleScore < 35 || artistScore < 12) return 0;
  return titleScore + artistScore + durationScore;
}

function bestMatch(seed: SpotifyTrackSeed, candidates: any[]): any | null {
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

async function matchTrack(seed: SpotifyTrackSeed, signal?: AbortSignal): Promise<any | null> {
  if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
  const query = `${seed.artists[0] || ''} ${seed.title}`.trim();
  const yandexToken = get(settings).yandexToken;
  if (yandexToken) {
    try {
      const yandex = await searchYandex(yandexToken, query, 8);
      const match = bestMatch(seed, yandex);
      if (match) return { ...match, importedFrom: 'spotify', spotifyId: seed.id, spotifyUrl: seed.externalUrl };
    } catch (error) {
      console.warn('[spotify-import] Yandex match failed', error);
    }
  }

  if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
  const soundcloud = await searchSoundCloud(query, 10);
  const match = bestMatch(seed, soundcloud);
  return match ? { ...match, importedFrom: 'spotify', spotifyId: seed.id, spotifyUrl: seed.externalUrl } : null;
}

function sameLocalTrack(left: any, right: any): boolean {
  if (left?.source && right?.source && left?.id != null && right?.id != null) {
    return left.source === right.source && String(left.id) === String(right.id);
  }
  return normalizeText(`${left?.artist} ${left?.title}`) === normalizeText(`${right?.artist} ${right?.title}`);
}

function uniqueTracks(tracks: any[]): any[] {
  const result: any[] = [];
  for (const track of tracks) if (!result.some((known) => sameLocalTrack(known, track))) result.push(track);
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

export async function importSpotifySources(
  clientId: string,
  selectedSources: SpotifyImportSource[],
  onProgress: (progress: SpotifyImportProgress) => void,
  signal?: AbortSignal
): Promise<SpotifyImportResult> {
  if (!selectedSources.length) throw new Error('Выбери хотя бы один раздел Spotify');
  const loaded = new Map<string, SpotifyTrackSeed[]>();
  let estimated = selectedSources.reduce((sum, source) => sum + source.total, 0);
  onProgress({ phase: 'fetching', total: estimated, current: 0, matched: 0, skipped: 0, currentTrack: 'Читаю Spotify…' });

  for (const source of selectedSources) {
    if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
    const tracks = await loadSourceTracks(clientId, source);
    if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
    loaded.set(source.id, tracks);
    onProgress({
      phase: 'fetching',
      total: estimated,
      current: [...loaded.values()].reduce((sum, list) => sum + list.length, 0),
      matched: 0,
      skipped: 0,
      currentTrack: source.name
    });
  }

  const work = selectedSources.flatMap((source) =>
    (loaded.get(source.id) || []).map((track, index) => ({ source, track, index }))
  );
  estimated = work.length;
  const matches = new Map<string, Array<any | null>>();
  for (const source of selectedSources) matches.set(source.id, Array((loaded.get(source.id) || []).length).fill(null));

  const cache = new Map<string, Promise<any | null>>();
  let current = 0;
  let matched = 0;
  let skipped = 0;
  onProgress({ phase: 'matching', total: estimated, current, matched, skipped, currentTrack: '' });

  await concurrent(work, 3, async ({ source, track, index }) => {
    if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
    const cacheKey = `${track.id}:${normalizeText(`${track.artists[0] || ''} ${track.title}`)}`;
    let pending = cache.get(cacheKey);
    if (!pending) {
      pending = matchTrack(track, signal);
      cache.set(cacheKey, pending);
    }
    const result = await pending;
    if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
    matches.get(source.id)![index] = result;
    current++;
    if (result) matched++;
    else skipped++;
    onProgress({
      phase: 'matching',
      total: estimated,
      current,
      matched,
      skipped,
      currentTrack: `${track.artists[0] || 'Неизвестный артист'} — ${track.title}`
    });
  });

  if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
  onProgress({ phase: 'saving', total: estimated, current, matched, skipped, currentTrack: 'Сохраняю медиатеку…' });
  let likedAdded = 0;
  const savedMatches = matches.get('saved')?.filter(Boolean) || [];
  if (savedMatches.length) {
    likedTracks.update((existing) => {
      const additions = savedMatches.filter((track) => !existing.some((known) => sameLocalTrack(known, track)));
      likedAdded = additions.length;
      return [...additions, ...existing];
    });
  }

  const playlistSources = selectedSources.filter((source) => source.kind === 'playlist');
  playlists.update((existing) => {
    const next = [...existing];
    for (const source of playlistSources) {
      const id = `spotify:${source.id}`;
      const importedTracks = matches.get(source.id)?.filter(Boolean) || [];
      const index = next.findIndex((playlist) => playlist.id === id);
      const currentTracks = index >= 0 ? next[index]?.tracks || [] : [];
      const value = {
        ...(index >= 0 ? next[index] : {}),
        id,
        title: source.name,
        tracks: uniqueTracks([...importedTracks, ...currentTracks]),
        origin: 'spotify',
        originId: source.id,
        originUrl: source.externalUrl,
        importedAt: Date.now()
      };
      if (index >= 0) next[index] = value;
      else next.push(value);
    }
    return next;
  });

  const result = {
    total: estimated,
    matched,
    skipped,
    likedAdded,
    playlistsImported: playlistSources.length
  };
  onProgress({ phase: 'done', total: estimated, current: estimated, matched, skipped, currentTrack: '' });
  return result;
}

function backupTrackSeed(value: any, fallbackId: string): MusicImportSeed | null {
  const source = value?.track && typeof value.track === 'object'
    ? value.track
    : value?.localTrack && typeof value.localTrack === 'object'
      ? value.localTrack
      : value;
  if (!source || typeof source !== 'object') return null;

  const title = String(
    source.trackName ?? source.track ?? source.name ?? source.title ?? value?.trackName ?? ''
  ).trim();
  const artistValue =
    source.artistName ?? source.artist ?? source.creator ?? value?.artistName ?? value?.artist ?? '';
  const artists = Array.isArray(source.artists)
    ? source.artists.map((artist: any) => String(artist?.name ?? artist ?? '').trim()).filter(Boolean)
    : String(artistValue)
        .split(/\s*(?:,|&|;| feat\.? | ft\.? )\s*/i)
        .map((artist) => artist.trim())
        .filter(Boolean);
  if (!title || !artists.length) return null;

  const uri = String(source.trackUri ?? source.uri ?? source.spotifyUri ?? value?.trackUri ?? '').trim();
  const spotifyId = uri.startsWith('spotify:track:') ? uri.slice('spotify:track:'.length) : '';
  const durationMs = Number(source.durationMs ?? source.duration_ms ?? source.msPlayed ?? 0) || 0;
  return {
    id: spotifyId || fallbackId,
    title,
    artists,
    durationMs,
    externalUrl: spotifyId ? `https://open.spotify.com/track/${spotifyId}` : ''
  };
}

function uniqueBackupSeeds(tracks: MusicImportSeed[]): MusicImportSeed[] {
  const seen = new Set<string>();
  return tracks.filter((track) => {
    const key = track.id || normalizeImportText(`${track.artists[0] || ''} ${track.title}`);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseSpotifyBackupFile(file: SpotifyBackupTextFile): MusicImportCollection[] {
  let root: any;
  try {
    root = JSON.parse(file.text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error(`${file.name}: Spotify-архив повреждён или это не JSON`);
  }

  const collections: MusicImportCollection[] = [];
  const playlistRows = Array.isArray(root?.playlists) ? root.playlists : [];
  for (const [playlistIndex, playlist] of playlistRows.entries()) {
    const name = String(playlist?.name || `Плейлист Spotify ${playlistIndex + 1}`).trim();
    const rows = Array.isArray(playlist?.items)
      ? playlist.items
      : Array.isArray(playlist?.tracks)
        ? playlist.tracks
        : [];
    const tracks = uniqueBackupSeeds(
      rows
        .map((row: any, index: number) => backupTrackSeed(row, `${file.name}:${playlistIndex}:${index}`))
        .filter((track: MusicImportSeed | null): track is MusicImportSeed => Boolean(track))
    );
    if (!tracks.length) continue;
    const stableFile = normalizeImportText(file.name.replace(/\.json$/i, '')).replace(/\s+/g, '-') || 'spotify';
    const stableName = normalizeImportText(name).replace(/\s+/g, '-') || `playlist-${playlistIndex + 1}`;
    collections.push({
      id: `backup-${stableFile}-${stableName}-${playlistIndex}`,
      kind: 'playlist',
      name,
      origin: 'spotify',
      tracks
    });
  }

  const libraryRows = Array.isArray(root?.tracks)
    ? root.tracks
    : Array.isArray(root?.library?.tracks)
      ? root.library.tracks
      : [];
  const liked = uniqueBackupSeeds(
    libraryRows
      .map((row: any, index: number) => backupTrackSeed(row, `${file.name}:liked:${index}`))
      .filter((track: MusicImportSeed | null): track is MusicImportSeed => Boolean(track))
  );
  if (liked.length) {
    collections.push({
      id: 'backup-liked',
      kind: 'liked',
      name: 'Любимые треки Spotify',
      origin: 'spotify',
      tracks: liked
    });
  }

  return collections;
}

/**
 * Импорт официального архива Spotify не обращается к Spotify Web API. Поэтому он
 * работает без Premium и developer-приложения: наружу уходят только поисковые запросы
 * к уже подключённым источникам Lomify, а содержимое JSON остаётся в WebView.
 */
export async function importSpotifyBackupFiles(
  files: SpotifyBackupTextFile[],
  onProgress: (progress: SpotifyImportProgress) => void,
  signal?: AbortSignal
): Promise<SpotifyImportResult> {
  if (!files.length) throw new Error('Выбери YourLibrary.json или Playlist*.json из архива Spotify');
  const collections: MusicImportCollection[] = [];
  let parsedTracks = 0;
  for (const [index, file] of files.entries()) {
    if (signal?.aborted) throw new DOMException('Импорт отменён', 'AbortError');
    const parsed = parseSpotifyBackupFile(file);
    collections.push(...parsed);
    parsedTracks += parsed.reduce((sum, collection) => sum + collection.tracks.length, 0);
    onProgress({
      phase: 'fetching',
      total: files.length,
      current: index + 1,
      matched: 0,
      skipped: 0,
      currentTrack: file.name
    });
  }
  if (!collections.length || !parsedTracks) {
    throw new Error('Треки не найдены. Выбери YourLibrary.json или файл Playlist*.json из раздела Account data.');
  }
  return importMusicCollections(collections, onProgress, signal);
}
