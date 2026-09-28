export type ArtistTrackSort = 'popular' | 'newest' | 'oldest' | 'title';

export const ARTIST_TRACK_SORT_KEY = 'lomify-artist-track-sort';
export const ARTIST_TRACK_SORT_OPTIONS: { value: ArtistTrackSort; label: string }[] = [
  { value: 'popular', label: 'Популярные' },
  { value: 'newest', label: 'Сначала новые' },
  { value: 'oldest', label: 'Сначала старые' },
  { value: 'title', label: 'По названию' },
];

type TrackMetadata = {
  title?: string;
  releaseDate?: string;
  playbackCount?: number;
};

export function releaseTimestamp(value?: string): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function sortArtistTracks<T extends TrackMetadata>(
  tracks: T[], sort: ArtistTrackSort, source: string,
): T[] {
  // Yandex supplies a popularity ranking without public per-track play counts.
  if (sort === 'popular' && source === 'yandex') return tracks.slice();
  return tracks.slice().sort((a, b) => {
    if (sort === 'popular') return (b.playbackCount ?? 0) - (a.playbackCount ?? 0);
    if (sort === 'title') return (a.title ?? '').localeCompare(b.title ?? '', 'ru', { numeric: true });
    const left = releaseTimestamp(a.releaseDate);
    const right = releaseTimestamp(b.releaseDate);
    // Missing dates belong at the end in both chronological directions.
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return sort === 'newest' ? right - left : left - right;
  });
}

export function formatTrackDate(value?: string): string {
  const timestamp = releaseTimestamp(value);
  return timestamp === null ? 'Нет даты' : new Date(timestamp).toLocaleDateString('ru-RU');
}

export function formatTrackDuration(milliseconds?: number): string {
  if (!milliseconds || !Number.isFinite(milliseconds) || milliseconds < 0) return '-';
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
