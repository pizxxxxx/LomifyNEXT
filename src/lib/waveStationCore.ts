import type { WaveFilterState } from './waveFilters';

const GENRE_STATIONS: Record<string, string[]> = {
  rock: ['allrock', 'rock'], electronic: ['electronics', 'electronic', 'edmgenre'],
  phonk: ['phonkgenre', 'phonk'], lofi: ['lofi', 'lofigenre', 'chillhop'],
};

export function waveStationForFilters(state: WaveFilterState, available: ReadonlySet<string>): string {
  if (!state.waveGenre) return 'user:onyourwave';
  const genre = state.waveGenre;
  const preferred = state.waveLanguage === 'ru' && ['rock', 'rap', 'pop'].includes(genre) ? [`rus${genre}`] : [];
  const candidates = [...preferred, ...(GENRE_STATIONS[genre] || [genre])];
  return candidates.map(tag => `genre:${tag}`).find(id => available.has(id)) || 'user:onyourwave';
}

export function waveServerLanguage(state: WaveFilterState): string {
  if (state.waveContent === 'instrumental') return 'without-words';
  return state.waveLanguage === 'ru' ? 'russian' : state.waveLanguage ? 'not-russian' : 'any';
}

export function waveStationSettings(info: any, state: WaveFilterState) {
  const language = waveServerLanguage(state);
  const possible = info?.station?.restrictions2?.language?.possibleValues;
  if (Array.isArray(possible) && !possible.some(value => value.value === language)) {
    throw new Error('Эта станция не поддерживает выбранный язык. Выберите другой жанр или любой язык.');
  }
  // Preserve the listener's existing mood and discovery preference in Yandex.
  const old = info?.settings2 || {};
  return { language, moodEnergy: old.moodEnergy || 'all', diversity: old.diversity || 'default', type: 'rotor' };
}
