import { splitArtists } from './artists.ts';

export interface PlaylistTrack {
  id?: string | number;
  source?: string;
  urn?: string;
  title?: string;
  artist?: string;
  artists?: string[];
  url?: string;
}

export interface OrderedPlaylist {
  id: string | number;
  tracks: PlaylistTrack[];
  shuffleOriginalOrder?: string[];
}

function trackKey(track: PlaylistTrack): string {
  const source = track.source ?? '';
  if (track.id != null) return JSON.stringify([source, 'id', String(track.id)]);
  if (track.urn) return JSON.stringify([source, 'urn', track.urn]);
  if (source === 'local' && track.url) return JSON.stringify([source, 'file', track.url]);
  return JSON.stringify([source, 'name', track.title ?? '', track.artist ?? '']);
}

/** Shuffle the complete saved list, keeping one compact undo snapshot across reshuffles. */
export function shufflePlaylist<T extends OrderedPlaylist>(playlist: T, random = Math.random): T {
  if (playlist.tracks.length < 2) return playlist;
  const tracks = [...playlist.tracks];
  for (let i = tracks.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
  }

  const originalKeys = playlist.tracks.map(trackKey);
  // Even a two-track playlist should visibly change on every click.
  if (tracks.every((track, index) => trackKey(track) === originalKeys[index])) {
    const other = originalKeys.findIndex(key => key !== originalKeys[0]);
    if (other !== -1) [tracks[0], tracks[other]] = [tracks[other], tracks[0]];
  }

  return {
    ...playlist,
    tracks,
    shuffleOriginalOrder: playlist.shuffleOriginalOrder ?? originalKeys
  };
}

interface ArtistGroup {
  artists: Set<string>;
  tracks: PlaylistTrack[];
  priority: number;
}

/** Most numerous artists go first; random ties keep equally sized groups varied. */
class ArtistHeap {
  private groups: ArtistGroup[] = [];

  get size() { return this.groups.length; }

  private ahead(a: ArtistGroup, b: ArtistGroup): boolean {
    return a.tracks.length > b.tracks.length
      || (a.tracks.length === b.tracks.length && a.priority > b.priority);
  }

  push(group: ArtistGroup) {
    let index = this.groups.length;
    this.groups.push(group);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.ahead(group, this.groups[parent])) break;
      this.groups[index] = this.groups[parent];
      index = parent;
    }
    this.groups[index] = group;
  }

  pop(): ArtistGroup {
    const first = this.groups[0];
    const last = this.groups.pop()!;
    if (this.groups.length) {
      let index = 0;
      while (index * 2 + 1 < this.groups.length) {
        let child = index * 2 + 1;
        if (child + 1 < this.groups.length && this.ahead(this.groups[child + 1], this.groups[child])) child++;
        if (!this.ahead(this.groups[child], last)) break;
        this.groups[index] = this.groups[child];
        index = child;
      }
      this.groups[index] = last;
    }
    return first;
  }
}

/** Best-effort artist separation, including collaborations, with bounded candidate work. */
export function smartShufflePlaylist<T extends OrderedPlaylist>(playlist: T, random = Math.random): T {
  if (playlist.tracks.length < 2) return playlist;
  const shuffled = shufflePlaylist(playlist, random);
  const groups = new Map<string, ArtistGroup>();
  shuffled.tracks.forEach((track, index) => {
    const artists = splitArtists(track.artist, track.artists)
      .map(name => name.normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim());
    // Missing metadata is not evidence that unrelated tracks have the same artist.
    const key = artists.length ? JSON.stringify([...artists].sort()) : `unknown:${index}`;
    const group = groups.get(key);
    if (group) group.tracks.push(track);
    else groups.set(key, { artists: new Set(artists), tracks: [track], priority: random() });
  });

  const heap = new ArtistHeap();
  groups.forEach(group => {
    group.tracks.reverse();
    heap.push(group);
  });
  const tracks: PlaylistTrack[] = [];
  let previous = new Set<string>();
  while (heap.size) {
    const candidates: ArtistGroup[] = [];
    let chosen = 0;
    let fewestShared = Infinity;
    // A cap avoids quadratic scans for huge playlists full of collaborations.
    while (heap.size && candidates.length < 32) {
      const group = heap.pop();
      const shared = [...group.artists].filter(artist => previous.has(artist)).length;
      candidates.push(group);
      if (shared < fewestShared) {
        chosen = candidates.length - 1;
        fewestShared = shared;
      }
      if (shared === 0) break;
    }
    const group = candidates.splice(chosen, 1)[0];
    tracks.push(group.tracks.pop()!);
    previous = group.artists;
    candidates.forEach(candidate => heap.push(candidate));
    if (group.tracks.length) {
      group.priority = random();
      heap.push(group);
    }
  }

  if (tracks.every((track, index) => trackKey(track) === trackKey(playlist.tracks[index]))) tracks.reverse();
  return { ...shuffled, tracks };
}

/** Restore order only: keep current metadata, skip removals and append new tracks. */
export function undoPlaylistShuffle<T extends OrderedPlaylist>(playlist: T): T {
  if (!playlist.shuffleOriginalOrder) return playlist;
  const positions = new Map<string, number[]>();
  for (let i = playlist.tracks.length - 1; i >= 0; i--) {
    const key = trackKey(playlist.tracks[i]);
    const bucket = positions.get(key);
    if (bucket) bucket.push(i);
    else positions.set(key, [i]);
  }

  const restored: PlaylistTrack[] = [];
  const used = new Set<number>();
  for (const key of playlist.shuffleOriginalOrder) {
    const index = positions.get(key)?.pop();
    if (index === undefined) continue;
    used.add(index);
    restored.push(playlist.tracks[index]);
  }
  playlist.tracks.forEach((track, index) => {
    if (!used.has(index)) restored.push(track);
  });

  const { shuffleOriginalOrder, ...rest } = playlist;
  return { ...rest, tracks: restored } as T;
}
