<script lang="ts">
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { Minus, Square, X } from 'lucide-svelte';
  import { saveWindowState, StateFlags } from '@tauri-apps/plugin-window-state';
  import { settings } from '$lib/stores';

  $: controlsStyle = $settings.windowControlsStyle === 'macos' ? 'macos' : 'windows';
  
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

<!-- Оба набора полностью кастомные: системная рамка Windows в tauri.conf отключена.
     Кнопки срабатывают на отпускании (`data-press-late`), чтобы закрытие можно было
     отменить, отведя курсор. Пустая середина остаётся областью перетаскивания. -->
<div class="lomify-titlebar is-{controlsStyle}">
  {#if controlsStyle === 'macos'}
    <div class="window-controls is-macos">
      <button type="button" class="window-control is-close" aria-label="Закрыть окно" title="Закрыть" data-press-late on:click={closeWindow}>
        <X size={8} strokeWidth={2.6} aria-hidden="true" />
      </button>
      <button type="button" class="window-control is-minimize" aria-label="Свернуть окно" title="Свернуть" data-press-late on:click={minimize}>
        <Minus size={8} strokeWidth={2.6} aria-hidden="true" />
      </button>
      <button type="button" class="window-control is-maximize" aria-label="Развернуть окно" title="Развернуть" data-press-late on:click={toggleMaximize}>
        <Square size={7} strokeWidth={2.2} aria-hidden="true" />
      </button>
    </div>
  {/if}

  <div class="titlebar-drag-region" data-tauri-drag-region></div>

  {#if controlsStyle === 'windows'}
    <div class="window-controls is-windows">
      <button type="button" class="window-control is-minimize" aria-label="Свернуть окно" title="Свернуть" data-press-late on:click={minimize}>
        <Minus size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>
      <button type="button" class="window-control is-maximize" aria-label="Развернуть окно" title="Развернуть" data-press-late on:click={toggleMaximize}>
        <Square size={11} strokeWidth={1.7} aria-hidden="true" />
      </button>
      <button type="button" class="window-control is-close" aria-label="Закрыть окно" title="Закрыть" data-press-late on:click={closeWindow}>
        <X size={15} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  {/if}
</div>
