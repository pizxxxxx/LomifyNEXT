<script lang="ts">
  import '../app.css';
  import { settings, initStore } from '$lib/stores';
  import Titlebar from '$lib/components/Titlebar.svelte';
  import { onMount } from 'svelte';
  import { AlertTriangle } from 'lucide-svelte';
  import { setLiquidGlassEffect, isGlassSupported } from "tauri-plugin-liquid-glass-api";

  let showStartupWarning = false;

  function dismissWarning() {
    showStartupWarning = false;
    sessionStorage.setItem('lomify_unstable_warning_v2', 'true');
  }

  onMount(() => {
    initStore();
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('discord_connect').catch(console.error);
      });
      
      const hasSeenWarning = sessionStorage.getItem('lomify_unstable_warning_v2');
      if (!hasSeenWarning) {
        showStartupWarning = true;
      }
    }
  });

  $: {
    if (typeof document !== 'undefined' && $settings) {
      if ($settings.theme) {
        document.body.setAttribute('data-theme', $settings.theme);
      }
      document.body.setAttribute('data-ui-style', $settings.uiStyle || 'style1');
      document.body.setAttribute('data-global-theme', $settings.globalThemeEffect ? 'true' : 'false');
      
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        isGlassSupported().then((supported) => {
          if (supported) {
            setLiquidGlassEffect({
              enabled: $settings.uiStyle === 'style3',
              cornerRadius: 24
            }).catch(console.error);
            
            if ($settings.uiStyle === 'style3') {
              document.body.style.setProperty('background-color', 'transparent', 'important');
              document.documentElement.style.setProperty('background', 'transparent', 'important');
            } else {
              document.body.style.removeProperty('background-color');
              document.documentElement.style.removeProperty('background');
            }
          } else if ($settings.uiStyle === 'style3') {
            $settings.uiStyle = 'style1';
          }
        });
      }
    }
  }
</script>

<Titlebar />
<slot />

{#if showStartupWarning}
  <div class="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-md transition-opacity">
    <div class="glass-panel max-w-md w-full mx-4 p-8 rounded-3xl shadow-2xl relative flex flex-col items-center text-center animate-in fade-in zoom-in duration-300 border border-white/5">
      <div class="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center text-yellow-500 mb-6 shadow-[0_0_20px_rgba(234,179,8,0.3)]">
        <AlertTriangle size={32} />
      </div>
      <h2 class="text-2xl font-bold mb-3 text-white">Внимание</h2>
      <p class="text-neutral-300 mb-8 leading-relaxed">
        Это <span class="text-yellow-400 font-bold">нестабильная версия</span> LomifyNEXT.<br/>В ней могут встречаться баги, недочеты или временные сбои в работе.
      </p>
      <button 
        class="w-full py-4 rounded-xl font-bold transition-all bg-white text-black hover:bg-neutral-200 shadow-[0_0_20px_rgba(255,255,255,0.2)] hover:scale-[1.02]"
        on:click={dismissWarning}
      >
        Понятно, продолжить
      </button>
    </div>
  </div>
{/if}
