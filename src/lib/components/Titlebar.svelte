<script lang="ts">
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { Minus, Square, X } from 'lucide-svelte';
  import { saveWindowState, StateFlags } from '@tauri-apps/plugin-window-state';
  
  function minimize() {
    getCurrentWindow().minimize();
  }

  function toggleMaximize() {
    getCurrentWindow().toggleMaximize();
  }

  async function closeWindow() {
    try {
      await saveWindowState(StateFlags.ALL);
    } catch(e) {}
    getCurrentWindow().close();
  }
</script>

<div 
  class="fixed top-0 inset-x-0 z-[50] h-[36px] flex items-center px-4 select-none"
>
  <!-- LEFT: macOS style traffic lights -->
  <div class="flex items-center gap-[8px] group shrink-0 z-[60]">
    <!-- Close -->
    <button
      type="button"
      aria-label="Close"
      title="Close"
      on:click={closeWindow}
      class="w-3 h-3 rounded-full bg-[#ff5f56] flex items-center justify-center opacity-80 hover:opacity-100 transition-opacity cursor-pointer"
    >
      <div class="hidden group-hover:block w-1.5 h-1.5 bg-black/40 rounded-full"></div>
    </button>
    <!-- Minimize -->
    <button
      type="button"
      aria-label="Minimize"
      title="Minimize"
      on:click={minimize}
      class="w-3 h-3 rounded-full bg-[#ffbd2e] flex items-center justify-center opacity-80 hover:opacity-100 transition-opacity cursor-pointer"
    >
      <div class="hidden group-hover:block w-1.5 h-[2px] bg-black/40 rounded-full"></div>
    </button>
    <!-- Maximize -->
    <button
      type="button"
      aria-label="Maximize"
      title="Maximize"
      on:click={toggleMaximize}
      class="w-3 h-3 rounded-full bg-[#27c93f] flex items-center justify-center opacity-80 hover:opacity-100 transition-opacity cursor-pointer"
    >
      <div class="hidden group-hover:block w-[5px] h-[5px] border border-black/40 rotate-45"></div>
    </button>
  </div>

  <!-- CENTER/RIGHT: Drag Region (takes all empty space) -->
  <div class="flex-1 h-full" data-tauri-drag-region></div>
</div>
