import { writable, get } from 'svelte/store';
import { APP_VERSION } from './version';
import { safeFetch } from './api';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'up_to_date'
  | 'error';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface ReleaseInfo {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  assets: ReleaseAsset[];
}

export interface UpdateDetails {
  version: string;
  releaseName: string;
  releaseNotes: string;
  exeUrl: string;
  exeName: string;
  size: number;
}

export interface DownloadProgressPayload {
  downloaded: number;
  total: number;
  percent: number;
}

export const updateStatus = writable<UpdateStatus>('idle');
export const updateInfo = writable<UpdateDetails | null>(null);
export const downloadProgress = writable<DownloadProgressPayload>({ downloaded: 0, total: 0, percent: 0 });
export const downloadedInstallerPath = writable<string>('');
export const updateErrorMessage = writable<string>('');

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/pizxxxxx/LomifyNEXT/releases/latest';

export function parseSemver(v: string): number[] {
  const clean = v.replace(/^v/i, '').trim();
  const parts = clean.split('.').map((p) => {
    const num = parseInt(p, 10);
    return Number.isFinite(num) ? num : 0;
  });
  while (parts.length < 3) parts.push(0);
  return parts;
}

export function isNewerVersion(remoteTag: string, localVersion: string): boolean {
  const remote = parseSemver(remoteTag);
  const local = parseSemver(localVersion);
  for (let i = 0; i < Math.max(remote.length, local.length); i++) {
    const r = remote[i] || 0;
    const l = local[i] || 0;
    if (r > l) return true;
    if (r < l) return false;
  }
  return false;
}

let isChecking = false;
let isDownloading = false;
let unlistenProgress: (() => void) | null = null;

export async function checkForUpdates(autoDownload = true): Promise<UpdateDetails | null> {
  if (isChecking || isDownloading) return get(updateInfo);
  isChecking = true;
  updateStatus.set('checking');
  updateErrorMessage.set('');

  try {
    const res = await safeFetch(GITHUB_RELEASES_URL, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'LomifyNEXT-Updater'
      }
    });

    if (!res.ok) {
      throw new Error(`GitHub API вернул статус ${res.status}`);
    }

    const release = (await res.json()) as ReleaseInfo;
    const remoteTag = release.tag_name || '';
    const remoteVer = remoteTag.replace(/^v/i, '');

    if (!isNewerVersion(remoteTag, APP_VERSION)) {
      updateStatus.set('up_to_date');
      isChecking = false;
      return null;
    }

    // Ищем исполняемый установщик .exe
    const exeAsset = release.assets?.find((a) =>
      a.name.toLowerCase().endsWith('.exe') && !a.name.toLowerCase().includes('debug')
    ) || release.assets?.find((a) => a.name.toLowerCase().endsWith('.exe'));

    if (!exeAsset) {
      // Релиз есть, но exe-файла в ассетах нет
      updateStatus.set('up_to_date');
      isChecking = false;
      return null;
    }

    const details: UpdateDetails = {
      version: remoteVer,
      releaseName: release.name || `Релиз v${remoteVer}`,
      releaseNotes: release.body || '',
      exeUrl: exeAsset.browser_download_url,
      exeName: exeAsset.name,
      size: exeAsset.size || 0
    };

    updateInfo.set(details);
    updateStatus.set('available');
    isChecking = false;

    if (autoDownload) {
      void startDownload(details);
    }

    return details;
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[updater] Ошибка проверки обновлений:', msg);
    updateErrorMessage.set(msg);
    updateStatus.set('error');
    isChecking = false;
    return null;
  }
}

export async function startDownload(details?: UpdateDetails): Promise<string | null> {
  const currentDetails = details || get(updateInfo);
  if (!currentDetails || isDownloading) return null;

  isDownloading = true;
  updateStatus.set('downloading');
  downloadProgress.set({ downloaded: 0, total: currentDetails.size || 0, percent: 0 });

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const { listen } = await import('@tauri-apps/api/event');

    if (unlistenProgress) {
      unlistenProgress();
      unlistenProgress = null;
    }

    unlistenProgress = await listen<DownloadProgressPayload>(
      'update:download-progress',
      (event) => {
        downloadProgress.set(event.payload);
      }
    );

    const savedPath = await invoke<string>('check_and_download_update', {
      url: currentDetails.exeUrl,
      filename: currentDetails.exeName
    });

    downloadedInstallerPath.set(savedPath);
    updateStatus.set('ready');
    isDownloading = false;

    if (unlistenProgress) {
      unlistenProgress();
      unlistenProgress = null;
    }

    return savedPath;
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[updater] Ошибка скачивания обновления:', msg);
    updateErrorMessage.set(msg);
    updateStatus.set('error');
    isDownloading = false;

    if (unlistenProgress) {
      unlistenProgress();
      unlistenProgress = null;
    }

    return null;
  }
}

export async function installDownloadedUpdate(): Promise<void> {
  const path = get(downloadedInstallerPath);
  if (!path) return;

  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('install_update', { installerPath: path });
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[updater] Ошибка запуска установщика:', msg);
    updateErrorMessage.set(msg);
  }
}
