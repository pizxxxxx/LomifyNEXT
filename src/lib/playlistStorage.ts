const DB_NAME = 'LomifyNextPlaylists';
const STORE_NAME = 'snapshots';
const SNAPSHOT_KEY = 'all';

export function playlistIdentity(playlist: any): string | null {
  const id = playlist?.id;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  const key = String(id).trim();
  return key || null;
}

function yandexContentIdentity(playlist: any): string | null {
  const id = playlistIdentity(playlist) || '';
  const tracks = playlist?.tracks;
  if (!id.startsWith('ym_playlist_') && playlist?.origin !== 'yandex') return null;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const title = `${playlist.title ?? ''}`.normalize('NFKC').trim().toLocaleLowerCase('ru-RU');
  if (!title) return null;
  const trackIds = tracks.map((track: any) => track?.id == null ? '' : String(track.id));
  if (trackIds.some((trackId: string) => !trackId)) return null;
  return `${title}\u0000${trackIds.sort().join('\u0000')}`;
}

/** Remove copies of the same playlist without merging lists that only share a title. */
export function dedupePlaylists<T extends { id?: unknown; tracks?: unknown }>(items: T[]): T[] {
  const byId: T[] = [];
  const positions = new Map<string, number>();
  for (const item of items) {
    const key = playlistIdentity(item);
    if (!key) {
      byId.push(item);
      continue;
    }
    const index = positions.get(key);
    if (index === undefined) {
      positions.set(key, byId.length);
      byId.push(item);
      continue;
    }
    const currentCount = Array.isArray(byId[index].tracks) ? byId[index].tracks.length : 0;
    const candidateCount = Array.isArray(item.tracks) ? item.tracks.length : 0;
    if (candidateCount >= currentCount) byId[index] = item;
  }

  const unique: T[] = [];
  const contentPositions = new Map<string, number>();
  for (const item of byId) {
    const key = yandexContentIdentity(item);
    const index = key ? contentPositions.get(key) : undefined;
    if (index === undefined) {
      if (key) contentPositions.set(key, unique.length);
      unique.push(item);
      continue;
    }
    const currentCount = Array.isArray(unique[index].tracks) ? unique[index].tracks.length : 0;
    const candidateCount = Array.isArray(item.tracks) ? item.tracks.length : 0;
    if (candidateCount > currentCount) unique[index] = item;
  }
  return unique;
}

function openPlaylistDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadPlaylistSnapshot(): Promise<any[] | null> {
  const db = await openPlaylistDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onabort = () => { db.close(); reject(transaction.error); };
  });
}

export async function savePlaylistSnapshot(playlists: any[]): Promise<void> {
  const db = await openPlaylistDB();
  return new Promise((resolve, reject) => {
    try {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(playlists, SNAPSHOT_KEY);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    } catch (error) {
      db.close();
      reject(error);
    }
  });
}
