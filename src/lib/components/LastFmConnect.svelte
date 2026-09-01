<script lang="ts">
  import { onMount } from 'svelte';
  import { BarChart3, Check, Clock3, ClipboardCopy, ExternalLink, Headphones, KeyRound, Loader2, RefreshCw, Radio, TriangleAlert } from 'lucide-svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { notify } from '$lib/stores';
  import {
    LASTFM_CONFIGURED_API_KEY,
    LASTFM_CONFIGURED_SHARED_SECRET,
    LASTFM_CREATE_APP_URL,
    beginLastFmAuthorization,
    disconnectLastFm,
    finishLastFmAuthorization,
    getCachedLastFmOverview,
    getLastFmOverview,
    getLastFmSession,
    hasPendingLastFmAuthorization,
    type LastFmOverview,
    type LastFmSession
  } from '$lib/lastfm';
  import MusicServiceIcon from './MusicServiceIcon.svelte';

  const hasAppCredentials = Boolean(LASTFM_CONFIGURED_API_KEY && LASTFM_CONFIGURED_SHARED_SECRET);
  const LASTFM_APP_NAME = 'LomifyNEXT';
  const LASTFM_APP_DESCRIPTION = 'Desktop music player with Last.fm Now Playing and scrobbling support.';
  const LASTFM_APP_HOMEPAGE = 'https://github.com/pizxxxxx/LomifyNEXT';
  const LASTFM_RUSSIA_HELP_URL = 'https://support.last.fm/t/did-last-fm-just-block-russia/117851';
  let apiKey = LASTFM_CONFIGURED_API_KEY;
  let sharedSecret = LASTFM_CONFIGURED_SHARED_SECRET;
  let session: LastFmSession | null = null;
  let overview: LastFmOverview | null = null;
  let overviewLoading = false;
  let overviewError = '';
  let authorizationPending = false;
  let busy = false;

  onMount(() => {
    session = getLastFmSession();
    overview = getCachedLastFmOverview();
    authorizationPending = hasPendingLastFmAuthorization();
    if (session) void loadOverview(false);
  });

  async function openExternal(url: string) {
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) await openUrl(url);
    else if (!window.open(url, '_blank', 'noopener,noreferrer')) throw new Error('Браузер заблокировал новое окно.');
  }

  async function openRegistration() {
    try {
      await openExternal(LASTFM_CREATE_APP_URL);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Не удалось открыть регистрацию приложения Last.fm.', 'error');
    }
  }

  async function openLastFmLink(url: string) {
    if (!url) return;
    try {
      await openExternal(url);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Не удалось открыть страницу Last.fm.', 'error');
    }
  }

  function formatCount(value: number) {
    return new Intl.NumberFormat('ru-RU').format(Math.max(0, value || 0));
  }

  function formatPlayedAt(value: number) {
    if (!value) return 'Недавно';
    const deltaMinutes = Math.max(0, Math.floor((Date.now() - value) / 60_000));
    if (deltaMinutes < 1) return 'Только что';
    if (deltaMinutes < 60) return `${deltaMinutes} мин назад`;
    if (deltaMinutes < 24 * 60) return `${Math.floor(deltaMinutes / 60)} ч назад`;
    if (deltaMinutes < 7 * 24 * 60) return `${Math.floor(deltaMinutes / (24 * 60))} дн назад`;
    return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' }).format(value);
  }

  async function loadOverview(force: boolean) {
    if (!session || overviewLoading) return;
    overviewLoading = true;
    overviewError = '';
    try {
      overview = await getLastFmOverview(force);
      session = getLastFmSession();
    } catch (error) {
      overviewError = error instanceof Error ? error.message : 'Не удалось загрузить историю Last.fm.';
    } finally {
      overviewLoading = false;
    }
  }

  async function copySetupValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(`${label} скопировано.`, 'success');
    } catch {
      notify('Не удалось скопировать текст. Выдели его мышкой и скопируй вручную.', 'error');
    }
  }

  async function startAuthorization() {
    if (busy) return;
    busy = true;
    try {
      const authorization = await beginLastFmAuthorization(apiKey, sharedSecret);
      authorizationPending = true;
      await openExternal(authorization.authorizationUrl);
      notify('Last.fm открыт в браузере. Разреши доступ и вернись сюда.', 'info');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Не удалось начать подключение Last.fm.', 'error');
    } finally {
      busy = false;
    }
  }

  async function finishAuthorization() {
    if (busy) return;
    busy = true;
    try {
      session = await finishLastFmAuthorization();
      authorizationPending = false;
      await loadOverview(true);
      notify(`Last.fm подключён как ${session.username}. Lomify будет отправлять прослушивания, пока сервис доступен.`, 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Не удалось завершить подключение Last.fm.', 'error');
    } finally {
      busy = false;
    }
  }

  async function refreshProfile() {
    if (busy || overviewLoading) return;
    busy = true;
    try {
      await loadOverview(true);
      if (overviewError) throw new Error(overviewError);
      notify('История и любимые исполнители Last.fm обновлены.', 'success');
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Не удалось обновить Last.fm.', 'error');
    } finally {
      busy = false;
    }
  }

  function unlink() {
    if (!confirm('Отвязать Last.fm? Уже отправленные скробблы останутся в профиле.')) return;
    disconnectLastFm();
    session = null;
    overview = null;
    overviewError = '';
    authorizationPending = false;
    notify('Last.fm отвязан. Новые прослушивания больше не отправляются.', 'info');
  }
</script>

<div class="provider-import-card is-lastfm">
  <div class="provider-import-head">
    <span class="provider-import-mark" aria-hidden="true"><MusicServiceIcon service="lastfm" size={26} /></span>
    <div>
      <span class="provider-import-kicker">История прослушиваний</span>
      <h3>Связь с Last.fm</h3>
      <p>Собирает единую историю прослушиваний и помогает Lomify точнее понимать любимых исполнителей.</p>
    </div>
    {#if session}
      <span class="provider-import-status"><Check size={14} aria-hidden="true" /> Подключён</span>
    {:else if authorizationPending}
      <span class="provider-import-status"><Radio size={14} aria-hidden="true" /> Жду подтверждения</span>
    {/if}
  </div>

  <aside class="lastfm-region-notice" role="note" aria-label="Доступность Last.fm в России">
    <span class="lastfm-region-notice-icon" aria-hidden="true"><TriangleAlert size={19} /></span>
    <div class="lastfm-region-notice-copy">
      <strong>В России Last.fm может не работать</strong>
      <p>
        С марта 2026 года Last.fm ограничивает подключения с российских IP. Это не ошибка
        ключа и не поломка Lomify.
      </p>
      <ul>
        <li>Может не открыться сайт входа, регистрации ключей или подтверждения доступа.</li>
        <li>Профиль, статистика и история могут не обновляться, а новые скробблы — не отправляться.</li>
        <li>Музыка в Lomify продолжит играть: ограничение касается только функций Last.fm.</li>
      </ul>
      <p class="lastfm-region-notice-advice">
        Если нужен Last.fm, потребуется VPN или прокси с IP другой страны одновременно для
        браузера и Lomify. Общий VPN иногда мешает Яндекс Музыке; если приложение VPN умеет
        раздельный режим, направь через него только <code>last.fm</code> и
        <code>ws.audioscrobbler.com</code>.
      </p>
      <button type="button" on:click={() => openLastFmLink(LASTFM_RUSSIA_HELP_URL)}>
        Сообщение поддержки Last.fm <ExternalLink size={13} aria-hidden="true" />
      </button>
    </div>
  </aside>

  {#if session}
    <div class="provider-import-body">
      <div class="provider-account-row">
        <div class="provider-account-identity">
          <span class="provider-account-avatar">
            {#if session.avatarUrl}
              <img src={session.avatarUrl} alt="" />
            {:else}
              <MusicServiceIcon service="lastfm" size={22} />
            {/if}
          </span>
          <div>
            <strong>{session.username}</strong>
            <span>{session.subscriber ? 'Last.fm Pro · аккаунт связан' : 'Аккаунт связан · отправка зависит от доступности Last.fm'}</span>
          </div>
        </div>
        <div class="provider-account-actions">
          {#if session.profileUrl}
            <button type="button" on:click={() => openLastFmLink(session?.profileUrl || 'https://www.last.fm')}>
              Профиль <ExternalLink size={14} aria-hidden="true" />
            </button>
          {/if}
          <button type="button" class="is-primary" on:click={refreshProfile} disabled={busy || overviewLoading}>
            {#if busy}<Loader2 class="animate-spin w-4 h-4" aria-hidden="true" />{:else}<RefreshCw size={14} aria-hidden="true" />{/if}
            Обновить
          </button>
          <button type="button" class="is-danger" on:click={unlink}>Отвязать</button>
        </div>
      </div>
      {#if overviewError}
        <div class="lastfm-inline-error" role="status">{overviewError} Можно оставить старые данные и попробовать обновить позже.</div>
      {/if}

      {#if overview}
        <section class="lastfm-overview" aria-label="Статистика Last.fm" aria-busy={overviewLoading}>
          <div class="lastfm-stats-grid">
            <div class="lastfm-stat">
              <span><Headphones size={14} aria-hidden="true" /> Всего скробблов</span>
              <strong>{formatCount(overview.playcount)}</strong>
            </div>
            <div class="lastfm-stat">
              <span><BarChart3 size={14} aria-hidden="true" /> Лидер за месяц</span>
              <strong title={overview.topArtists[0]?.name || ''}>{overview.topArtists[0]?.name || 'Пока нет данных'}</strong>
            </div>
            <div class="lastfm-stat">
              <span><Clock3 size={14} aria-hidden="true" /> История обновлена</span>
              <strong>{formatPlayedAt(overview.updatedAt)}</strong>
            </div>
          </div>

          <div class="lastfm-data-grid">
            <div class="lastfm-data-panel">
              <div class="lastfm-data-head">
                <div>
                  <strong>Недавние прослушивания</strong>
                  <span>Только засчитанные скробблы из общей истории</span>
                </div>
              </div>
              {#if overview.nowPlayingTrack}
                <div class="lastfm-now-playing">
                  <span class="lastfm-now-playing-pulse" aria-hidden="true"></span>
                  <span><b>Сейчас играет</b>{overview.nowPlayingTrack.title} · {overview.nowPlayingTrack.artist}</span>
                  <small>Ещё не засчитан</small>
                </div>
              {/if}
              {#if overview.recentTracks.length > 0}
                <div class="lastfm-recent-list">
                  {#each overview.recentTracks as track}
                    <button type="button" class="lastfm-recent-row" on:click={() => openLastFmLink(track.url)} disabled={!track.url}>
                      <span class="lastfm-track-cover">
                        {#if track.imageUrl}
                          <img src={track.imageUrl} alt="" loading="lazy" />
                        {:else}
                          <MusicServiceIcon service="lastfm" size={18} />
                        {/if}
                      </span>
                      <span class="lastfm-track-copy">
                        <strong>{track.title}</strong>
                        <span>{track.artist}</span>
                      </span>
                      <span class:now-playing={track.nowPlaying} class="lastfm-track-time">
                        {track.nowPlaying ? 'Сейчас играет' : formatPlayedAt(track.playedAt)}
                      </span>
                    </button>
                  {/each}
                </div>
              {:else}
                <p class="lastfm-empty">Прослушиваний пока нет. Запусти любой трек — после засчитанного скроббла он появится здесь.</p>
              {/if}
            </div>

            <div class="lastfm-data-panel">
              <div class="lastfm-data-head">
                <div>
                  <strong>Любимые за месяц</strong>
                  <span>Lomify учитывает их в рекомендациях на главной</span>
                </div>
              </div>
              {#if overview.topArtists.length > 0}
                <div class="lastfm-top-list">
                  {#each overview.topArtists as artist, index}
                    <button type="button" class="lastfm-top-row" on:click={() => openLastFmLink(artist.url)} disabled={!artist.url}>
                      <span class="lastfm-top-rank">{index + 1}</span>
                      <span class="lastfm-top-name">{artist.name}</span>
                      <span class="lastfm-top-count">{formatCount(artist.playcount)} просл.</span>
                    </button>
                  {/each}
                </div>
              {:else}
                <p class="lastfm-empty">Last.fm ещё не собрал месячный топ. Он появится после нескольких прослушиваний.</p>
              {/if}
            </div>
          </div>

          {#if overviewLoading}
            <span class="lastfm-refreshing"><Loader2 size={13} class="animate-spin" aria-hidden="true" /> Обновляю данные…</span>
          {/if}
        </section>
      {:else if overviewLoading}
        <div class="lastfm-loading" aria-live="polite"><Loader2 size={16} class="animate-spin" aria-hidden="true" /> Загружаю историю Last.fm…</div>
      {/if}
      <p class="provider-import-note">
        Lomify показывает текущий трек сразу. В историю он попадает после половины длительности или четырёх минут — по правилу Last.fm. Перемотка не считается прослушиванием.
      </p>
    </div>
  {:else if authorizationPending}
    <div class="provider-import-body">
      <div class="provider-auth-panel">
        <span class="provider-auth-icon" aria-hidden="true"><Radio size={19} /></span>
        <div class="provider-auth-copy">
          <strong>Разреши доступ в браузере</strong>
          <span>После подтверждения вернись в Lomify — вкладку Last.fm можно просто закрыть.</span>
        </div>
        <div class="provider-account-actions">
          <button type="button" on:click={startAuthorization} disabled={busy}>Открыть ещё раз</button>
          <button type="button" class="is-primary" on:click={finishAuthorization} disabled={busy}>
            {#if busy}<Loader2 class="animate-spin w-4 h-4" aria-hidden="true" />{/if}
            Я разрешил доступ
          </button>
        </div>
      </div>
      <p class="provider-import-note">Одноразовый код действует час. Пароль от Last.fm Lomify не видит и не хранит.</p>
    </div>
  {:else}
    <div class="provider-import-body">
      {#if hasAppCredentials}
        <div class="provider-auth-panel">
          <span class="provider-auth-icon" aria-hidden="true"><KeyRound size={19} /></span>
          <div class="provider-auth-copy">
            <strong>Всё готово к подключению</strong>
            <span>Откроется официальный экран Last.fm — войди там и разреши скробблинг.</span>
          </div>
          <div class="provider-account-actions">
            <button type="button" class="is-primary" on:click={startAuthorization} disabled={busy}>
              {#if busy}<Loader2 class="animate-spin w-4 h-4" aria-hidden="true" />{/if}
              Подключить Last.fm
            </button>
          </div>
        </div>
      {:else}
        <details class="provider-setup-guide" open>
          <summary>
            <span>
              <strong>Как получить ключи Last.fm</strong>
              <small>Подробная инструкция — открывай и делай по порядку</small>
            </span>
            <span class="provider-setup-summary-action">
              <span class="is-open">Свернуть</span>
              <span class="is-closed">Развернуть</span>
            </span>
          </summary>

          <ol class="provider-setup-steps">
            <li>
              <span class="provider-setup-number">1</span>
              <div>
                <strong>Открой регистрацию приложения</strong>
                <p>Нажми кнопку ниже. Откроется сайт Last.fm. Если он попросит войти — введи логин и пароль от своего аккаунта Last.fm.</p>
                <button type="button" class="provider-guide-action" on:click={openRegistration}>
                  Открыть страницу Last.fm <ExternalLink size={14} aria-hidden="true" />
                </button>
              </div>
            </li>

            <li>
              <span class="provider-setup-number">2</span>
              <div>
                <strong>Заполни форму точно как показано здесь</strong>
                <p>Названия полей на сайте будут английскими. Готовые значения можно скопировать кнопкой справа.</p>
                <div class="provider-setup-values">
                  <div>
                    <span><b>Application name</b><small>Название приложения</small></span>
                    <code>{LASTFM_APP_NAME}</code>
                    <button type="button" aria-label="Скопировать название приложения" title="Скопировать" on:click={() => copySetupValue(LASTFM_APP_NAME, 'Название')}>
                      <ClipboardCopy size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div>
                    <span><b>Application description</b><small>Описание приложения</small></span>
                    <code>{LASTFM_APP_DESCRIPTION}</code>
                    <button type="button" aria-label="Скопировать описание приложения" title="Скопировать" on:click={() => copySetupValue(LASTFM_APP_DESCRIPTION, 'Описание')}>
                      <ClipboardCopy size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div>
                    <span><b>Callback URL</b><small>Адрес возврата</small></span>
                    <em>Оставь это поле полностью пустым</em>
                    <span class="provider-setup-empty" aria-label="Ничего не вводить">Пусто</span>
                  </div>
                  <div>
                    <span><b>Application homepage</b><small>Страница приложения</small></span>
                    <code>{LASTFM_APP_HOMEPAGE}</code>
                    <button type="button" aria-label="Скопировать адрес приложения" title="Скопировать" on:click={() => copySetupValue(LASTFM_APP_HOMEPAGE, 'Адрес')}>
                      <ClipboardCopy size={14} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <p class="provider-setup-warning">
                  Затем поставь галочку <b>I'm not a robot</b>, прокрути страницу ниже и нажми кнопку создания приложения.
                </p>
              </div>
            </li>

            <li>
              <span class="provider-setup-number">3</span>
              <div>
                <strong>Скопируй два выданных ключа</strong>
                <p>После создания Last.fm покажет строки <b>API key</b> и <b>Shared secret</b>. Вставь их в одноимённые поля Lomify прямо под этой инструкцией. Остальные значения не нужны.</p>
              </div>
            </li>

            <li>
              <span class="provider-setup-number">4</span>
              <div>
                <strong>Заверши подключение</strong>
                <p>Нажми в Lomify <b>Подключить</b>. На открывшейся странице Last.fm разреши доступ, вернись в Lomify и нажми <b>Я разрешил доступ</b>.</p>
              </div>
            </li>
          </ol>
        </details>

        <div class="provider-credentials-grid">
          <label>
            <span>API key</span>
            <div class="provider-import-field">
              <KeyRound size={16} aria-hidden="true" />
              <input type="text" bind:value={apiKey} placeholder="32 символа" autocomplete="off" spellcheck="false" />
            </div>
          </label>
          <label>
            <span>Shared secret</span>
            <div class="provider-import-field">
              <KeyRound size={16} aria-hidden="true" />
              <input type="password" bind:value={sharedSecret} placeholder="32 символа" autocomplete="off" spellcheck="false" />
            </div>
          </label>
        </div>
        <div class="provider-connect-footer">
          <p class="provider-import-note">Ключи хранятся только на этом компьютере и нужны для подписи скробблов.</p>
          <div class="provider-account-actions">
            <button type="button" on:click={openRegistration}>
              Открыть регистрацию <ExternalLink size={14} aria-hidden="true" />
            </button>
            <button type="button" class="is-primary" on:click={startAuthorization} disabled={busy || !apiKey.trim() || !sharedSecret.trim()}>
              {#if busy}<Loader2 class="animate-spin w-4 h-4" aria-hidden="true" />{/if}
              Подключить
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
