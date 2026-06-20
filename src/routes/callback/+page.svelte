<script lang="ts">
  import { onMount } from 'svelte';
  
  onMount(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    
    if (code) {
      // Save code to localStorage so the main app window can read it
      localStorage.setItem('spotify_auth_code', code);
      // Close the popup/tab
      setTimeout(() => {
        window.close();
      }, 2000);
    }
  });
</script>

<div class="h-screen w-screen flex flex-col items-center justify-center bg-black text-white font-sans">
  <div class="glass-panel p-8 rounded-2xl flex flex-col items-center gap-4">
    <svg class="animate-spin h-8 w-8 text-[#1db954]" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
    <h1 class="text-2xl font-bold">Авторизация Spotify...</h1>
    <p class="text-neutral-400">Пожалуйста, подождите. Окно закроется автоматически.</p>
  </div>
</div>
