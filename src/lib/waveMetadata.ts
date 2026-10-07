import { getYandexLyrics } from './yandex';
import { languageFromWaveLyrics, trackMatchesWaveGenre, type WaveFilterState, type WaveFilterEvidence } from './waveFilters';

let account = '';
const cache = new Map<string, { lyricsAvailable: boolean; lyricsLanguage: string }>();
/** Small metadata cache; at most three lyric requests at once, with a per-launch budget. */
export async function enrichWaveCandidates(token: string, tracks: any[], state: WaveFilterState, evidence: WaveFilterEvidence, budget: { remaining: number }, signal?: AbortSignal): Promise<any[]> {
  if (account !== token) { account = token; cache.clear(); }
  const result = [...tracks];
  let cursor = 0;
  async function worker() {
    while (cursor < result.length) {
      signal?.throwIfAborted();
      const index = cursor++, track = result[index];
      const needsLanguage = state.waveLanguage && state.waveContent !== 'instrumental' && !track.lyricsLanguage && !(state.waveLanguage === 'ru' && evidence.serverLanguage === 'russian');
      const needsWords = state.waveContent === 'lyrics' && track.lyricsAvailable === undefined;
      if ((!needsLanguage && !needsWords) || !trackMatchesWaveGenre(track, state, evidence)) continue;
      const id = String(track.id);
      let metadata = cache.get(id);
      if (!metadata) {
        if (budget.remaining <= 0) continue;
        budget.remaining--;
        const lyrics = await getYandexLyrics(token, id, signal);
        signal?.throwIfAborted();
        if (account !== token) return;
        metadata = { lyricsAvailable: /\p{L}{2}/u.test((lyrics || '').replace(/\[[^\]]*\]/g, '')), lyricsLanguage: lyrics ? languageFromWaveLyrics(lyrics) : '' };
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(id, metadata);
      }
      result[index] = { ...track, lyricsAvailable: track.lyricsAvailable ?? metadata.lyricsAvailable, lyricsLanguage: track.lyricsLanguage || metadata.lyricsLanguage || undefined };
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, result.length) }, worker));
  return result;
}
