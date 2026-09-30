import { playlistsReady, flushPlaylistStorage } from '$lib/stores';
export const playlistSyncReady = playlistsReady;
export const persistSyncedPlaylists = flushPlaylistStorage;
