/** The single canonical key builder used by playback and cache maintenance. */
export function buildTrackUrn(track: any): string {
  const trackId = track?.id ? track.id : `${track?.title || ''}-${track?.artist || ''}`;
  return `lomify:${track?.source || ''}:${trackId}`.replace(/[^a-zA-Z0-9а-яА-ЯёЁ:-]/g, '');
}
