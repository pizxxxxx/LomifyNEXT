import { invoke, isTauri } from '@tauri-apps/api/core';
import { rememberSecret } from './logRedaction';
import { LEGACY_RECORDS, legacySecrets, migrateRecord, readLegacyRecord, withoutSecretFields, type SecretName } from './secretMigration';

export type SecretKey = SecretName;
export const SECRETS_READY_EVENT = 'lomify:secrets-ready';
const cache = new Map<SecretKey, string>();
const present = new Set<SecretKey>();
let bootstrap: Promise<void> | null = null;
let ready = false;
let operationTail: Promise<unknown> = Promise.resolve();
const startupErrors: string[] = [];

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation);
  operationTail = result.catch(() => {});
  return result;
}

async function rawRead(key: SecretKey): Promise<string | null> {
  requireDesktop();
  const value = await invoke<string | null>('secret_get', { key });
  if (value) rememberSecret(value);
  return value;
}
async function rawSave(key: SecretKey, value: string): Promise<void> {
  rememberSecret(value);
  requireDesktop();
  await invoke('secret_save', { key, value });
}

export function cachedSecret(key: SecretKey): string { return ready ? cache.get(key) || '' : ''; }
export function hasSecret(key: SecretKey): boolean { return ready && present.has(key); }

export async function refreshSecretPresence(keys: SecretKey[]): Promise<void> {
  for (const key of keys) {
    if (await invoke<boolean>('secret_exists', { key })) present.add(key);
    else present.delete(key);
  }
}
export function secretStartupErrors(): string[] { return [...startupErrors]; }

export function settingsSecretsRemoved(): boolean {
  if (!ready || typeof localStorage === 'undefined') return false;
  try {
    return legacySecrets(readLegacyRecord(localStorage, LEGACY_RECORDS[0].storageKey), LEGACY_RECORDS[0].fields).size === 0;
  } catch { return false; }
}

export function publicSettings<T>(settings: T): T {
  return withoutSecretFields(settings, LEGACY_RECORDS[0].fields);
}

export function whenSecretsReady(): Promise<void> {
  if (bootstrap) return bootstrap;
  bootstrap = (async () => {
    if (typeof localStorage === 'undefined') return;
    try { requireDesktop(); await invoke('secret_migrate_legacy'); }
    catch { startupErrors.push('Перенос старых файлов аккаунта не завершён. Неудалённые копии сохранены.'); }
    const fallback = new Map<SecretKey, string>();
    const failedKeys = new Set<SecretKey>();
    for (const record of LEGACY_RECORDS) {
      try {
        const old = legacySecrets(readLegacyRecord(localStorage, record.storageKey), record.fields);
        for (const [key, value] of old) { rememberSecret(value); fallback.set(key, value); }
        // secret_save verifies private Last.fm values natively; they are never read back into JS.
        await migrateRecord(localStorage, { save: rawSave, read: async (key) => key.startsWith('lastfm_')
          ? (await invoke<boolean>('secret_exists', { key }) ? old.get(key) || null : null) : rawRead(key)
        }, record.storageKey, record.fields);
      } catch {
        for (const field of record.fields) failedKeys.add(field.key);
        startupErrors.push(`Перенос ${record.storageKey} не завершён. Старая копия сохранена.`);
      }
    }
    for (const key of new Set(LEGACY_RECORDS.flatMap((record) => record.fields.map((field) => field.key)))) {
      try {
        if (key.startsWith('lastfm_')) {
          if (failedKeys.has(key) && fallback.has(key)) present.add(key);
          else await refreshSecretPresence([key]);
          continue;
        }
        const value = failedKeys.has(key) && fallback.has(key) ? fallback.get(key)! : await rawRead(key);
        if (value) { cache.set(key, value); present.add(key); }
      } catch {
        if (fallback.has(key)) { cache.set(key, fallback.get(key)!); present.add(key); }
        startupErrors.push('Не удалось загрузить секрет из системного хранилища. Подключение аккаунта не изменено.');
      }
    }
    ready = true;
    window.dispatchEvent(new CustomEvent(SECRETS_READY_EVENT));
    window.dispatchEvent(new CustomEvent('lastfm:taste-updated'));
  })();
  return bootstrap;
}

function removeVerifiedLegacyFields(keys: SecretKey[]): void {
  for (const record of LEGACY_RECORDS) {
    const fields = record.fields.filter((field) => keys.includes(field.key));
    if (!fields.length) continue;
    const value = readLegacyRecord(localStorage, record.storageKey);
    if (value) localStorage.setItem(record.storageKey, JSON.stringify(withoutSecretFields(value, fields)));
  }
}

function requireDesktop(): void {
  if (!isTauri()) throw new Error('Системное хранилище доступно в приложении LomifyNEXT');
}

export async function saveSecret(key: SecretKey, value: string): Promise<void> {
  await saveSecrets({ [key]: value });
}

export async function saveSecrets(values: Partial<Record<SecretKey, string>>): Promise<void> {
  await whenSecretsReady();
  return serialized(async () => {
    const entries = Object.entries(values) as [SecretKey, string][];
    for (const [key, value] of entries) {
      await rawSave(key, value);
      if (key.startsWith('lastfm_')) {
        if (!await invoke<boolean>('secret_exists', { key })) throw new Error('Проверка сохранения секрета не прошла');
      } else if (await rawRead(key) !== value) throw new Error('Проверка сохранения секрета не прошла');
    }
    removeVerifiedLegacyFields(entries.map(([key]) => key));
    for (const [key, value] of entries) { present.add(key); if (!key.startsWith('lastfm_')) cache.set(key, value); }
  });
}

export async function getSecret(key: SecretKey): Promise<string | null> {
  await whenSecretsReady();
  return serialized(() => rawRead(key));
}

export async function deleteSecret(key: SecretKey): Promise<void> {
  await deleteSecrets([key]);
}

export async function deleteSecrets(keys: SecretKey[]): Promise<void> {
  await whenSecretsReady();
  return serialized(async () => {
    requireDesktop();
    for (const key of keys) await invoke('secret_delete', { key });
    removeVerifiedLegacyFields(keys);
    for (const key of keys) { cache.delete(key); present.delete(key); }
  });
}

export async function deleteAllSecrets(): Promise<void> {
  await deleteSecrets([...new Set(LEGACY_RECORDS.flatMap((record) => record.fields.map((field) => field.key)))]);
  await clearLegacySecrets();
}

export async function clearLegacySecrets(): Promise<void> {
  await whenSecretsReady();
  requireDesktop();
  await invoke('secret_clear_legacy');
}
