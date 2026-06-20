<script lang="ts">
  import { Search, Play } from 'lucide-svelte';
  import { searchQuery, currentView, currentTrack, isPlaying } from '$lib/stores';
  import { getTrendingTracks } from '$lib/api';

  export let username: string = 'User';
  export let greeting: string = 'Добрый вечер';
  
  async function startMagicShuffle() {
    // Starts "Моя волна" logic
    const tracks = await getTrendingTracks();
    if (tracks && tracks.length > 0) {
      import('$lib/stores').then(m => {
        m.queue.set(tracks.slice(1));
        m.currentTrack.set(tracks[0]);
        m.isPlaying.set(true);
      });
    }
  }

  function handleSearchSubmit() {
    if ($searchQuery.trim().length > 0) {
      currentView.set('search');
    }
  }
</script>

<div class="w-full flex flex-col items-center justify-center pt-16 pb-12 relative z-10">
  <h1 class="text-4xl md:text-5xl font-extrabold text-white/90 tracking-tight mb-8 drop-shadow-xl text-center">
    {greeting}, <span class="text-white">{username}</span>
  </h1>

  <div class="flex items-center gap-4 w-full max-w-2xl px-4">
    <!-- Search Bar -->
    <div class="relative flex-1 group">
      <div class="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-white/50 group-focus-within:text-primary transition-colors">
        <Search size={20} />
      </div>
      <input 
        type="text" 
        bind:value={$searchQuery}
        on:keydown={(e) => e.key === 'Enter' && handleSearchSubmit()}
        placeholder="Поиск треков, артистов..." 
        class="w-full bg-white/5 hover:bg-white/10 focus:bg-white/10 border border-white/10 focus:border-primary/50 text-white rounded-full py-3.5 pl-12 pr-6 outline-none transition-all duration-300 backdrop-blur-xl shadow-lg"
      />
    </div>

    <!-- Magic Shuffle Button -->
    <button 
      on:click={startMagicShuffle}
      class="flex-shrink-0 bg-primary/20 hover:bg-primary/40 text-primary hover:text-white border border-primary/30 rounded-full p-3.5 transition-all duration-300 hover:scale-105 active:scale-95 shadow-lg group"
      title="Моя волна (Magic Shuffle)"
    >
      <Play fill="currentColor" size={24} class="group-hover:text-white" />
    </button>
  </div>
</div>
