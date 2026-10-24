export interface AchievementFacts {
  seconds: number; plays: number; tracks: number; artists: number; likes: number; playlists: number; sources: number;
}
export const ACHIEVEMENTS = [
  { id: 'first-play', title: 'Первый трек', description: 'Одно засчитанное прослушивание', metric: 'plays', goal: 1, kind: 'music' },
  { id: 'hour', title: 'В своём ритме', description: 'Час прослушанной музыки', metric: 'seconds', goal: 3600, kind: 'time' },
  { id: 'ten-hours', title: 'Музыка рядом', description: '10 часов музыки', metric: 'seconds', goal: 36000, kind: 'time' },
  { id: 'hundred-hours', title: 'На одной волне', description: '100 часов музыки', metric: 'seconds', goal: 360000, kind: 'time' },
  { id: 'five-hundred-hours', title: 'Свой саундтрек', description: '500 часов музыки', metric: 'seconds', goal: 1800000, kind: 'time' },
  { id: 'hundred-plays', title: 'Ещё одну', description: '100 засчитанных прослушиваний', metric: 'plays', goal: 100, kind: 'music' },
  { id: 'thousand-plays', title: 'Без паузы во вкусах', description: '1000 засчитанных прослушиваний', metric: 'plays', goal: 1000, kind: 'music' },
  { id: 'explorer', title: 'Искатель', description: '25 разных прослушанных песен', metric: 'tracks', goal: 25, kind: 'explore' },
  { id: 'wide-horizon', title: 'Широкий кругозор', description: '250 разных прослушанных песен', metric: 'tracks', goal: 250, kind: 'explore' },
  { id: 'artists', title: 'Новые голоса', description: '20 разных исполнителей в истории', metric: 'artists', goal: 20, kind: 'artists' },
  { id: 'ten-likes', title: 'Это моё', description: '10 песен в любимых', metric: 'likes', goal: 10, kind: 'heart' },
  { id: 'hundred-likes', title: 'Коллекционер', description: '100 песен в любимых', metric: 'likes', goal: 100, kind: 'heart' },
  { id: 'first-playlist', title: 'Своя подборка', description: 'Один плейлист в медиатеке', metric: 'playlists', goal: 1, kind: 'playlist' },
  { id: 'five-playlists', title: 'На любое настроение', description: 'Пять плейлистов в медиатеке', metric: 'playlists', goal: 5, kind: 'playlist' },
  { id: 'two-sources', title: 'Без границ', description: 'Засчитанные песни из двух источников', metric: 'sources', goal: 2, kind: 'explore' }
] as const;
export type AchievementId = typeof ACHIEVEMENTS[number]['id'];
export type AchievementUnlocks = Partial<Record<AchievementId, number>>;
const historyCache = new WeakMap<object, Pick<AchievementFacts, 'tracks' | 'artists' | 'sources'>>();
export function achievementFacts(stats: any, likes: readonly unknown[], playlists: readonly unknown[]): AchievementFacts {
  const history = stats?.history && typeof stats.history === 'object' ? stats.history : {};
  let facts = historyCache.get(history);
  if (!facts) {
    const artists = new Set<string>(), sources = new Set<string>();
    let tracks = 0;
    for (const entry of Object.values(history) as any[]) {
      if (!entry || !(entry.count > 0)) continue;
      tracks++;
      for (const artist of Array.isArray(entry.artists) && entry.artists.length ? entry.artists : [entry.artist]) {
        if (typeof artist === 'string' && artist.trim()) artists.add(artist.trim().normalize('NFKC').toLocaleLowerCase('ru'));
      }
      if (entry.source) sources.add(String(entry.source));
    }
    facts = { tracks, artists: artists.size, sources: sources.size };
    historyCache.set(history, facts);
  }
  return { ...facts, seconds: Math.max(0, Number(stats?.listenSeconds) || 0), plays: Math.max(0, Number(stats?.tracksPlayed) || 0), likes: likes.length, playlists: playlists.length };
}
export function normalizeAchievementUnlocks(value: unknown): AchievementUnlocks {
  const result: AchievementUnlocks = {};
  if (!value || typeof value !== 'object') return result;
  for (const item of ACHIEVEMENTS) {
    const date = (value as any)[item.id];
    if (typeof date === 'number' && Number.isFinite(date) && date > 0 && date <= Date.now() + 86400000) result[item.id] = date;
  }
  return result;
}
export function achievementProgress(facts: AchievementFacts, unlocked: AchievementUnlocks) {
  return ACHIEVEMENTS.map(item => ({ ...item, value: Math.min(item.goal, facts[item.metric]), unlocked: Boolean(unlocked[item.id]), unlockedAt: unlocked[item.id] ?? null }));
}
