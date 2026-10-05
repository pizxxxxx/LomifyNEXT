import { buildDailyMixes, dailyMixContext, type DailyMixInput, type DailyMixSnapshot } from './dailyMixesCore';

const CACHE_KEY = 'lomifynext_daily_mixes';
const contexts = new Map<string, DailyMixSnapshot>();
let loaded = false;

export function updateDailyMixes(input: DailyMixInput, force = false): DailyMixSnapshot {
  if (!loaded) {
    loaded = true;
    try {
      const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '[]');
      for (const snapshot of Array.isArray(cache) ? cache.slice(0, 4) : []) {
        if (snapshot?.version === 1 && typeof snapshot.context === 'string' && Array.isArray(snapshot.mixes)) contexts.set(snapshot.context, snapshot);
      }
    } catch { /* Invalid optional cache is rebuilt from ordinary music metadata. */ }
  }
  const context = dailyMixContext(input);
  const previous = contexts.get(context);
  const snapshot = buildDailyMixes(input, previous, force);
  contexts.delete(context);
  contexts.set(context, snapshot);
  while (contexts.size > 4) contexts.delete(contexts.keys().next().value!);
  const serialized = JSON.stringify([...contexts.values()]);
  try {
    if (localStorage.getItem(CACHE_KEY) !== serialized) localStorage.setItem(CACHE_KEY, serialized);
  } catch { /* Memory-only mixes remain usable if the browser storage quota is full. */ }
  return snapshot;
}
