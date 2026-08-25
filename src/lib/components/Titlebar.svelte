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

<!-- Полоса окна лежит поверх всего интерфейса, поэтому сама она events не принимает:
     иначе прозрачные 36px по всей ширине съедали бы клики по верхней кромке сайдбара
     (он начинается с 32px) и по всему, что окажется под ними. Кликабельны только
     светофор и зона перетаскивания — они возвращают себе `pointer-events` явно. -->
<div
  class="fixed top-0 inset-x-0 z-[50] h-[36px] flex items-center px-4 select-none pointer-events-none"
>
  <!-- LEFT: macOS style traffic lights
       Кнопки окна срабатывают на отпускании (`data-press-late`), а не на нажатии, как
       остальные в приложении. Три круга по 12px стоят вплотную у самого края экрана —
       промахнуться легко, а отменить нечем: закрытие ничего не спрашивает и уносит с собой
       всё окно. Отпускание оставляет выход — отвести курсор и отпустить мимо. Разбор
       компромисса — в `$lib/utils/press`. -->
  <div class="flex items-center gap-[8px] group shrink-0 z-[60] pointer-events-auto">
    <!-- Close -->
    <button
      type="button"
      aria-label="Close"
      title="Close"
      data-press-late
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
      data-press-late
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
      data-press-late
      on:click={toggleMaximize}
      class="w-3 h-3 rounded-full bg-[#27c93f] flex items-center justify-center opacity-80 hover:opacity-100 transition-opacity cursor-pointer"
    >
      <div class="hidden group-hover:block w-[5px] h-[5px] border border-black/40 rotate-45"></div>
    </button>
  </div>

  <!-- CENTER/RIGHT: Drag Region (takes all empty space) -->
  <div class="flex-1 h-full pointer-events-auto" data-tauri-drag-region></div>
</div>
