<script lang="ts">
  import { tick } from 'svelte';
  import { Shuffle, ListMusic, Undo2 } from 'lucide-svelte';
  import { flushPlaylistStorage, playlists } from '$lib/stores';
  import { shufflePlaylist, smartShufflePlaylist, undoPlaylistShuffle, type OrderedPlaylist } from '$lib/utils/playlistOrder';

  let { playlist }: { playlist: OrderedPlaylist } = $props();
  let saving = $state(false);
  let saveFailed = $state(false);
  let announcement = $state('');
  let shuffleButton: HTMLButtonElement;
  const canUndo = $derived(Array.isArray(playlist.shuffleOriginalOrder));
  const tooShort = $derived((playlist.tracks?.length ?? 0) < 2);

  async function saveOrder(message: string) {
    saving = true;
    saveFailed = false;
    try {
      await flushPlaylistStorage();
      announcement = message;
    } catch {
      saveFailed = true;
      announcement = 'Порядок изменён, но не сохранён. Проверь свободное место и повтори сохранение.';
    } finally {
      saving = false;
    }
  }

  async function changeOrder(mode: 'shuffle' | 'smart' | 'undo' = 'shuffle') {
    if (saving) return;
    let changed = false;
    playlists.update(items => items.map(item => {
      if (item.id !== playlist.id) return item;
      const next = mode === 'undo' ? undoPlaylistShuffle(item)
        : mode === 'smart' ? smartShufflePlaylist(item) : shufflePlaylist(item);
      changed = next !== item;
      return next;
    }));
    if (!changed) return;
    await saveOrder(mode === 'undo' ? 'Исходный порядок восстановлен.'
      : mode === 'smart' ? 'Треки перемешаны с чередованием исполнителей. Новый порядок сохранён.'
      : 'Все треки перемешаны. Новый порядок сохранён.');
    // Undo disappears after restoring, so keep keyboard focus in this control group.
    if (mode === 'undo') {
      await tick();
      shuffleButton?.focus({ preventScroll: true });
    }
  }
</script>

<div class="playlist-order" aria-busy={saving}>
  <div class="order-buttons" role="group" aria-label="Порядок треков">
    <button
      type="button"
      class={['shuffle-button', { 'has-shuffle': canUndo }]}
      bind:this={shuffleButton}
      disabled={tooShort || saving}
      onclick={() => changeOrder()}
      title={tooShort ? 'Нужно хотя бы два трека' : 'Перемешать все треки в плейлисте'}
    >
      <Shuffle size={15} aria-hidden="true" />
      <span>Перемешать</span>
    </button>
    <button
      type="button"
      disabled={tooShort || saving}
      onclick={() => changeOrder('smart')}
      title={tooShort ? 'Нужно хотя бы два трека' : 'Перемешать весь плейлист, по возможности разделяя треки одного исполнителя'}
    >
      <ListMusic size={15} aria-hidden="true" />
      <span>Умно перемешать</span>
    </button>
    {#if canUndo}
      <button
        type="button"
        class="undo-button"
        disabled={saving}
        onclick={() => changeOrder('undo')}
        title="Вернуть порядок до первого перемешивания"
        aria-label="Отменить перемешивание"
      >
        <Undo2 size={15} aria-hidden="true" />
        <span>Отменить</span>
      </button>
    {/if}
  </div>
  <p class={['order-hint', { 'is-error': saveFailed }]}>
    {#if saveFailed}
      Не удалось сохранить. Проверь свободное место.
      <button type="button" class="retry-button" onclick={() => saveOrder('Порядок сохранён.')} disabled={saving}>Повторить</button>
    {:else if canUndo}
      Новый порядок, те же треки
    {:else if tooShort}
      Нужно хотя бы два трека
    {:else}
      Меняет порядок всего плейлиста
    {/if}
  </p>
  <span class="sr-only" role="status">{announcement}</span>
</div>

<style>
  .playlist-order {
    --order-text: #f5f5f5;
    min-width: 0;
    margin-left: auto;
  }

  .order-buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .order-buttons button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.45rem;
    min-height: 2.5rem;
    padding: 0.55rem 0.85rem;
    border: 1px solid color-mix(in srgb, var(--order-text) 14%, transparent);
    border-radius: 0.8rem;
    background: color-mix(in srgb, var(--order-text) 5%, transparent);
    color: var(--order-text);
    font-size: 0.76rem;
    font-weight: 650;
    cursor: pointer;
    transition: background-color 150ms ease, border-color 150ms ease,
                transform 120ms cubic-bezier(0.23, 1, 0.32, 1);
  }

  .order-buttons .has-shuffle {
    border-color: color-mix(in srgb, var(--color-primary) 40%, transparent);
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
  }

  .order-buttons .undo-button {
    background: transparent;
  }

  @media (hover: hover) and (pointer: fine) {
    .order-buttons button:hover:not(:disabled) {
      border-color: color-mix(in srgb, var(--order-text) 30%, transparent);
      background: color-mix(in srgb, var(--order-text) 10%, transparent);
    }
  }

  .order-buttons button:active:not(:disabled):not(:focus-visible) {
    transform: scale(0.97);
  }

  button:focus-visible {
    outline: 2px solid var(--color-primary);
    outline-offset: 3px;
  }

  .order-buttons button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .order-hint {
    margin: 0.45rem 0 0;
    color: color-mix(in srgb, var(--order-text) 65%, transparent);
    font-size: 0.72rem;
    text-align: right;
  }

  .retry-button {
    margin-left: 0.4rem;
    min-height: 1.5rem;
    color: var(--order-text);
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .is-error {
    color: var(--order-text);
  }

  @media (prefers-reduced-motion: reduce) {
    .order-buttons button {
      transition: none;
    }

    .order-buttons button:active:not(:disabled):not(:focus-visible) {
      transform: none;
    }
  }
</style>
