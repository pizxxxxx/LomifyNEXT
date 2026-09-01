import md5 from 'md5';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
const LASTFM_SESSION_KEY = 'lomifynext_lastfm_session';
const LASTFM_PENDING_KEY = 'lomifynext_lastfm_pending';
const LASTFM_OVERVIEW_KEY = 'lomifynext_lastfm_overview';
const AUTH_TOKEN_TTL_MS = 60 * 60 * 1000;
const OVERVIEW_CACHE_TTL_MS = 15 * 60 * 1000;

export const LASTFM_CREATE_APP_URL = 'https://www.last.fm/api/account/create';
export const LASTFM_TASTE_UPDATED_EVENT = 'lastfm:taste-updated';
export const LASTFM_CONFIGURED_API_KEY = String(import.meta.env.VITE_LASTFM_API_KEY || '').trim();
export const LASTFM_CONFIGURED_SHARED_SECRET = String(
  import.meta.env.VITE_LASTFM_SHARED_SECRET || ''
).trim();

export interface LastFmSession {
  apiKey: string;
  sharedSecret: string;
  sessionKey: string;
  username: string;
  subscriber: boolean;
  avatarUrl: string;
  profileUrl: string;
}

export interface LastFmAuthorization {
  authorizationUrl: string;
  expiresAt: number;
}

export interface LastFmRecentTrack {
  title: string;
  artist: string;
  album: string;
  imageUrl: string;
  url: string;
  playedAt: number;
  nowPlaying: boolean;
}

export interface LastFmTopArtist {
  name: string;
  playcount: number;
  url: string;
  imageUrl: string;
}

export interface LastFmTopTrack {
  title: string;
  artist: string;
  playcount: number;
  url: string;
  imageUrl: string;
}

export interface LastFmDiscoveryArtist {
  name: string;
  match: number;
  url: string;
  imageUrl: string;
}

export type LastFmReportPeriod = '7day' | '1month' | '12month' | 'overall';

export interface LastFmPeriodReport {
  artists: LastFmTopArtist[];
  tracks: LastFmTopTrack[];
}

export interface LastFmOverview {
  schemaVersion: number;
  username: string;
  playcount: number;
  registeredAt: number;
  nowPlayingTrack: LastFmRecentTrack | null;
  recentTracks: LastFmRecentTrack[];
  topArtists: LastFmTopArtist[];
  reports: Record<LastFmReportPeriod, LastFmPeriodReport>;
  discoveryArtists: LastFmDiscoveryArtist[];
  knownTracks: Array<{ title: string; artist: string }>;
  updatedAt: number;
}

interface LastFmPendingAuthorization {
  apiKey: string;
  sharedSecret: string;
  token: string;
  createdAt: number;
}

interface ScrobbleTrack {
  id?: string | number;
  urn?: string;
  title?: string;
  artist?: string;
  album?: string;
  albumTitle?: string;
  source?: string;
  publisher_metadata?: { album_title?: string };
}

interface ActiveScrobble {
  key: string;
  artist: string;
  title: string;
  album: string;
  duration: number;
  startedAt: number;
  lastPosition: number;
  listenedSeconds: number;
  sent: boolean;
}

let activeScrobble: ActiveScrobble | null = null;

function browserStorage(): Storage | null {
  return typeof window === 'undefined' ? null : window.localStorage;
}

function readJson<T>(key: string): T | null {
  const raw = browserStorage()?.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown) {
  browserStorage()?.setItem(key, JSON.stringify(value));
}

function emitLastFmStateChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(LASTFM_TASTE_UPDATED_EVENT));
}

export function getLastFmSession(): LastFmSession | null {
  const value = readJson<LastFmSession>(LASTFM_SESSION_KEY);
  if (!value?.apiKey || !value.sharedSecret || !value.sessionKey || !value.username) return null;
  return value;
}

export function hasPendingLastFmAuthorization(): boolean {
  const pending = readJson<LastFmPendingAuthorization>(LASTFM_PENDING_KEY);
  if (!pending) return false;
  if (Date.now() - pending.createdAt < AUTH_TOKEN_TTL_MS) return true;
  browserStorage()?.removeItem(LASTFM_PENDING_KEY);
  return false;
}

export function disconnectLastFm() {
  browserStorage()?.removeItem(LASTFM_SESSION_KEY);
  browserStorage()?.removeItem(LASTFM_PENDING_KEY);
  browserStorage()?.removeItem(LASTFM_OVERVIEW_KEY);
  activeScrobble = null;
  emitLastFmStateChanged();
}

async function lastFmHttp(url: string, init?: RequestInit): Promise<Response> {
  try {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      return await tauriFetch(url, init);
    }
    return await window.fetch(url, init);
  } catch {
    throw new Error(
      'Нет связи с Last.fm. Сервис может быть недоступен с российского IP — проверь VPN или прокси.'
    );
  }
}

function signature(params: Record<string, string>, sharedSecret: string): string {
  const payload = Object.entries(params)
    .filter(([key]) => key !== 'format' && key !== 'callback')
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${value}`)
    .join('');
  return md5(`${payload}${sharedSecret}`);
}

function lastFmError(body: any): Error {
  const code = Number(body?.error || 0);
  if (code === 4 || code === 9) return new Error('Last.fm отклонил сессию. Подключи аккаунт заново.');
  if (code === 14) return new Error('Last.fm ещё не получил разрешение. Подтверди доступ в браузере и повтори.');
  if (code === 10 || code === 13 || code === 26) return new Error('Last.fm временно недоступен. Попробуй чуть позже.');
  return new Error(String(body?.message || 'Last.fm не смог выполнить запрос.'));
}

async function apiRequest<T>(
  method: string,
  params: Record<string, string>,
  apiKey: string,
  sharedSecret?: string,
  usePost = false
): Promise<T> {
  const signedParams: Record<string, string> = { method, api_key: apiKey, ...params };
  if (sharedSecret) signedParams.api_sig = signature(signedParams, sharedSecret);
  const requestParams = new URLSearchParams({ ...signedParams, format: 'json' });
  const response = await lastFmHttp(usePost ? LASTFM_API_URL : `${LASTFM_API_URL}?${requestParams}`, usePost
    ? {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: requestParams.toString()
      }
    : undefined);

  if (response.status === 403) {
    throw new Error(
      'Last.fm отклонил подключение (ошибка 403). В России сервис может не работать без VPN или прокси.'
    );
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    throw new Error('Last.fm вернул непонятный ответ. Попробуй позже.');
  }
  if (!response.ok || body?.error) throw lastFmError(body);
  return body as T;
}

function validateCredentials(apiKeyRaw: string, sharedSecretRaw: string) {
  const apiKey = apiKeyRaw.trim();
  const sharedSecret = sharedSecretRaw.trim();
  if (!/^[a-f0-9]{32}$/i.test(apiKey)) throw new Error('API key Last.fm должен состоять из 32 символов.');
  if (!/^[a-f0-9]{32}$/i.test(sharedSecret)) throw new Error('Shared secret Last.fm должен состоять из 32 символов.');
  return { apiKey, sharedSecret };
}

export async function beginLastFmAuthorization(
  apiKeyRaw: string,
  sharedSecretRaw: string
): Promise<LastFmAuthorization> {
  const { apiKey, sharedSecret } = validateCredentials(apiKeyRaw, sharedSecretRaw);
  const body = await apiRequest<{ token?: string }>('auth.getToken', {}, apiKey, sharedSecret);
  if (!body.token) throw new Error('Last.fm не вернул код подтверждения.');

  const pending: LastFmPendingAuthorization = {
    apiKey,
    sharedSecret,
    token: body.token,
    createdAt: Date.now()
  };
  writeJson(LASTFM_PENDING_KEY, pending);
  return {
    authorizationUrl: `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(body.token)}`,
    expiresAt: pending.createdAt + AUTH_TOKEN_TTL_MS
  };
}

function profileFromResponse(body: any, fallbackName: string): Pick<LastFmSession, 'username' | 'subscriber' | 'avatarUrl' | 'profileUrl'> {
  const user = body?.user || {};
  const images = Array.isArray(user.image) ? user.image : [];
  const avatarUrl = [...images]
    .reverse()
    .map((image: any) => String(image?.['#text'] || ''))
    .find(Boolean) || '';
  const username = String(user.name || fallbackName);
  return {
    username,
    subscriber: String(user.subscriber || '0') === '1',
    avatarUrl,
    profileUrl: String(user.url || `https://www.last.fm/user/${encodeURIComponent(username)}`)
  };
}

export async function finishLastFmAuthorization(): Promise<LastFmSession> {
  const pending = readJson<LastFmPendingAuthorization>(LASTFM_PENDING_KEY);
  if (!pending || Date.now() - pending.createdAt >= AUTH_TOKEN_TTL_MS) {
    browserStorage()?.removeItem(LASTFM_PENDING_KEY);
    throw new Error('Код подтверждения Last.fm истёк. Начни подключение ещё раз.');
  }

  const result = await apiRequest<any>(
    'auth.getSession',
    { token: pending.token },
    pending.apiKey,
    pending.sharedSecret
  );
  const sessionKey = String(result?.session?.key || '');
  const username = String(result?.session?.name || '');
  if (!sessionKey || !username) throw new Error('Last.fm не вернул сессию аккаунта.');

  let session: LastFmSession = {
    apiKey: pending.apiKey,
    sharedSecret: pending.sharedSecret,
    sessionKey,
    username,
    subscriber: String(result?.session?.subscriber || '0') === '1',
    avatarUrl: '',
    profileUrl: `https://www.last.fm/user/${encodeURIComponent(username)}`
  };
  writeJson(LASTFM_SESSION_KEY, session);
  browserStorage()?.removeItem(LASTFM_PENDING_KEY);
  emitLastFmStateChanged();

  // Токен авторизации одноразовый, поэтому рабочую сессию сохраняем до необязательного
  // запроса аватара. Если профиль временно не загрузился, человек всё равно не должен
  // проходить вход заново — скробблинг уже может работать.
  try {
    const profileBody = await apiRequest<any>('user.getInfo', { user: username }, pending.apiKey);
    session = { ...session, ...profileFromResponse(profileBody, username) };
    writeJson(LASTFM_SESSION_KEY, session);
  } catch (error) {
    console.warn('[last.fm] профиль не загрузился после авторизации', error);
  }
  return session;
}

export async function refreshLastFmProfile(): Promise<LastFmSession> {
  const session = getLastFmSession();
  if (!session) throw new Error('Сначала подключи Last.fm.');
  const body = await apiRequest<any>('user.getInfo', { user: session.username }, session.apiKey);
  const refreshed = { ...session, ...profileFromResponse(body, session.username) };
  writeJson(LASTFM_SESSION_KEY, refreshed);
  return refreshed;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

function largestImage(images: any): string {
  return asArray<any>(images)
    .map((image) => String(image?.['#text'] || '').trim())
    .filter(Boolean)
    .at(-1) || '';
}

function emptyReport(): LastFmPeriodReport {
  return { artists: [], tracks: [] };
}

function normalizeOverview(value: LastFmOverview): LastFmOverview {
  const monthlyArtists = Array.isArray(value.topArtists) ? value.topArtists : [];
  const reports = value.reports || ({} as Record<LastFmReportPeriod, LastFmPeriodReport>);
  const recentTracks = Array.isArray(value.recentTracks) ? value.recentTracks : [];
  return {
    ...value,
    schemaVersion: Number(value.schemaVersion || 1),
    nowPlayingTrack: value.nowPlayingTrack || recentTracks.find((track) => track.nowPlaying) || null,
    recentTracks: recentTracks.filter((track) => !track.nowPlaying),
    topArtists: monthlyArtists,
    reports: {
      '7day': reports['7day'] || emptyReport(),
      '1month': reports['1month'] || { artists: monthlyArtists, tracks: [] },
      '12month': reports['12month'] || emptyReport(),
      overall: reports.overall || emptyReport()
    },
    discoveryArtists: Array.isArray(value.discoveryArtists) ? value.discoveryArtists : [],
    knownTracks: Array.isArray(value.knownTracks)
      ? value.knownTracks
      : recentTracks.filter((track) => !track.nowPlaying).map((track) => ({ title: track.title, artist: track.artist }))
  };
}

export function getCachedLastFmOverview(): LastFmOverview | null {
  const session = getLastFmSession();
  const overview = readJson<LastFmOverview>(LASTFM_OVERVIEW_KEY);
  if (!session || !overview || overview.username !== session.username) return null;
  return normalizeOverview(overview);
}

/**
 * Public Last.fm data is useful outside the settings card too: the home feed uses the
 * monthly favourites as a small extra taste signal. This function deliberately stays
 * synchronous and cache-only so opening the home page never adds three network calls.
 */
export function getCachedLastFmTasteArtists(): LastFmTopArtist[] {
  const overview = getCachedLastFmOverview();
  if (!overview) return [];
  const result: LastFmTopArtist[] = [];
  const seen = new Set<string>();
  for (const artist of [...overview.reports['1month'].artists, ...overview.reports.overall.artists]) {
    const key = artist.name.toLocaleLowerCase('ru-RU').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(artist);
  }
  return result;
}

export function getCachedLastFmDiscoveryArtists(): LastFmDiscoveryArtist[] {
  return getCachedLastFmOverview()?.discoveryArtists || [];
}

export function getCachedLastFmKnownTracks(): Array<{ title: string; artist: string }> {
  return getCachedLastFmOverview()?.knownTracks || [];
}

function topArtistsFromResponse(body: any): LastFmTopArtist[] {
  return asArray<any>(body?.topartists?.artist).map((artist) => ({
    name: String(artist?.name || 'Неизвестный исполнитель'),
    playcount: Math.max(0, Number(artist?.playcount || 0)),
    url: String(artist?.url || ''),
    imageUrl: largestImage(artist?.image)
  }));
}

function topTracksFromResponse(body: any): LastFmTopTrack[] {
  return asArray<any>(body?.toptracks?.track).map((track) => ({
    title: String(track?.name || 'Без названия'),
    artist: String(track?.artist?.name || track?.artist?.['#text'] || 'Неизвестный исполнитель'),
    playcount: Math.max(0, Number(track?.playcount || 0)),
    url: String(track?.url || ''),
    imageUrl: largestImage(track?.image)
  }));
}

export async function getLastFmOverview(force = false): Promise<LastFmOverview> {
  const session = getLastFmSession();
  if (!session) throw new Error('Сначала подключи Last.fm.');

  const cached = getCachedLastFmOverview();
  if (!force && cached?.schemaVersion === 2 && Date.now() - cached.updatedAt < OVERVIEW_CACHE_TTL_MS) return cached;

  const periods: LastFmReportPeriod[] = ['7day', '1month', '12month', 'overall'];
  const [profileBody, recentBody, ...chartBodies] = await Promise.all([
    apiRequest<any>('user.getInfo', { user: session.username }, session.apiKey),
    apiRequest<any>('user.getRecentTracks', { user: session.username, limit: '200', extended: '0' }, session.apiKey),
    ...periods.flatMap((period) => [
      apiRequest<any>('user.getTopArtists', { user: session.username, period, limit: '12' }, session.apiKey),
      apiRequest<any>('user.getTopTracks', { user: session.username, period, limit: '12' }, session.apiKey)
    ])
  ]);

  const profile = profileFromResponse(profileBody, session.username);
  const refreshedSession = { ...session, ...profile };
  writeJson(LASTFM_SESSION_KEY, refreshedSession);

  const user = profileBody?.user || {};
  const fetchedTracks = asArray<any>(recentBody?.recenttracks?.track).map((track) => ({
    title: String(track?.name || 'Без названия'),
    artist: String(track?.artist?.['#text'] || track?.artist?.name || 'Неизвестный исполнитель'),
    album: String(track?.album?.['#text'] || ''),
    imageUrl: largestImage(track?.image),
    url: String(track?.url || ''),
    playedAt: Math.max(0, Number(track?.date?.uts || 0) * 1000),
    nowPlaying: String(track?.['@attr']?.nowplaying || '') === 'true'
  }));
  const reports = {} as Record<LastFmReportPeriod, LastFmPeriodReport>;
  periods.forEach((period, index) => {
    reports[period] = {
      artists: topArtistsFromResponse(chartBodies[index * 2]),
      tracks: topTracksFromResponse(chartBodies[index * 2 + 1])
    };
  });

  // Два устойчивых любимых исполнителя дают рекомендации, но не превращают обновление
  // профиля в десятки запросов. Результаты объединяются и кэшируются на 15 минут.
  const discoveryBodies = await Promise.all(
    reports['1month'].artists.slice(0, 2).map((artist) =>
      apiRequest<any>('artist.getSimilar', { artist: artist.name, autocorrect: '1', limit: '8' }, session.apiKey)
        .catch((error) => {
          console.warn(`[last.fm] похожие на ${artist.name} не загрузились`, error);
          return null;
        })
    )
  );
  const seedNames = new Set(reports['1month'].artists.map((artist) => artist.name.toLocaleLowerCase('ru-RU').trim()));
  const discoveryMap = new Map<string, LastFmDiscoveryArtist>();
  for (const body of discoveryBodies) {
    for (const artist of asArray<any>(body?.similarartists?.artist)) {
      const name = String(artist?.name || '').trim();
      const key = name.toLocaleLowerCase('ru-RU');
      if (!key || seedNames.has(key)) continue;
      const candidate: LastFmDiscoveryArtist = {
        name,
        match: Math.max(0, Math.min(1, Number(artist?.match || 0))),
        url: String(artist?.url || ''),
        imageUrl: largestImage(artist?.image)
      };
      const previous = discoveryMap.get(key);
      if (!previous || candidate.match > previous.match) discoveryMap.set(key, candidate);
    }
  }
  const discoveryArtists = [...discoveryMap.values()].sort((a, b) => b.match - a.match).slice(0, 10);

  const nowPlayingTrack = fetchedTracks.find((track) => track.nowPlaying) || null;
  const recentTracks = fetchedTracks.filter((track) => !track.nowPlaying);
  const knownMap = new Map<string, { title: string; artist: string }>();
  const rememberTrack = (track: { title: string; artist: string }) => {
    const key = `${track.title}\u0000${track.artist}`.toLocaleLowerCase('ru-RU').trim();
    if (key && !knownMap.has(key)) knownMap.set(key, { title: track.title, artist: track.artist });
  };
  recentTracks.forEach(rememberTrack);
  periods.forEach((period) => reports[period].tracks.forEach(rememberTrack));
  const topArtists = reports['1month'].artists;

  const overview: LastFmOverview = {
    schemaVersion: 2,
    username: refreshedSession.username,
    playcount: Math.max(0, Number(user.playcount || 0)),
    registeredAt: Math.max(0, Number(user?.registered?.unixtime || user?.registered?.['#text'] || 0) * 1000),
    nowPlayingTrack,
    recentTracks: recentTracks.slice(0, 6),
    topArtists,
    reports,
    discoveryArtists,
    knownTracks: [...knownMap.values()],
    updatedAt: Date.now()
  };
  writeJson(LASTFM_OVERVIEW_KEY, overview);
  emitLastFmStateChanged();
  return overview;
}

function trackKey(track: ScrobbleTrack): string {
  return [track.source || '', track.urn || track.id || '', track.artist || '', track.title || ''].join(':');
}

function normalizedTrack(track: ScrobbleTrack) {
  return {
    key: trackKey(track),
    artist: String(track.artist || '').trim(),
    title: String(track.title || '').trim(),
    album: String(track.album || track.albumTitle || track.publisher_metadata?.album_title || '').trim()
  };
}

async function signedWrite(method: string, values: Record<string, string>) {
  const session = getLastFmSession();
  if (!session) return;
  await apiRequest(method, { ...values, sk: session.sessionKey }, session.apiKey, session.sharedSecret, true);
}

export function beginLastFmTrack(track: ScrobbleTrack, durationSeconds: number) {
  const session = getLastFmSession();
  const normalized = normalizedTrack(track);
  if (!session || !normalized.artist || !normalized.title) {
    activeScrobble = null;
    return;
  }

  activeScrobble = {
    ...normalized,
    duration: Math.max(0, Math.round(durationSeconds || 0)),
    startedAt: Math.floor(Date.now() / 1000),
    lastPosition: 0,
    listenedSeconds: 0,
    sent: false
  };

  const values: Record<string, string> = { artist: normalized.artist, track: normalized.title };
  if (normalized.album) values.album = normalized.album;
  if (activeScrobble.duration > 0) values.duration = String(activeScrobble.duration);
  void signedWrite('track.updateNowPlaying', values).catch((error) => {
    console.warn('[last.fm] now playing не отправлен', error);
  });
}

export function tickLastFmTrack(
  track: ScrobbleTrack,
  positionSeconds: number,
  durationSeconds: number,
  playing: boolean
) {
  const active = activeScrobble;
  if (!active || active.key !== trackKey(track) || active.sent) return;

  const position = Math.max(0, Number(positionSeconds) || 0);
  const delta = position - active.lastPosition;
  active.lastPosition = position;
  if (playing && delta > 0 && delta <= 3.5) active.listenedSeconds += delta;

  const knownDuration = Math.max(active.duration, Math.round(durationSeconds || 0));
  active.duration = knownDuration;
  if (knownDuration > 0 && knownDuration <= 30) return;
  const threshold = knownDuration > 0 ? Math.min(knownDuration / 2, 240) : 240;
  if (active.listenedSeconds < threshold) return;

  active.sent = true;
  const values: Record<string, string> = {
    artist: active.artist,
    track: active.title,
    timestamp: String(active.startedAt)
  };
  if (active.album) values.album = active.album;
  if (active.duration > 0) values.duration = String(active.duration);
  void signedWrite('track.scrobble', values).catch((error) => {
    // Не дублируем скроббл при каждом следующем тике. Следующая попытка будет с новым треком.
    console.warn('[last.fm] скроббл не отправлен', error);
  });
}
