import { get } from 'svelte/store';
import { writable } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { audioDir, join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-dialog';
import { settings, notify } from '$lib/stores';
import { getAudioUrl } from '$lib/api';
import { buildTrackUrn } from '$lib/utils/trackUrn';

/** Множество URN треков, находящихся в процессе экспорта в файл */
export const exportingUrns = writable<Set<string>>(new Set());

function sanitizeFilename(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Выбор папки для экспорта треков через системный диалог */
export async function chooseExportDirectory(): Promise<string | null> {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Выберите папку для сохранения аудиофайлов'
    });
    if (typeof selected === 'string' && selected.trim().length > 0) {
      return selected;
    }
    return null;
  } catch (err) {
    console.error('Failed to select export directory', err);
    return null;
  }
}

/** Получение стандартной папки музыки системы */
export async function getDefaultMusicDirectory(): Promise<string> {
  try {
    return await audioDir();
  } catch (err) {
    console.error('Failed to resolve audioDir', err);
    return '';
  }
}

/** Экспорт трека в файл MP3 или WAV на диск */
export async function exportTrackToFile(track: any): Promise<boolean> {
  if (!track) return false;

  const urn = buildTrackUrn(track);
  const currentSet = get(exportingUrns);
  if (currentSet.has(urn)) {
    return false;
  }

  const s = get(settings);
  const ext = (s.exportFormat === 'wav' ? 'wav' : 'mp3') as 'wav' | 'mp3';

  // Определяем целевую папку
  let targetDir = (s.exportDirectory || '').trim();
  if (!targetDir) {
    targetDir = await getDefaultMusicDirectory();
  }
  if (!targetDir) {
    notify('Не удалось определить папку для сохранения аудиофайла', 'error');
    return false;
  }

  exportingUrns.update(set => new Set(set).add(urn));

  try {
    let url = track.url;
    if (!url) {
      url = await getAudioUrl(track);
    }
    if (!url) {
      throw new Error('Не удалось получить ссылку на аудиопоток');
    }

    const safeArtist = sanitizeFilename(track.artist || 'Неизвестный исполнитель');
    const safeTitle = sanitizeFilename(track.title || 'Трек');
    const filename = `${safeArtist} - ${safeTitle}.${ext}`;
    const destPath = await join(targetDir, filename);

    const request = {
      urn,
      coverUrl: track.coverUrl || null,
      url,
      urls: [url],
      hq: true,
      durationMs: track.duration ? track.duration : null
    };

    await invoke<string>('track_export', {
      request,
      destPath,
      coverUrl: track.coverUrl || null,
      title: track.title || null,
      artist: track.artist || null
    });

    notify(`Трек «${track.title}» экспортирован в ${ext.toUpperCase()}`, 'success');
    return true;
  } catch (err: any) {
    console.error('Failed to export track', err);
    const msg = typeof err === 'string' ? err : err?.message || 'Неизвестная ошибка';
    notify(`Ошибка экспорта: ${msg}`, 'error');
    return false;
  } finally {
    exportingUrns.update(set => {
      const next = new Set(set);
      next.delete(urn);
      return next;
    });
  }
}
