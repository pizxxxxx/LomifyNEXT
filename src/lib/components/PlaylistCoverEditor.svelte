<script lang="ts">
  import { ImagePlus, ListMusic, Loader2, RotateCcw } from 'lucide-svelte';
  import { playlists, flushPlaylistStorage } from '$lib/stores';
  import { downloadedCoverCache } from '$lib/offlineCovers';
  import { playlistCoverUrl, preparePlaylistCover, type PlaylistWithCover } from '$lib/playlistCover';

  let { playlist }: { playlist: PlaylistWithCover } = $props();
  let input: HTMLInputElement;
  let busy = $state(false);
  let saveFailed = $state(false);
  let error = $state('');
  let status = $state('');
  const cover = $derived(playlistCoverUrl(playlist, $downloadedCoverCache));

  async function persist(message: string) {
    saveFailed = false;
    status = 'Сохраняем обложку...';
    try {
      await flushPlaylistStorage();
      status = message;
    } catch {
      saveFailed = true;
      status = '';
      error = 'Не удалось сохранить обложку. Проверь свободное место и повтори сохранение.';
    }
  }

  async function applyCover(id: string | number, customCoverUrl: string | null) {
    let found = false;
    playlists.update(items => items.map(item => {
      if (item.id !== id) return item;
      found = true;
      if (customCoverUrl) return { ...item, customCoverUrl };
      const { customCoverUrl: previousCover, ...rest } = item;
      return rest;
    }));
    if (!found) throw new Error('Плейлист уже удалён. Открой другой плейлист.');
    await persist(customCoverUrl ? 'Обложка сохранена.' : 'Обычная обложка восстановлена.');
  }

  async function chooseFile(event: Event) {
    const field = event.currentTarget as HTMLInputElement;
    const file = field.files?.[0];
    field.value = '';
    if (!file || busy) return;
    const id = playlist.id;
    busy = true;
    error = '';
    status = 'Готовим обложку...';
    try {
      await applyCover(id, await preparePlaylistCover(file));
    } catch (cause) {
      status = '';
      error = cause instanceof Error ? cause.message : 'Не удалось изменить обложку. Попробуй другой файл.';
    } finally {
      busy = false;
    }
  }

  async function resetCover() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await applyCover(playlist.id, null);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Не удалось вернуть обычную обложку.';
    } finally {
      busy = false;
    }
  }

  async function retrySave() {
    if (busy) return;
    busy = true;
    error = '';
    await persist('Обложка сохранена.');
    busy = false;
  }
</script>

<div class="playlist-cover-editor" aria-busy={busy}>
  <input bind:this={input} type="file" accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp" onchange={chooseFile} hidden />
  <button
    type="button"
    class="library-playlist-detail-cover cover-trigger"
    onclick={() => input.click()}
    disabled={busy}
    aria-label={`Изменить обложку плейлиста «${playlist.title}»`}
    title="Выбрать обложку JPG, PNG или WebP до 20 МБ"
  >
    {#if cover}
      <img src={cover} alt="" decoding="async" />
    {:else}
      <ListMusic size={46} aria-hidden="true" />
    {/if}
    <span class="cover-edit-label">
      {#if busy}<Loader2 size={15} class="animate-spin" aria-hidden="true" />{:else}<ImagePlus size={15} aria-hidden="true" />{/if}
      <span>{busy ? 'Сохраняем...' : 'Изменить обложку'}</span>
    </span>
  </button>
  <div class="cover-footer">
    {#if playlist.customCoverUrl}
      <button type="button" class="cover-reset" onclick={resetCover} disabled={busy}>
        <RotateCcw size={13} aria-hidden="true" /> Обычная обложка
      </button>
    {:else}
      <span>JPG, PNG, WebP до 20 МБ</span>
    {/if}
  </div>
  {#if error}
    <p class="cover-error" role="alert">{error}</p>
    {#if saveFailed}
      <button type="button" class="cover-retry" onclick={retrySave} disabled={busy}>Повторить сохранение</button>
    {/if}
  {/if}
  <span class="sr-only" role="status">{status}</span>
</div>

<style>
  .playlist-cover-editor { min-width: 0; }

  .cover-trigger {
    position: relative;
    width: 100%;
    padding: 0;
    cursor: pointer;
  }

  .cover-trigger img { position: absolute; inset: 0; }

  .cover-edit-label {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    inset: auto 0.55rem 0.55rem;
    min-height: 2rem;
    padding: 0.45rem 0.35rem;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 0.8rem;
    background: rgba(12, 12, 15, 0.86);
    color: #fff;
    font-size: 0.68rem;
    font-weight: 650;
    line-height: 1.3;
    transition: background-color 150ms ease;
  }

  @media (hover: hover) and (pointer: fine) {
    .cover-trigger:hover:not(:disabled) .cover-edit-label { background: #18181b; }
    .cover-reset:hover:not(:disabled) { color: #fff; }
  }

  button:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 3px; }
  button:disabled { cursor: wait; opacity: 0.6; }

  .cover-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 2rem;
    margin-top: 0.3rem;
    color: rgba(255, 255, 255, 0.65);
    font-size: 0.65rem;
    text-align: center;
  }

  .cover-reset {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 2rem;
    padding: 0.3rem 0.4rem;
    border-radius: 0.5rem;
    cursor: pointer;
  }

  .cover-error {
    margin: 0.4rem 0;
    color: #fecaca;
    font-size: 0.72rem;
    line-height: 1.5;
  }

  .cover-retry {
    min-height: 2rem;
    color: #f5f5f5;
    font-size: 0.72rem;
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  @media (max-width: 470px) {
    .playlist-cover-editor { width: min(10.5rem, 56vw); }
  }

  @media (prefers-reduced-motion: reduce) {
    .cover-edit-label { transition: none; }
  }
</style>
