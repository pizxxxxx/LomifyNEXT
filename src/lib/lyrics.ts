import { safeFetch as api } from './api';

export type LyricsSource = 'lrclib' | 'musixmatch' | 'genius' | 'netease' | 'self_gen' | 'none';

export interface LyricLine {
  time: number;
  text: string;
}

export interface LyricsResult {
  plain: string | null;
  synced: LyricLine[] | null;
  source: LyricsSource;
  language: string | null;
}

interface BackendLyricsResponse {
  scTrackId: string;
  syncedLrc: string | null;
  plainText: string | null;
  source: LyricsSource;
  language: string | null;
  languageConfidence: number | null;
}

/** Parse LRC format: [mm:ss.xx] text */
export function parseLRC(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\]\s*(.*)/);
    if (!m) continue;
    const time = +m[1] * 60 + +m[2] + +m[3].padEnd(3, '0') / 1000;
    const text = m[4].trim();
    if (text) lines.push({ time, text });
  }
  return lines;
}

function toResult(data: BackendLyricsResponse | null): LyricsResult | null {
  if (!data) return null;
  const synced = data.syncedLrc ? parseLRC(data.syncedLrc) : null;
  return {
    plain: data.plainText,
    synced: synced && synced.length > 0 ? synced : null,
    source: data.source,
    language: data.language,
  };
}

/** Load lyrics by track URN/id. Backend resolves artist/title itself and writes to cache. */
export async function getLyricsByTrack(scTrackId: string): Promise<LyricsResult | null> {
  const res = await api(
    `http://localhost:52289/lyrics/${encodeURIComponent(scTrackId)}`
  ).catch(() => null);
  const data = res ? await res.json() as BackendLyricsResponse : null;
  return toResult(data);
}

/** Manual search — preview only. Backend does NOT read or write cache. */
export async function searchLyricsManual(
  artist: string,
  title: string,
  durationMs?: number,
): Promise<LyricsResult | null> {
  const params = new URLSearchParams({ artist, title });
  if (durationMs && Number.isFinite(durationMs) && durationMs > 0) {
    params.set('duration', String(Math.round(durationMs)));
  }
  const res = await api(
    `http://localhost:52289/lyrics/search?${params}`
  ).catch(() => null);
  const data = res ? await res.json() as BackendLyricsResponse : null;
  return toResult(data);
}

/** Динамический расчет размера шрифта для фоновых эдлибов в зависимости от длины текста */
export function getBackdropFontSize(text: string): string {
  const clean = text.replace(/^[(\[«"'\s#]+|[)\]»"'\s]+$/gu, '').trim();
  const len = Math.max(1, clean.length);

  let targetVw: number;
  let minPx: number;
  let maxPx: number;

  if (len <= 4) {
    // Короткие звуки ("damn", "yeah", "эй")
    targetVw = 9.5;
    minPx = 55;
    maxPx = 135;
  } else if (len <= 6) {
    // Короткие слова до 6 букв ("baby", "wait", "хоу")
    targetVw = 8.5;
    minPx = 48;
    maxPx = 115;
  } else if (len <= 10) {
    // Слова средней длины ("раскрой", "выходанет")
    targetVw = 7.0;
    minPx = 40;
    maxPx = 95;
  } else if (len <= 16) {
    // Фразы ("не останавливай", "всегда со мной")
    targetVw = 5.6;
    minPx = 34;
    maxPx = 80;
  } else if (len <= 26) {
    // Длинные строки ("никогда не говори никогда")
    targetVw = 4.4;
    minPx = 28;
    maxPx = 64;
  } else if (len <= 40) {
    // Очень длинные строки
    targetVw = 3.4;
    minPx = 24;
    maxPx = 52;
  } else {
    // Большие предложения
    targetVw = 2.6;
    minPx = 20;
    maxPx = 42;
  }

  return `clamp(${minPx}px, ${targetVw}vw, ${maxPx}px)`;
}
