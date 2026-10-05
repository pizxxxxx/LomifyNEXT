import { invoke, isTauri } from '@tauri-apps/api/core';

export type SecretKey =
  | 'yandex_music_token' | 'spotify_access_token' | 'spotify_refresh_token'
  | 'lastfm_shared_secret' | 'lastfm_session_key' | 'lastfm_auth_token'
  | 'lastfm_pending_shared_secret';

function requireDesktop(): void {
  if (!isTauri()) throw new Error('Системное хранилище доступно в приложении LomifyNEXT');
}

export async function saveSecret(key: SecretKey, value: string): Promise<void> {
  requireDesktop();
  await invoke('secret_save', { key, value });
}

export async function getSecret(key: SecretKey): Promise<string | null> {
  requireDesktop();
  return invoke<string | null>('secret_get', { key });
}

export async function deleteSecret(key: SecretKey): Promise<void> {
  requireDesktop();
  await invoke('secret_delete', { key });
}
