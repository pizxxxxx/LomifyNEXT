export interface WaveHistoryEntry {
  playedAt: number;
  station: string;
  track: { id: string; source: string; title: string; artist: string; coverUrl: string; duration?: number; artists?: string[]; isLocal?: boolean; audioUrl?: string };
}
export const WAVE_HISTORY_LIMIT = 200;

export function waveHistoryEntry(track: any, playedAt = Date.now()): WaveHistoryEntry | null {
  if (!track?.waveBatchId || !track?.waveStation || !track.id || !track.title || !Number.isFinite(playedAt)) return null;
  const entry: WaveHistoryEntry = { playedAt, station: String(track.waveStation), track: {
    id: String(track.id), source: String(track.source || ''), title: String(track.title),
    artist: String(track.artist || ''), coverUrl: String(track.coverUrl || ''),
    ...(Number.isFinite(track.duration) ? { duration: track.duration } : {}),
    ...(Array.isArray(track.artists) ? { artists: track.artists.filter((name: unknown) => typeof name === 'string') } : {}),
  } };
  // Only local files need a stored playback path. Remote signed stream URLs expire.
  if (track.isLocal && typeof track.audioUrl === 'string' && !/^(https?:|blob:|data:)/i.test(track.audioUrl)) {
    entry.track.isLocal = true; entry.track.audioUrl = track.audioUrl;
  }
  return entry;
}

export function sanitizeWaveHistory(value: unknown): WaveHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || typeof item.playedAt !== 'number' || item.playedAt <= 0) return [];
    const entry = waveHistoryEntry({ ...item.track, waveBatchId: 'stored', waveStation: item.station }, item.playedAt);
    return entry ? [entry] : [];
  }).sort((a, b) => b.playedAt - a.playedAt).slice(0, WAVE_HISTORY_LIMIT);
}
