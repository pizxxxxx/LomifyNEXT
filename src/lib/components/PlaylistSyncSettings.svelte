<script lang="ts">
  import { settings } from '$lib/stores';
  import { playlistSyncStatus, syncPlaylists } from '$lib/playlistSync';
  let { provider }: { provider: 'yandex' | 'soundcloud' } = $props();
  const active = $derived(provider === 'yandex' ? $settings.syncYandexPlaylists : $settings.syncSoundCloudPlaylists);
  const state = $derived($playlistSyncStatus[provider]);
  function toggle(event: Event) {
    const checked = (event.currentTarget as HTMLInputElement).checked;
    settings.update(value => ({ ...value, [provider === 'yandex' ? 'syncYandexPlaylists' : 'syncSoundCloudPlaylists']: checked }));
    if (checked) void syncPlaylists(provider).catch(() => {});
  }
</script>
<section class="playlist-sync-settings" aria-label="Синхронизация плейлистов">
  <label><input type="checkbox" checked={active} onchange={toggle} /><span><strong>Синхронизация плейлистов</strong><small>{provider === 'yandex' ? 'Яндекс Музыка, телефон и ПК' : 'Обновление из публичного профиля SoundCloud'}</small></span></label>
  <p>{provider === 'yandex' ? 'Включи на телефоне и ПК и подключи один аккаунт Яндекса. Добавление и удаление треков, порядок и название твоих плейлистов будут обновляться в обе стороны.' : 'Новые плейлисты и изменения из SoundCloud появятся в Lomify на телефоне и ПК. Местные правки сохраняются только в Lomify.'}</p>
  <p>{provider === 'yandex' ? 'Чтобы связать свою местную подборку, открой её в медиатеке и нажми «Связать с Яндексом». Скрытие целого плейлиста из Lomify не удаляет его в Яндексе.' : 'Подключи одинаковый профиль на обоих устройствах. Запись в SoundCloud по публичному профилю недоступна.'}</p>
  {#if active}
    <button type="button" disabled={state.busy} onclick={() => void syncPlaylists(provider).catch(() => {})}>{state.busy ? 'Сверяем плейлисты...' : 'Сверить сейчас'}</button>
  {/if}
  {#if active || state.message}<span role="status" aria-live="polite">{state.message || 'Автоматически при открытии приложения и после местных изменений.'}</span>{/if}
  {#if state.error}<p class="sync-error" role="alert">{state.error}</p>{/if}
</section>
<style>
  .playlist-sync-settings { padding: 16px; margin: 14px 0; border: 1px solid rgb(255 255 255 / .12); border-radius: 18px; background: rgb(255 255 255 / .035); color: inherit; }
  label { display: flex; align-items: center; gap: 12px; cursor: pointer; min-height: 44px; }
  label span { display: grid; gap: 4px; } strong { font-size: 15px; font-weight: 650; }
  small, p, section > span { font-size: 13px; line-height: 1.5; color: rgb(255 255 255 / .65); }
  input { width: 20px; height: 20px; flex: 0 0 auto; accent-color: var(--color-primary, #8cbfa0); }
  p { margin: 12px 0 0; } button { display: block; margin: 14px 0 8px; padding: 10px 16px; min-height: 44px; border: 1px solid rgb(255 255 255 / .16); border-radius: 12px; background: rgb(255 255 255 / .08); color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
  button:disabled { opacity: .55; cursor: wait; } button:focus-visible, input:focus-visible { outline: 2px solid var(--color-primary, #8cbfa0); outline-offset: 4px; }
  .sync-error { color: #ffb9b9; } section > span { display: block; overflow-wrap: anywhere; }
</style>
