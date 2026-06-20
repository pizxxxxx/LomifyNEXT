import { writable } from 'svelte/store';

// Global app state
export const currentTrack = writable<{
  title: string;
  artist: string;
  coverUrl: string;
  audioUrl: string;
  source: 'soundcloud' | 'youtube' | 'Локальный' | string;
  id?: string;
  isLocal?: boolean;
  duration?: number;
  permalinkUrl?: string;
} | null>(null);

export const isPlaying = writable(false);
export const progress = writable(0);
export const duration = writable(0);
export const globalVolume = writable(0.3);

// Global settings
const defaultSettings = {
  theme: 'red-dragon', // 'default' | 'cyberpunk' | 'neon-pink' | 'ocean' | 'dracula' | 'red-dragon'
  globalThemeEffect: true, // Apply theme color to app background

  searchSource: 'soundcloud', // 'youtube' | 'soundcloud' | 'yandex'
  yandexToken: '', // OAuth token for Yandex Music
  spotifyPlaylistUrl: '',
  parallax: true,
  lyricsAlignment: 'right', // 'left' | 'right' | 'fullscreen'
  lyricsOffset: 0, // ms offset for synced lyrics
  uiStyle: 'style1', // 'style1' | 'style2'
  autoCache: true, // Auto-cache tracks for offline playback
  enableDiscordRpc: true,
  showLyricsByDefault: false,
  enableHoverPreview: true,
  hoverPreviewDelay: 1000,
  playbackRate: 1.0,
  customProfileName: '', // Кастомное имя пользователя
  scUser: null as { id: number, username: string, avatarUrl: string, permalink: string } | null,
  leftAlignTracks: false, // Выравнивание треков по левому краю
  gibberishMode: false, // Easter egg
};

export const settings = writable(defaultSettings);

// Stats state
const defaultStats = {
  listenSeconds: 0,
  tracksPlayed: 0,
  history: {} as Record<string, { count: number, title: string, artist: string, coverUrl: string }>
};
export const listenStats = writable(defaultStats);

// Navigation state
export const currentView = writable<'home' | 'search' | 'library' | 'settings' | 'lyrics' | 'equalizer' | 'fullscreen' | 'profile' | 'artist'>('home');
export const previousView = writable<'home' | 'search' | 'library' | 'settings' | 'lyrics' | 'equalizer' | 'fullscreen' | 'profile' | 'artist'>('home');
export const activeEqualizerPreset = writable<string>('Flat');

export interface NavState {
  view: string;
  artist: string;
  search: string;
}

export const navHistory = writable<NavState[]>([]);
export const navFuture = writable<NavState[]>([]);
export const isHistoryNavigation = writable(false);

// Playlists store
const storedPlaylists = typeof window !== 'undefined' ? localStorage.getItem('lomifynext_playlists') : null;
export const playlists = writable<any[]>(storedPlaylists ? JSON.parse(storedPlaylists) : []);

if (typeof window !== 'undefined') {
  playlists.subscribe(value => {
    localStorage.setItem('lomifynext_playlists', JSON.stringify(value));
  });
}

// Notifications
export const notifications = writable<{id: number, message: string, type: 'success'|'info'|'error'}[]>([]);
export function notify(message: string, type: 'success'|'info'|'error' = 'info') {
  const id = Date.now() + Math.random();
  notifications.update(n => [...n, { id, message, type }]);
  setTimeout(() => {
    notifications.update(n => n.filter(x => x.id !== id));
  }, 3000);
}
export const currentArtist = writable<string>('');
export const searchQuery = writable('');
export const searchResults = writable<any[]>([]);
export const searchPlaylists = writable<any[]>([]);
export const searchHistory = writable<string[]>([]);

// Playback queue
export const queue = writable<any[]>([]);
export const trackHistory = writable<any[]>([]);
export const likedTracks = writable<any[]>([]);

export function initStore() {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem('lomifynext_settings');
    if (stored) {
      try {
        settings.set({ ...defaultSettings, ...JSON.parse(stored) });
      } catch (e) {
        console.error("Failed to parse settings", e);
      }
    }
    settings.subscribe(val => {
      localStorage.setItem('lomifynext_settings', JSON.stringify(val));
    });

    const storedStats = localStorage.getItem('lomifynext_stats');
    if (storedStats) {
      try {
        listenStats.set({ ...defaultStats, ...JSON.parse(storedStats) });
      } catch (e) {
        console.error("Failed to parse stats", e);
      }
    }
    listenStats.subscribe(val => {
      localStorage.setItem('lomifynext_stats', JSON.stringify(val));
    });

    const storedLikes = localStorage.getItem('lomifynext_likes');
    if (storedLikes) {
      try {
        likedTracks.set(JSON.parse(storedLikes));
      } catch (e) {
        console.error("Failed to parse liked tracks", e);
      }
    }
    likedTracks.subscribe(val => {
      localStorage.setItem('lomifynext_likes', JSON.stringify(val));
    });

    const storedSearch = localStorage.getItem('lomifynext_search_history');
    if (storedSearch) {
      try {
        searchHistory.set(JSON.parse(storedSearch));
      } catch (e) {
        console.error("Failed to parse search history", e);
      }
    }
    searchHistory.subscribe(val => {
      localStorage.setItem('lomifynext_search_history', JSON.stringify(val));
    });
  }
}

// Equalizer state (10 bands: 32, 64, 125, 250, 500, 1k, 2k, 4k, 8k, 16k)
export const equalizerBands = writable([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
