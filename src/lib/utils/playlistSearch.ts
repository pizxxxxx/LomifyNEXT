import type { PlaylistTrack } from './playlistOrder';

function normalize(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е');
}

/** Search the full playlist while retaining positions for numbering and playback. */
export function searchPlaylistTracks<T extends PlaylistTrack>(tracks: T[], query: string): { track: T; index: number }[] {
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return tracks.map((track, index) => ({ track, index }));
  return tracks.flatMap((track, index) => {
    const text = normalize([track.title, track.artist, ...(track.artists ?? [])].filter(Boolean).join(' '));
    return terms.every(term => text.includes(term)) ? [{ track, index }] : [];
  });
}
