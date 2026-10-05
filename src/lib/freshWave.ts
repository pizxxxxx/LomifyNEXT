import { get } from 'svelte/store';
import { settings, likedTracks, dislikedTracks, listenStats } from './stores';
import { whenSecretsReady } from './secretStorage';
import { createFreshWavePlan, assembleFreshWave, waveTrackKey, type WaveSource } from './freshWaveCore';
import { trackMatchesWaveFilters, trackMatchesWaveGenre, isNeuroTrack } from './waveFilters';

export async function getFreshWaveTracks(source: WaveSource, seen: ReadonlySet<string>, skipped: ReadonlyMap<string, number>, anchor?: any, signal?: AbortSignal): Promise<any[]> {
  await whenSecretsReady();
  signal?.throwIfAborted();
  const state = get(settings), token = state.yandexToken;
  if (source === 'yandex' && !token) throw new Error('Подключи Яндекс Музыку в настройках.');
  const input = { source, likes: get(likedTracks), disliked: get(dislikedTracks), history: get(listenStats).history, now: Date.now() };
  const plan = createFreshWavePlan(input);
  if (anchor?.source === source && !plan.recent.some(track => waveTrackKey(track) === waveTrackKey(anchor))) plan.recent = [anchor, ...plan.recent].slice(0, 3);
  const api = await import('./api');
  const ym = source === 'yandex' ? await import('./yandex') : null;
  const relatedJobs = new Map<string, Promise<any[]>>();
  const related = (track: any) => {
    const key = waveTrackKey(track);
    if (!relatedJobs.has(key)) relatedJobs.set(key, source === 'yandex' ? ym!.getYandexSimilar(token!, track.id, 40, signal) : api.fetchRelatedTracks(track.id, 40, signal));
    return relatedJobs.get(key)!;
  };
  const recentArtistNames = new Set(plan.recent.map(track => String(track.artist).toLocaleLowerCase('ru')));
  const queries = [...new Set([...plan.recent, ...plan.stable].map(track => track.genre).filter(Boolean))].slice(0, 2);
  if (!queries.length) queries.push(...[...new Set([...plan.recent, ...plan.stable].map(track => track.artist).filter(Boolean))].slice(0, 2));
  const search = (query: string) => source === 'yandex' ? ym!.searchYandex(token!, query, 40, 0, signal) : api.searchSoundCloud(query, 40, true, signal);
  const jobs = await Promise.all([
    Promise.allSettled(plan.recent.map(related)),
    Promise.allSettled(plan.stable.map(related)),
    Promise.allSettled(queries.map(search))
  ]);
  signal?.throwIfAborted();
  const tracks = (settled: PromiseSettledResult<any[]>[]) => settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  const recent = tracks(jobs[0]), stable = tracks(jobs[1]), catalog = tracks(jobs[2]);
  if (!recent.length && !stable.length && !catalog.length && !plan.recent.length && !plan.stable.length) catalog.push(...await api.getTrendingTracks([], null, [], [], { source }));
  signal?.throwIfAborted();
  const matches = (track: any) => (source === 'yandex' ? trackMatchesWaveFilters(track, state) : trackMatchesWaveGenre(track, state)) && (state.waveAllowNeuro !== false || !isNeuroTrack(track)) && (state.waveAllowNeuro !== 'only' || isNeuroTrack(track));
  const discover = [...catalog, ...recent, ...stable].filter(track => !recentArtistNames.has(String(track.artist).toLocaleLowerCase('ru')));
  return assembleFreshWave({ recent: recent.filter(matches), stable: stable.filter(matches), discover: discover.filter(matches) }, input, plan.exploration, seen, skipped);
}
