<script lang="ts">
  import { settings } from '$lib/stores';
  import { pausePlaylistSync, playlistSyncStatus, publishPlaylistToYandex, resolvePlaylistConflict, syncPlaylists } from '$lib/playlistSync';
  let { playlist }: { playlist: any } = $props();
  let busy = $state(false), error = $state('');
  const link = $derived(playlist.sync);
  const provider: 'yandex' | 'soundcloud' = $derived(link?.provider || 'yandex');
  const active = $derived(provider === 'yandex' ? $settings.syncYandexPlaylists : $settings.syncSoundCloudPlaylists);
  const wrongAccount = $derived(link && String(provider === 'yandex' ? $settings.yandexUser?.uid || '' : $settings.scUser?.id || '') !== link.accountId);
  async function action(work: () => Promise<unknown>) {
    if (busy) return;
    busy = true; error = '';
    try { await work(); } catch (reason) { error = (reason as Error).message || 'Не удалось завершить сверку.'; } finally { busy = false; }
  }
  function resume() {
    settings.update(value => ({ ...value, [provider === 'yandex' ? 'syncYandexPlaylists' : 'syncSoundCloudPlaylists']: true }));
    pausePlaylistSync(String(playlist.id), false);
    void action(() => syncPlaylists(provider));
  }
</script>
{#if link || $settings.yandexToken}
  <div class="playlist-sync-control">
    {#if link}
      <div class="sync-description"><strong>{provider === 'yandex' ? 'Яндекс Музыка' : 'SoundCloud'}</strong><span>{wrongAccount ? 'Подключён другой аккаунт. Местная копия сохранена.' : link.conflict ? 'Этот плейлист изменили на обоих устройствах. Выбери, какую версию сохранить.' : link.paused || !active ? 'Синхронизация приостановлена' : provider === 'soundcloud' ? 'Обновляется из SoundCloud. Местные правки остаются в Lomify.' : link.ownerId !== link.accountId ? 'Чужой плейлист. Только обновление из Яндекса.' : 'Название, порядок и треки синхронизируются в обе стороны.'}</span></div>
      {#if !wrongAccount}
        <div class="sync-actions">
          {#if link.conflict && active && !link.paused}
            <button type="button" disabled={busy} onclick={() => void action(() => resolvePlaylistConflict(String(playlist.id), 'remote'))}>Версия {provider === 'yandex' ? 'Яндекса' : 'SoundCloud'}</button>
            <button type="button" disabled={busy} onclick={() => void action(() => resolvePlaylistConflict(String(playlist.id), 'local'))}>Моя версия</button>
          {:else if link.paused || !active}
            <button type="button" disabled={busy} onclick={resume}>Возобновить</button>
          {:else}
            <button type="button" disabled={busy || $playlistSyncStatus[provider].busy} onclick={() => void action(() => syncPlaylists(provider))}>Сверить</button>
            <button type="button" disabled={busy} onclick={() => pausePlaylistSync(String(playlist.id), true)}>Приостановить</button>
          {/if}
        </div>
      {/if}
    {:else}
      <div class="sync-description"><strong>На телефоне и ПК</strong><span>Свяжи подборку с Яндексом. Новый плейлист будет доступен только тебе.</span></div>
      <button type="button" disabled={busy} onclick={() => void action(() => publishPlaylistToYandex(String(playlist.id)))}>{busy ? 'Связываем...' : 'Связать с Яндексом'}</button>
    {/if}
    {#if error || link?.error}<p role="alert">{error || link?.error}</p>{/if}
  </div>
{/if}
<style>
  .playlist-sync-control { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin: 18px 0; padding: 14px 16px; border: 1px solid rgb(255 255 255 / .12); border-radius: 18px; background: rgb(255 255 255 / .035); color: inherit; }
  .sync-description { display: grid; gap: 5px; flex: 1 1 200px; min-width: 0; } strong { font-size: 14px; font-weight: 650; }
  span { font-size: 13px; line-height: 1.5; color: rgb(255 255 255 / .65); overflow-wrap: anywhere; }
  .sync-actions { display: flex; flex-wrap: wrap; gap: 8px; } button { min-height: 44px; padding: 10px 14px; border-radius: 12px; border: 1px solid rgb(255 255 255 / .16); background: rgb(255 255 255 / .08); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
  button:disabled { opacity: .55; cursor: wait; } button:focus-visible { outline: 2px solid var(--color-primary, #8cbfa0); outline-offset: 4px; }
  p { flex: 1 1 100%; margin: 0; color: #ffb9b9; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
</style>
