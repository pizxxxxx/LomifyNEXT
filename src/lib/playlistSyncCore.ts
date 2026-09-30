export interface PlaylistSnapshot { title: string; keys: string[] }
export interface PlaylistLink {
  provider: 'yandex' | 'soundcloud';
  accountId: string;
  remoteId: string;
  ownerId?: string;
  kind?: string;
  baseline: PlaylistSnapshot;
  revision?: number;
  paused?: boolean;
  conflict?: 'title' | 'order';
  error?: string;
  lastSynced?: number;
}

/** Occurrence numbers retain repeated tracks instead of silently deduplicating them. */
export function trackKeys(tracks: any[]): string[] {
  const counts = new Map<string, number>();
  return tracks.map(track => {
    const key = JSON.stringify([track.source || 'soundcloud', String(track.id ?? '')]);
    const occurrence = counts.get(key) || 0;
    counts.set(key, occurrence + 1);
    return key + ':' + occurrence;
  });
}
export function snapshot(playlist: any): PlaylistSnapshot {
  return { title: String(playlist.title || ''), keys: trackKeys(playlist.tracks || []) };
}
export function same(a: PlaylistSnapshot, b: PlaylistSnapshot): boolean {
  return a.title === b.title && sameOrder(a.keys, b.keys);
}
function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

/** Delete wins for old entries; concurrent additions survive. Opposing reorders need a choice. */
export function mergeSnapshots(base: PlaylistSnapshot | null, local: PlaylistSnapshot, remote: PlaylistSnapshot):
  { value: PlaylistSnapshot; conflict?: 'title' | 'order' } {
  if (!base) {
    return {
      value: { title: remote.title, keys: [...remote.keys, ...local.keys.filter(key => !remote.keys.includes(key))] },
      conflict: local.title !== remote.title ? 'title' : undefined
    };
  }
  const localTitleChanged = local.title !== base.title;
  const remoteTitleChanged = remote.title !== base.title;
  const title = localTitleChanged ? local.title : remote.title;
  if (localTitleChanged && remoteTitleChanged && local.title !== remote.title) {
    return { value: local, conflict: 'title' };
  }
  const old = new Set(base.keys), l = new Set(local.keys), r = new Set(remote.keys);
  const survivors = new Set([
    ...base.keys.filter(key => l.has(key) && r.has(key)),
    ...local.keys.filter(key => !old.has(key)),
    ...remote.keys.filter(key => !old.has(key))
  ]);
  const existing = (keys: string[]) => keys.filter(key => old.has(key) && survivors.has(key));
  const originalOrder = existing(base.keys);
  const localOrder = existing(local.keys), remoteOrder = existing(remote.keys);
  const reorderedLocal = !sameOrder(originalOrder, localOrder);
  const reorderedRemote = !sameOrder(originalOrder, remoteOrder);
  if (reorderedLocal && reorderedRemote && !sameOrder(localOrder, remoteOrder)) {
    return { value: local, conflict: 'order' };
  }
  const preferred = reorderedLocal ? local.keys : remote.keys;
  const keys: string[] = [];
  for (const key of preferred) if (survivors.has(key) && !keys.includes(key)) keys.push(key);
  for (const order of [local.keys, remote.keys]) {
    for (let index = 0; index < order.length; index++) {
      const key = order[index];
      if (!survivors.has(key) || keys.includes(key)) continue;
      const next = order.slice(index + 1).find(candidate => keys.includes(candidate));
      if (next) keys.splice(keys.indexOf(next), 0, key); else keys.push(key);
    }
  }
  return { value: { title, keys } };
}
export function tracksForKeys(keys: string[], ...lists: any[][]): any[] {
  const byKey = new Map<string, any>();
  // Later lists contain fresher server metadata; retain local-only entries.
  for (const tracks of lists) trackKeys(tracks).forEach((key, index) => byKey.set(key, tracks[index]));
  return keys.map(key => {
    const track = byKey.get(key);
    if (!track) throw new Error('Не удалось сопоставить треки. Повтори синхронизацию.');
    return track;
  });
}
