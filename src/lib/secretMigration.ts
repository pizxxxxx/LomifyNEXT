export type SecretName =
  | 'yandex_music_token' | 'spotify_access_token' | 'spotify_refresh_token'
  | 'lastfm_shared_secret' | 'lastfm_session_key' | 'lastfm_auth_token'
  | 'lastfm_pending_shared_secret';

export interface MigrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export interface MigrationVault {
  save(key: SecretName, value: string): Promise<void>;
  read(key: SecretName): Promise<string | null>;
}
export interface SecretField { path: string[]; key: SecretName }

export const LEGACY_RECORDS: Array<{ storageKey: string; fields: SecretField[] }> = [
  { storageKey: 'lomifynext_settings', fields: [
    { path: ['yandexToken'], key: 'yandex_music_token' },
    { path: ['spotifyAccessToken'], key: 'spotify_access_token' },
    { path: ['spotifyRefreshToken'], key: 'spotify_refresh_token' },
    { path: ['lastfmSharedSecret'], key: 'lastfm_shared_secret' },
    { path: ['lastfmSessionKey'], key: 'lastfm_session_key' },
    { path: ['spotify', 'accessToken'], key: 'spotify_access_token' },
    { path: ['spotify', 'refreshToken'], key: 'spotify_refresh_token' },
    { path: ['lastfm', 'sharedSecret'], key: 'lastfm_shared_secret' },
    { path: ['lastfm', 'sessionKey'], key: 'lastfm_session_key' }
  ] },
  { storageKey: 'lomifynext_spotify_session', fields: [
    { path: ['accessToken'], key: 'spotify_access_token' },
    { path: ['refreshToken'], key: 'spotify_refresh_token' }
  ] },
  { storageKey: 'lomifynext_lastfm_session', fields: [
    { path: ['sharedSecret'], key: 'lastfm_shared_secret' },
    { path: ['sessionKey'], key: 'lastfm_session_key' }
  ] },
  { storageKey: 'lomifynext_lastfm_pending', fields: [
    { path: ['sharedSecret'], key: 'lastfm_pending_shared_secret' },
    { path: ['token'], key: 'lastfm_auth_token' }
  ] }
];

function fieldValue(record: any, path: string[]): unknown {
  return path.reduce((value, key) => value?.[key], record);
}

function removeField(record: any, path: string[]): void {
  const parent = fieldValue(record, path.slice(0, -1));
  if (parent && typeof parent === 'object') delete (parent as Record<string, unknown>)[path[path.length - 1]];
}

export function withoutSecretFields<T>(record: T, fields: SecretField[]): T {
  const clean = JSON.parse(JSON.stringify(record));
  for (const field of fields) removeField(clean, field.path);
  return clean;
}

export function readLegacyRecord(storage: MigrationStorage, storageKey: string): any {
  const raw = storage.getItem(storageKey);
  if (!raw) return null;
  const record = JSON.parse(raw);
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Некорректные сохранённые данные аккаунта');
  return record;
}

export function legacySecrets(record: any, fields: SecretField[]): Map<SecretName, string> {
  const values = new Map<SecretName, string>();
  for (const field of fields) {
    const value = fieldValue(record, field.path);
    if (typeof value === 'string' && value) values.set(field.key, value);
    else if (value != null && value !== '') throw new Error('Некорректное сохранённое значение секрета');
  }
  return values;
}

export async function migrateRecord(
  storage: MigrationStorage, vault: MigrationVault, storageKey: string, fields: SecretField[]
): Promise<Map<SecretName, string>> {
  const record = readLegacyRecord(storage, storageKey);
  if (!record) return new Map();
  const values = legacySecrets(record, fields);
  for (const [key, value] of values) {
    await vault.save(key, value);
    if (await vault.read(key) !== value) throw new Error('Проверка переноса секрета не прошла');
  }
  // Keep the original byte-for-byte until every credential has been verified.
  // A failed storage write also leaves the original source available for retry.
  if (fields.some((field) => fieldValue(record, field.path) !== undefined)) {
    storage.setItem(storageKey, JSON.stringify(withoutSecretFields(record, fields)));
  }
  return values;
}
