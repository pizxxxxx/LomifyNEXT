<script lang="ts">
  import { onMount } from 'svelte';
  import { Play, Loader2, ChevronLeft, ChevronRight } from 'lucide-svelte';
  import Sidebar from '$lib/components/Sidebar.svelte';
  import Player from '$lib/components/Player.svelte';
  import Settings from '$lib/components/Settings.svelte';
  import Search from '$lib/components/Search.svelte';
  import Lyrics from '$lib/components/Lyrics.svelte';
  import Fullscreen from '$lib/components/Fullscreen.svelte';
  import Equalizer from '$lib/components/Equalizer.svelte';
  import Library from '$lib/components/Library.svelte';
  import Profile from '$lib/components/Profile.svelte';
  import ArtistPage from '$lib/components/ArtistPage.svelte';
  import Notifications from '$lib/components/Notifications.svelte';
  import { currentView, currentTrack, isPlaying, queue, likedTracks, listenStats, searchHistory, playlists, navHistory, navFuture, isHistoryNavigation, currentArtist, searchQuery as searchQueryStore, settings } from '$lib/stores';
  import { getTrendingTracks } from '$lib/api';
  import { getTracks } from '$lib/db';

  import { gibberish } from '$lib/actions/gibberish';

  let greeting = 'Добрый вечер';
  let osUsername = 'User';
  let trendingTracks: any[] = [];
  let newReleases: any[] = [];
  let similarArtists: {name: string, coverUrl: string}[] = [];
  let isLoadingHome = true;
  let isLoadingMore = false;

  async function mixPlaylists(tracks: any[], existingPlaylists?: any[]) {
    try {
      const queries = ['phonk playlist', 'trap mix', 'gym hardstyle', 'chill lofi', 'русский рэп 2024', 'rap hits', 'bass boosted', 'хиты 2024', 'топ чарт россии', 'популярная музыка', 'vk hits', 'кальянный рэп', 'русская попса'];
      const randomQueries = queries.sort(() => 0.5 - Math.random()).slice(0, 3);
      
      let scPlaylists: any[] = [];
      for (const q of randomQueries) {
        const pls = await import('$lib/api').then(m => m.getSoundCloudPlaylists(q, 5));
        if (pls) scPlaylists.push(...pls);
      }
      
      const allPlaylists = [...(existingPlaylists || []), ...scPlaylists];
      allPlaylists.sort(() => 0.5 - Math.random());
      
      let resultTracks = [];
      let plIndex = 0;
      for (let i = 0; i < tracks.length; i++) {
        resultTracks.push(tracks[i]);
        if ((i + 1) % 20 === 0) {
          const numPlaylistsToInsert = Math.floor(Math.random() * 2) + 2; // 2 or 3
          for (let j = 0; j < numPlaylistsToInsert && plIndex < allPlaylists.length; j++) {
            resultTracks.push(allPlaylists[plIndex++]);
          }
        }
      }
      return resultTracks;
    } catch (e) {
      console.error('Failed to mix playlists', e);
      return tracks;
    }
  }

  async function loadMoreTracks() {
    isLoadingMore = true;
    try {
      const moreTracks = await getTrendingTracks($likedTracks, $listenStats, $searchHistory, $playlists);
      const mixedMoreTracks = await mixPlaylists(moreTracks);
      // Filter out duplicates
      const existingIds = new Set(trendingTracks.map(t => t.id));
      const newTracks = mixedMoreTracks.filter(t => !existingIds.has(t.id));
      trendingTracks = [...trendingTracks, ...newTracks];
    } catch (err) {
      console.error("Failed to load more tracks", err);
    }
    isLoadingMore = false;
  }

  async function refreshTracks() {
    isLoadingHome = true;
    try {
      let tracks = await getTrendingTracks($likedTracks, $listenStats, $searchHistory, $playlists);
      trendingTracks = await mixPlaylists(tracks, $playlists);
    } catch (err) {
      console.error("Failed to refresh tracks", err);
    }
    isLoadingHome = false;
  }

  let cachedTracksCount = 0;

  onMount(() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) greeting = 'Доброе утро';
    else if (hour >= 12 && hour < 18) greeting = 'Добрый день';
    else if (hour >= 18 && hour < 23) greeting = 'Добрый вечер';
    else greeting = 'Доброй ночи';
    // Specular Highlight mouse tracking with relative coordinates
    const handleMouseMove = (e: MouseEvent) => {
      const target = (e.target as HTMLElement)?.closest('.interactive-item') as HTMLElement;
      if (target) {
        const rect = target.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        target.style.setProperty('--mouse-x', `${x}px`);
        target.style.setProperty('--mouse-y', `${y}px`);
      }
    };
    window.addEventListener('mousemove', handleMouseMove);

    (async () => {
      let tracks = await getTrendingTracks($likedTracks, $listenStats, $searchHistory, $playlists);
      trendingTracks = await mixPlaylists(tracks, $playlists);
      
      try {
        const localTracks = await getTracks();
        const artistMap = new Map<string, string>();
        for (const t of localTracks) {
          if (!artistMap.has(t.artist) && t.artistAvatarUrl) {
            artistMap.set(t.artist, t.artistAvatarUrl);
          } else if (!artistMap.has(t.artist) && t.coverUrl) {
            artistMap.set(t.artist, t.coverUrl);
          }
        }
        similarArtists = Array.from(artistMap.entries()).slice(0, 15).map(([name, coverUrl]) => ({ name, coverUrl }));
      } catch (e) {
        console.error("Failed to load similar artists", e);
      }
      
      try {
        newReleases = await import('$lib/api').then(m => m.getNewReleases($likedTracks));
      } catch (e) {
        console.error("Failed to fetch new releases", e);
      }
      
      isLoadingHome = false;
      
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        osUsername = await invoke('get_os_username');
        const cachedList: string[] = await invoke('track_list_cached');
        cachedTracksCount = cachedList.length;
      } catch (e) {
        console.warn("Could not load cached tracks count", e);
      }
    })();

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
    };
  });

  function playTrack(track: any) {
    const idx = trendingTracks.findIndex(t => t.title === track.title && t.artist === track.artist);
    if (idx !== -1) {
      queue.set(trendingTracks.slice(idx + 1));
    }
    currentTrack.set(track);
    isPlaying.set(true);
  }

  // Navigation Logic
  let lastState: import('$lib/stores').NavState = { view: 'home', artist: '', search: '' };
  
  $: {
    const currentState = { view: $currentView, artist: $currentArtist, search: $searchQueryStore };
    if (currentState.view !== lastState.view || currentState.artist !== lastState.artist || currentState.search !== lastState.search) {
      if (!$isHistoryNavigation) {
        navHistory.update(h => [...h, lastState]);
        navFuture.set([]);
      }
      lastState = { ...currentState };
      $isHistoryNavigation = false;
    }
  }

  function goBack() {
    if ($navHistory.length > 0) {
      const history = $navHistory;
      const prev = history.pop();
      navHistory.set(history);
      
      navFuture.update(f => [...f, lastState]);
      
      $isHistoryNavigation = true;
      if (prev) {
        $currentArtist = prev.artist;
        $searchQueryStore = prev.search;
        $currentView = prev.view as any;
      }
    }
  }

  function goForward() {
    if ($navFuture.length > 0) {
      const future = $navFuture;
      const next = future.pop();
      navFuture.set(future);
      
      navHistory.update(h => [...h, lastState]);
      
      $isHistoryNavigation = true;
      if (next) {
        $currentArtist = next.artist;
        $searchQueryStore = next.search;
        $currentView = next.view as any;
      }
    }
  }
   let previousRoute = '';

</script>

<div class="h-screen w-screen flex flex-col bg-[var(--color-dark)] text-white font-sans overflow-hidden relative transition-colors duration-[1500ms]" use:gibberish>
  
  <!-- Main Area -->
  <div class="flex-1 flex overflow-hidden relative">
    
    <!-- Background -->
    <div class="absolute inset-0 pointer-events-none bg-[var(--color-dark)] overflow-hidden transition-colors duration-[1500ms]">
      {#if $currentTrack?.coverUrl}
        <div class="absolute inset-0 opacity-[0.15] blur-[100px] transition-all duration-1000" style="background-image: url('{$currentTrack.coverUrl}'); background-size: cover; background-position: center; transform: scale(1.2);"></div>
      {/if}
      <div class="absolute inset-0 bg-gradient-to-b from-[var(--color-dark-gradient)]/50 to-[var(--color-dark)] transition-colors duration-[1500ms]"></div>
    </div>

    <div class="flex w-full relative">
      {#if $currentView !== 'fullscreen'}
        <Sidebar />
      {/if}

      <!-- Main Content -->
      <main class="flex-1 overflow-y-auto overflow-x-hidden hide-scrollbar {$currentView === 'fullscreen' ? 'p-0' : 'px-8 pt-20 pb-32'} relative scroll-smooth">
    
    {#if $currentView !== 'fullscreen'}
      <div class="fixed top-6 left-[300px] z-50 flex items-center gap-3">
        <button 
          class="w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-md flex items-center justify-center text-white/80 hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          on:click={goBack}
          disabled={$navHistory.length === 0}
          title="Назад"
        >
          <ChevronLeft size={24} />
        </button>
        <button 
          class="w-10 h-10 rounded-full bg-black/40 hover:bg-black/60 backdrop-blur-md flex items-center justify-center text-white/80 hover:text-white transition-all disabled:opacity-30 disabled:cursor-not-allowed"
          on:click={goForward}
          disabled={$navFuture.length === 0}
          title="Вперед"
        >
          <ChevronRight size={24} />
        </button>
      </div>
    {/if}

    {#if $currentView === 'fullscreen'}
      <Fullscreen />
    {:else if $currentView === 'artist'}
      <ArtistPage />
    {:else if $currentView === 'home'}
      {#if isLoadingHome}
        <div class="w-full flex justify-center py-20 text-primary">
          <Loader2 class="animate-spin" size={40} />
        </div>
      {:else}
        <div class="w-full max-w-[1480px] {$settings.leftAlignTracks ? 'mr-auto ml-0' : 'mx-auto'} flex flex-col gap-10 relative z-10 pt-2" style="isolation: isolate;">
          <div class="space-y-16">
            {#if newReleases.length > 0}
              {#await import('$lib/components/ArchiveStation.svelte') then ArchiveStation}
                <svelte:component this={ArchiveStation.default} title="Новые релизы" tracks={newReleases} />
              {/await}
            {/if}

            {#await import('$lib/components/ArchiveStation.svelte') then ArchiveStation}
              <svelte:component this={ArchiveStation.default} title="Главная" tracks={trendingTracks} />
              
              <div class="w-full flex justify-center gap-4 mt-6 mb-4">
                <button 
                  class="glass-button px-8 py-3 rounded-2xl font-bold flex items-center gap-2 hover:bg-primary hover:text-black transition-all shadow-md"
                  on:click={loadMoreTracks}
                  disabled={isLoadingMore}
                >
                  {#if isLoadingMore}
                    <Loader2 class="animate-spin" size={18} /> Загрузка...
                  {:else}
                    Загрузить ещё треки
                  {/if}
                </button>

                <button 
                  class="glass-button px-8 py-3 rounded-2xl font-bold flex items-center gap-2 hover:bg-orange-500 hover:text-white transition-all shadow-md"
                  on:click={refreshTracks}
                  disabled={isLoadingHome}
                >
                  Обновить рекомендации
                </button>
              </div>
            {/await}

            {#if similarArtists.length > 0}
              {#await import('$lib/components/ArchiveStation.svelte') then ArchiveStation}
                <svelte:component this={ArchiveStation.default} title="Похожие авторы (Лайки)" tracks={similarArtists.map(a => ({title: a.name, artist: 'Похожий автор', coverUrl: a.coverUrl}))} />
              {/await}
            {/if}
          </div>
        </div>
      {/if}
    {:else if $currentView === 'search'}
      <Search />
    {:else if $currentView === 'lyrics'}
      <Lyrics />
    {:else if $currentView === 'library'}
      <Library />
    {:else if $currentView === 'settings'}
      <Settings />
    {:else if $currentView === 'equalizer'}
      <Equalizer />
    {:else if $currentView === 'profile'}
      <Profile />
    {:else}
      <div class="w-full h-full flex items-center justify-center text-neutral-500">
        <p>Вкладка {$currentView} не реализована...</p>
      </div>
    {/if}
    </main>
    </div>

    <!-- Moved Notifications and Player here so they are inside the overflow-hidden container! -->
    <Notifications />

    <div class="absolute bottom-0 left-0 w-full z-50">
      <Player />
    </div>
  </div>
</div>
