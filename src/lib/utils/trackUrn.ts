/** The single canonical key builder used by playback and cache maintenance. */
export function buildTrackUrn(track: any): string {
  const trackId = track?.id ? track.id : `${track?.title || ''}-${track?.artist || ''}`;
  // A regular SoundCloud cache entry may contain an automatically selected Yandex twin.
  // Keep explicitly selected SC editions separate, with the numeric ID still last.
  const edition = track?.source === 'soundcloud' && track?.playbackSource === 'soundcloud' ? 'direct:' : '';
  return `lomify:${track?.source || ''}:${edition}${trackId}`.replace(/[^a-zA-Z0-9а-яА-ЯёЁ:-]/g, '');
}
