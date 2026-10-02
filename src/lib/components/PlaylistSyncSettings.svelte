<script lang="ts">
  /**
   * Карточка синхронизации в настройках. Переключателем здесь была системная галочка с
   * `accent-color` - то есть квадратик, который рисует сама Windows своим зелёным и своими
   * углами. В окне, где все остальные переключатели настроек - тумблеры приложения, он
   * читался как вставка из другой программы. Теперь это тот же `.switch`, что и во всех
   * остальных строках настроек, и карточка собрана из тех же `.setting-title`,
   * `.setting-hint` и `.settings-action-button`.
   */
  import { settings } from '$lib/stores';
  import { playlistSyncStatus, syncPlaylists } from '$lib/playlistSync';
  let { provider }: { provider: 'yandex' | 'soundcloud' } = $props();
  const active = $derived(provider === 'yandex' ? $settings.syncYandexPlaylists : $settings.syncSoundCloudPlaylists);
  const state = $derived($playlistSyncStatus[provider]);
  function toggle() {
    const next = !active;
    settings.update(value => ({ ...value, [provider === 'yandex' ? 'syncYandexPlaylists' : 'syncSoundCloudPlaylists']: next }));
    if (next) void syncPlaylists(provider).catch(() => {});
  }
</script>
<section class="playlist-sync-settings" aria-label="Синхронизация плейлистов">
  <div class="sync-head">
    <div class="sync-copy">
      <div class="setting-title">Синхронизация плейлистов</div>
      <div class="setting-hint">{provider === 'yandex' ? 'Яндекс Музыка, телефон и ПК' : 'Обновление из публичного профиля SoundCloud'}</div>
    </div>
    <button
      type="button"
      class="switch"
      role="switch"
      aria-checked={active}
      aria-label="Синхронизация плейлистов"
      onclick={toggle}
    >
      <span class="switch-knob"></span>
    </button>
  </div>
  <p>{provider === 'yandex' ? 'Включи на телефоне и ПК и подключи один аккаунт Яндекса. Добавление и удаление треков, порядок и название твоих плейлистов будут обновляться в обе стороны.' : 'Новые плейлисты и изменения из SoundCloud появятся в Lomify на телефоне и ПК. Местные правки сохраняются только в Lomify.'}</p>
  <p>{provider === 'yandex' ? 'Чтобы связать свою местную подборку, открой её в медиатеке и нажми «Связать с Яндексом». Скрытие целого плейлиста из Lomify не удаляет его в Яндексе.' : 'Подключи одинаковый профиль на обоих устройствах. Запись в SoundCloud по публичному профилю недоступна.'}</p>
  {#if active}
    <button type="button" class="settings-action-button sync-run" disabled={state.busy} onclick={() => void syncPlaylists(provider).catch(() => {})}>{state.busy ? 'Сверяем плейлисты...' : 'Сверить сейчас'}</button>
  {/if}
  {#if active || state.message}
    <div class="sync-status" class:is-busy={state.busy} role="status" aria-live="polite">
      <span class="sync-status-dot" aria-hidden="true"></span>
      <span>{state.message || 'Автоматически при открытии приложения и после местных изменений.'}</span>
    </div>
  {/if}
  {#if state.error}<p class="sync-error" role="alert">{state.error}</p>{/if}
</section>
<style>
  .playlist-sync-settings { padding: 15px 18px; margin: 14px 0; border: 1px solid rgb(255 255 255 / .05); border-radius: 15px; background: rgb(0 0 0 / .18); color: inherit; }
  .sync-head { display: flex; align-items: center; justify-content: space-between; gap: 24px; min-height: 30px; }
  .sync-copy { min-width: 0; }
  p { margin: 12px 0 0; font-size: 12.5px; line-height: 1.45; color: rgb(255 255 255 / .42); max-width: 54ch; }
  .sync-run { margin: 14px 0 0; }
  .sync-status { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; font-size: 12.5px; line-height: 1.45; color: rgb(255 255 255 / .5); overflow-wrap: anywhere; }
  /* Точка состояния: пока сверка идёт - она дышит, после неё просто остаётся на месте.
     Это единственный индикатор прогресса в карточке, кнопка на время сверки недоступна. */
  .sync-status-dot { flex: 0 0 auto; width: 6px; height: 6px; margin-top: 6px; border-radius: 999px; background: rgb(255 255 255 / .26); transition: background 200ms ease; }
  .sync-status.is-busy .sync-status-dot { background: var(--color-primary, #8cbfa0); animation: sync-dot-pulse 1.1s var(--ease-out, ease-in-out) infinite; }
  @keyframes sync-dot-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .sync-status.is-busy .sync-status-dot { animation: none; } }
  .sync-error { color: #ffb9b9; }
</style>
