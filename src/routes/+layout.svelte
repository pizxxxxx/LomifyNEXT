<script lang="ts">
  import '../app.css';
  import { settings, initStore, currentTrack, isPlaying, effectivePerformanceMode } from '$lib/stores';
  import Titlebar from '$lib/components/Titlebar.svelte';
  import { onMount } from 'svelte';
  import { Check, X, ChevronDown, ChevronUp, Sparkles } from 'lucide-svelte';
  import { APP_NAME, APP_VERSION } from '$lib/version';
  import { getCurrentVersionChangelog, isChangelogModalOpen, CHANGELOG_HISTORY } from '$lib/changelog';
  import {
    checkForUpdates,
    updateStatus,
    updateInfo,
    downloadProgress,
    installDownloadedUpdate
  } from '$lib/updater';
  import { extractCoverAccent, rgbToHex } from '$lib/utils/coverAccent';
  import { lockDevTools } from '$lib/utils/devLock';
  import { trackSheen } from '$lib/utils/sheen';
  import { trackTilt } from '$lib/utils/tilt';
  import { trackPress } from '$lib/utils/press';
  import {
    coverUrlForTrack,
    downloadedCoverCache,
    initDownloadedCoverCache
  } from '$lib/offlineCovers';

  let showStartupNotice = false;
  let showFullDetails = false;
  let dontShowAgain = true;
  let startupAction: HTMLButtonElement;
  const changelog = getCurrentVersionChangelog();
  let selectedVersion = APP_VERSION;
  const recentVersions = CHANGELOG_HISTORY.filter(c => ['9.4.0', '9.3.4'].includes(c.version));
  $: activeChangelog = CHANGELOG_HISTORY.find(c => c.version === selectedVersion) || changelog;
  const NOTICE_VERSION_KEY = 'lomifynext_last_seen_notice_version';
  const SESSION_NOTICE_KEY = 'lomifynext_notice_session_' + APP_VERSION;

  $: showStartupNotice = $isChangelogModalOpen;

  /** Отложенная сверка лайков. Держим ссылку, чтобы снять её, если окно закрыли раньше. */
  let likesSyncTask: ReturnType<typeof setTimeout> | null = null;
  let likesSyncInterval: ReturnType<typeof setInterval> | null = null;
  let cacheCleanupTask: ReturnType<typeof setTimeout> | null = null;
  let lastLikesSyncAt = 0;
  let lastLikesSyncToken = '';
  let logicalViewportWidth = 1920;
  let logicalViewportHeight = 1080;
  let appliedInterfaceScale = 0;
  let interfaceScaleRequest = 0;

  const UI_REFERENCE_WIDTH = 1920;
  const UI_REFERENCE_HEIGHT = 1080;

  /**
   * Окно 1920×1080 остаётся эталоном и выглядит пиксель-в-пиксель как раньше. На более
   * просторном окне поднимаем масштаб по меньшей стороне: так 2K получает 133%, 4K —
   * 200%, а ультраширокий монитор не обрезает интерфейс по высоте. Ниже 100% автоматика
   * не опускается — компактные окна уже обслуживают адаптивные правила компонентов.
   */
  function resolveInterfaceScale(
    mode: string | undefined,
    viewportWidth: number,
    viewportHeight: number
  ) {
    if (mode && mode !== 'auto') {
      const percent = Number.parseInt(mode, 10);
      if (Number.isFinite(percent)) return Math.min(2, Math.max(1, percent / 100));
    }

    const fit = Math.min(
      viewportWidth / UI_REFERENCE_WIDTH,
      viewportHeight / UI_REFERENCE_HEIGHT
    );
    return Math.min(2, Math.max(1, Math.round(fit * 100) / 100));
  }

  /**
   * Нативный zoom WebView меняет layout viewport и заново растеризует текст/иконки — в
   * отличие от CSS transform ничего не мылится, а `100vw`, fixed-окна и порталы продолжают
   * совпадать с краями приложения. В обычном браузерном dev-режиме масштаб не подменяем:
   * CSS zoom нарушил бы размеры `w-screen`/`h-screen`; выбранное значение применит Tauri.
   */
  async function applyInterfaceScale(
    mode: string | undefined,
    viewportWidth: number,
    viewportHeight: number
  ) {
    if (typeof document === 'undefined') return;
    const scale = resolveInterfaceScale(mode, viewportWidth, viewportHeight);
    const request = ++interfaceScaleRequest;

    document.body.setAttribute('data-ui-scale', String(Math.round(scale * 100)));
    if (!('__TAURI_INTERNALS__' in window) || Math.abs(scale - appliedInterfaceScale) < 0.001) {
      return;
    }

    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview');
      if (request !== interfaceScaleRequest) return;
      await getCurrentWebview().setZoom(scale);
      if (request === interfaceScaleRequest) appliedInterfaceScale = scale;
    } catch (e) {
      console.warn('[ui-scale] не удалось применить масштаб интерфейса', e);
    }
  }

  function refreshYandexLikes() {
    const token = $settings.yandexToken || '';
    if (!token || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    const now = Date.now();
    if (token === lastLikesSyncToken && now - lastLikesSyncAt < 20_000) return;
    lastLikesSyncAt = now;
    lastLikesSyncToken = token;
    import('$lib/likes').then(({ syncLikes }) => {
      syncLikes({ silent: true, only: 'yandex' }).catch((e) =>
        console.warn('[likes] фоновая сверка Яндекс Музыки сорвалась', e)
      );
    });
  }

  function syncAllLikesAtStartup() {
    if ($settings.syncPlatformsLikes === false) return;
    lastLikesSyncAt = Date.now();
    lastLikesSyncToken = $settings.yandexToken || '';
    import('$lib/likes').then(({ syncLikes }) => {
      syncLikes({ silent: true }).catch((e) => console.warn('[likes] сверка сорвалась', e));
    });
  }

  function dismissStartupNotice() {
    isChangelogModalOpen.set(false);
    showFullDetails = false;
    sessionStorage.setItem(SESSION_NOTICE_KEY, 'true');
    if (dontShowAgain) {
      localStorage.setItem(NOTICE_VERSION_KEY, APP_VERSION);
    }
  }

  // Клавиатура закрывает окно так же, как кнопка: пока оно висит поверх всего, Enter и Esc
  // больше ни на что не назначены, а тянуться к мыши ради одной кнопки незачем.
  function onWindowKeydown(e: KeyboardEvent) {
    if (showStartupNotice) {
      if (e.key === 'Tab') {
        e.preventDefault();
        startupAction?.focus();
        return;
      }
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        dismissStartupNotice();
        return;
      }
    }

    if (e.code === 'Space' || e.key === ' ') {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditable = tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
      if (isEditable) return;

      e.preventDefault();
      if ($currentTrack) {
        isPlaying.update((p) => !p);
      }
    }
  }

  // Фокус на кнопке, а не на теле страницы: иначе Tab уводит в интерфейс под окном, который
  // пока трогать нельзя. Именно action, а не реактивное присваивание: в этом режиме `$:`
  // компилируется в эффект, который срабатывает до обновления DOM, то есть на ссылке из
  // `bind:this`, которой в этот момент ещё нет.
  //
  // Через задачу, а не сразу: окно поднимается из `onMount`, то есть пока роутер ещё
  // доводит переход, а он в конце сбрасывает фокус на `<body>` — синхронный вызов
  // затирается. Проверено: без задержки `document.activeElement` остаётся `<body>`.
  // `setTimeout`, а не `requestAnimationFrame`: кадров может не быть вовсе, пока окно
  // приложения скрыто или свёрнуто, и тогда фокус не встал бы никогда.
  function focusOnMount(node: HTMLElement) {
    const task = setTimeout(() => node.focus());
    return { destroy: () => clearTimeout(task) };
  }

  onMount(() => {
    initStore();
    let downloadedCoversDisposed = false;
    let releaseDownloadedCovers: (() => void) | null = null;
    void initDownloadedCoverCache().then((release) => {
      if (downloadedCoversDisposed) release();
      else releaseDownloadedCovers = release;
    });
    // Apple Music больше не поддерживается. Стираем оставшиеся от прежней карточки
    // пользовательский и developer token, чтобы закрытые учётные данные не лежали в WebView.
    localStorage.removeItem('lomifynext_apple_music_session');
    // No inspector, no view-source, no reload in a shipped build (no-op during dev).
    const releaseDevLock = lockDevTools();    // Один делегированный слушатель на всё приложение: он запускает блик по карточкам и
    // даёт ему дожить до конца, даже если курсор уже ушёл.
    const releaseSheen = trackSheen();
    // Наклон обложки и блик под курсором. Тоже один слушатель на всё приложение, и это
    // не только про экономию: раньше трекер блика жил в `onMount` домашней страницы, то
    // есть работал ровно на одном маршруте — в библиотеке, поиске и на странице артиста
    // блик по карточкам не двигался вовсе.
    const releaseTilt = trackTilt();
    // Точка отсчёта вдавливания под курсором. Без неё сжатие по `:active` уводит кромку
    // из-под курсора, и `click` уходит контейнеру: нажатие видно, действия нет.
    const releasePress = trackPress();

    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      // Размер окна Tauri приходит в физических пикселях и, в отличие от innerWidth,
      // не меняется вслед за zoom самой страницы. Делим его на системный scaleFactor:
      // так Windows 150/200% не складывается с нашей автоматикой второй раз.
      let nativeScaleFactor = 1;
      let releaseResize: (() => void) | null = null;
      let releaseScaleChanged: (() => void) | null = null;
      let windowMetricsDisposed = false;

      import('@tauri-apps/api/window').then(async ({ getCurrentWindow }) => {
        const appWindow = getCurrentWindow();
        const [size, scaleFactor] = await Promise.all([
          appWindow.innerSize(),
          appWindow.scaleFactor()
        ]);
        if (windowMetricsDisposed) return;

        nativeScaleFactor = scaleFactor || 1;
        logicalViewportWidth = size.width / nativeScaleFactor;
        logicalViewportHeight = size.height / nativeScaleFactor;

        releaseResize = await appWindow.onResized(({ payload }) => {
          logicalViewportWidth = payload.width / nativeScaleFactor;
          logicalViewportHeight = payload.height / nativeScaleFactor;
        });
        releaseScaleChanged = await appWindow.onScaleChanged(({ payload }) => {
          nativeScaleFactor = payload.scaleFactor || 1;
          logicalViewportWidth = payload.size.width / nativeScaleFactor;
          logicalViewportHeight = payload.size.height / nativeScaleFactor;
        });

        if (windowMetricsDisposed) {
          releaseResize();
          releaseScaleChanged();
        }
      }).catch((e) => console.warn('[ui-scale] не удалось прочитать размер окна', e));

      import('@tauri-apps/api/core').then(({ invoke }) => {
        invoke('discord_connect').catch(console.error);
      });

      // Выбранное устройство вывода живёт в localStorage, а аудио-поток в Rust поднимается
      // на системном по умолчанию и о настройках не знает. Без этого вызова выбор работал
      // бы только до перезапуска. Идёт после `initStore()` — он заполняет настройки
      // синхронно, так что сохранённое устройство здесь уже видно.
      import('$lib/audioOutput').then(({ restoreSavedOutput }) => {
        restoreSavedOutput();
      });

      // Лайки сводятся с привязанными аккаунтами при каждом запуске — иначе списки
      // расходятся: отметка, поставленная в вебе, здесь не появлялась, а снятая там
      // оставалась здесь навсегда (разбор в $lib/likes).
      //
      // Не сразу, а через полсекунды: домашняя страница в этот момент запрашивает полки, и
      // сверка (у Яндекса это чтение списка плюс гидрация чанками по сотне) отбирала бы у них
      // и сеть, и лимит запросов. Полсекунды человек не замечает, а лайки нужны ему не в
      // первый кадр — они догоняют, пока он смотрит на главную.
      likesSyncTask = setTimeout(() => {
        // `silent` — запуск не по просьбе человека: отказы уходят в консоль, а не
        // уведомлением поверх интерфейса. Об изменениях сверка скажет сама.
        syncAllLikesAtStartup();
      }, 500);

      // Обход диска не конкурирует с первым кадром, загрузкой главной и сверкой лайков.
      // Сам модуль дополнительно не запускает очистку чаще раза в сутки.
      cacheCleanupTask = setTimeout(() => {
        import('$lib/cacheMaintenance').then(({ runSmartCacheCleanup }) => {
          runSmartCacheCleanup().catch((e) =>
            console.warn('[cache] фоновая очистка не удалась', e)
          );
        });
      }, 6000);

      // Яндекс не присылает push-событие о лайке, поставленном на другом устройстве, поэтому
      // держим лёгкую фоновую сверку. Она не чаще раза в минуту, не работает без токена и
      // дополнительно срабатывает при возврате фокуса в окно.
      likesSyncInterval = setInterval(refreshYandexLikes, 60_000);
      window.addEventListener('focus', refreshYandexLikes);
      document.addEventListener('visibilitychange', refreshYandexLikes);

      // Фоновая проверка обновлений с GitHub при запуске
      void checkForUpdates(true);

      const lastSeenNoticeVer = localStorage.getItem(NOTICE_VERSION_KEY);
      const seenThisSession = sessionStorage.getItem(SESSION_NOTICE_KEY);

      // Каждое обновление (когда версия сменилась) показываем окно обязательно,
      // даже если в старой версии стояла галочка «не показывать».
      if (!seenThisSession && (lastSeenNoticeVer !== APP_VERSION || $settings.showStartupNotice !== false)) {
        isChangelogModalOpen.set(true);
        dontShowAgain = true;
      }

      // Ссылки живут в блоке Tauri выше, а общий cleanup возвращается из onMount ниже.
      // Функция на свойстве позволяет не расширять область всех остальных задач запуска.
      releaseWindowMetrics = () => {
        windowMetricsDisposed = true;
        releaseResize?.();
        releaseScaleChanged?.();
      };
    }

    return () => {
      downloadedCoversDisposed = true;
      releaseDownloadedCovers?.();
      releaseDevLock();
      releaseSheen();
      releaseTilt();
      releasePress();
      releaseWindowMetrics?.();
      if (likesSyncTask !== null) clearTimeout(likesSyncTask);
      if (likesSyncInterval !== null) clearInterval(likesSyncInterval);
      if (cacheCleanupTask !== null) clearTimeout(cacheCleanupTask);
      window.removeEventListener('focus', refreshYandexLikes);
      document.removeEventListener('visibilitychange', refreshYandexLikes);
    };
  });

  let releaseWindowMetrics: (() => void) | null = null;

  $: {
    if (typeof document !== 'undefined' && $settings) {
      if ($settings.uiStyle === 'style3') {
        $settings.uiStyle = 'style1';
      }
      if ($settings.theme) {
        document.body.setAttribute('data-theme', $settings.theme);
      }
      document.body.setAttribute('data-ui-style', $settings.uiStyle || 'style1');
      // Размеры передаются явно: Svelte видит обе зависимости и пересчитывает автоматику
      // не только при смене пункта настройки, но и при переносе окна на другой монитор.
      void applyInterfaceScale(
        $settings.uiScale || 'auto',
        logicalViewportWidth,
        logicalViewportHeight
      );
      // Пользовательская гарнитура относится только к словам песни. Интерфейс остаётся
      // стабильным по метрикам: переключение текста не двигает меню, кнопки и карточки.
      document.body.setAttribute('data-lyrics-font', $settings.fontFamily || 'inter');
      document.body.setAttribute('data-global-theme', $settings.globalThemeEffect ? 'true' : 'false');
      // Глобальный дизайн — отдельная ось от uiStyle/theme: он переопределяет сами
      // материалы и типографику (src/design-aurora.css), а не только оттенок.
      document.body.setAttribute('data-design', $settings.design === 'aurora' ? 'aurora' : 'classic');

      // Режим производительности. Снимает самые дорогие эффекты (живое размытие фона под
      // панелями) без потери визуального строя: вместо стекла — плотная тёмная заливка.
      document.body.setAttribute('data-perf', $effectivePerformanceMode ? 'light' : 'full');

      // Эффекты движения. Атрибут ставится всегда, а не только в положении «выключено»:
      // селектор `body[data-fx-glare="off"]` читается однозначно, а `body:not([data-fx-glare])`
      // — нет, потому что до первой отрисовки настроек атрибута нет ни при каком значении.
      //
      // Наклон и блик умеет выключать и сам скрипт (`$lib/utils/tilt`), но чисто CSS-ных
      // эффектов он не видит: блик кромки, световая полоса и пружина нажатия живут только в
      // таблицах стилей. Поэтому выключатель здесь — один на все четыре, а не половина в
      // скрипте и половина в разметке.
      //
      // Режим производительности гасит все четыре разом. Именно здесь, а не записью `false` в
      // сами настройки: выбор человека должен вернуться, когда режим выключат, — иначе один
      // тумблер молча стирал бы четыре других, и восстанавливать их пришлось бы руками.
      const lite = $effectivePerformanceMode;
      const fx = (on: boolean) => (on && !lite ? 'on' : 'off');
      document.body.setAttribute('data-fx-tilt', fx($settings.coverTilt !== false));
      document.body.setAttribute('data-fx-glare', fx($settings.coverGlare !== false));
      document.body.setAttribute('data-fx-sheen', fx($settings.cardSheen !== false));
      document.body.setAttribute('data-fx-press', fx($settings.panelPress !== false));
    }
  }

  // Accent follows the artwork. An inline custom property outranks the
  // `[data-theme]` rules, so clearing it hands the colour straight back to the
  // theme the user picked — which is also what happens for a cover with no
  // usable colour in it (monochrome sleeve, missing art, unreadable canvas).
  // `@property --color-primary` in app.css is what makes the change ease rather
  // than snap; the accent is registered as a real <color>.
  $: currentDisplayCover = coverUrlForTrack($currentTrack, $downloadedCoverCache);
  $: applyCoverAccent(currentDisplayCover, $settings?.accentFromCover !== false);

  let appliedAccentFor: string | null = null;
  async function applyCoverAccent(coverUrl: string | undefined, enabled: boolean) {
    if (typeof document === 'undefined') return;

    if (!enabled) {
      document.body.style.removeProperty('--color-primary');
      appliedAccentFor = null;
      return;
    }
    // The reaction re-runs on every settings write; skip covers already applied.
    const key = coverUrl || '';
    if (key === appliedAccentFor) return;
    appliedAccentFor = key;

    // Декодирование картинки и чтение canvas не должны бороться за первый кадр с запуском
    // аудио. Отдаём эту декоративную работу ближайшему простою интерфейса; timeout не даёт
    // теме зависнуть на старом цвете, если окно всё время занято.
    await new Promise<void>((resolve) => {
      const requestIdle = (window as any).requestIdleCallback as
        | ((callback: () => void, options?: { timeout: number }) => number)
        | undefined;
      if (requestIdle) requestIdle(resolve, { timeout: 420 });
      else window.setTimeout(resolve, 32);
    });
    if (appliedAccentFor !== key) return;

    const accent = await extractCoverAccent(coverUrl);
    // A slower cover can resolve after the next track already won the race.
    if (appliedAccentFor !== key) return;

    if (accent) document.body.style.setProperty('--color-primary', rgbToHex(accent));
    else document.body.style.removeProperty('--color-primary');
  }
</script>

<svelte:window on:keydown={onWindowKeydown} />

<Titlebar />
<slot />

{#if showStartupNotice}
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div class="startup-veil" on:click|self={dismissStartupNotice}>
    <div
      class="startup-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="startup-title"
    >
      <div class="startup-head">
        <div class="startup-badge-row">
          <span class="startup-app-name">{APP_NAME}</span>
          <span class="startup-badge">
            <span class="startup-badge-dot"></span>
            v{activeChangelog.version}
          </span>
          <span class="startup-date">{activeChangelog.date}</span>
        </div>
        <div class="flex items-center gap-2">
          {#if recentVersions.length > 1}
            <div class="flex items-center gap-1 p-0.5 rounded-lg bg-white/[0.05] border border-white/[0.08]" role="tablist" aria-label="Версии">
              {#each recentVersions as ver}
                <button
                  type="button"
                  role="tab"
                  aria-selected={selectedVersion === ver.version}
                  class="px-2 py-0.5 rounded text-[11px] font-medium transition-colors {selectedVersion === ver.version ? 'bg-white/15 text-white' : 'text-neutral-400 hover:text-neutral-200'}"
                  on:click={() => { selectedVersion = ver.version; showFullDetails = false; }}
                >
                  v{ver.version}
                </button>
              {/each}
            </div>
          {/if}
          <button
            class="startup-close"
            on:click={dismissStartupNotice}
            aria-label="Закрыть"
            title="Закрыть (Esc)"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div class="startup-body">
        <div class="startup-title-group">
          <h2 id="startup-title" class="startup-title">{activeChangelog.title}</h2>
          <p class="startup-subhead">Основные улучшения и изменения версии v{activeChangelog.version}:</p>
        </div>

        <div class="startup-highlights">
          {#each activeChangelog.highlights as item}
            <div class="startup-highlight-card">
              <span class="startup-highlight-tag">{item.tag}</span>
              <span class="startup-highlight-text">{item.text}</span>
            </div>
          {/each}
        </div>

        {#if activeChangelog.details && activeChangelog.details.length > 0}
          <button
            type="button"
            class="startup-expand-btn"
            on:click={() => (showFullDetails = !showFullDetails)}
            aria-expanded={showFullDetails}
          >
            <span class="startup-expand-copy">
              <Sparkles size={14} class="startup-expand-icon" />
              <span>{showFullDetails ? 'Скрыть подробный список' : `Развернуть полный список изменений (${activeChangelog.details.length})`}</span>
            </span>
            <svelte:component this={showFullDetails ? ChevronUp : ChevronDown} size={15} />
          </button>

          {#if showFullDetails}
            <div class="startup-details-pane">
              {#each activeChangelog.details as detail}
                <div class="startup-detail-item">
                  <div class="startup-detail-header">
                    <span class="startup-category-badge category-{detail.category}">
                      {detail.category === 'feature' ? 'Новое' : detail.category === 'improvement' ? 'Улучшение' : 'Исправление'}
                    </span>
                    <strong class="startup-detail-title">{detail.title}</strong>
                  </div>
                  {#if detail.description}
                    <p class="startup-detail-desc">{detail.description}</p>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        {/if}

        {#if $updateStatus === 'downloading' && $updateInfo}
          <div class="startup-update-banner">
            <div class="startup-update-text">
              <span>Загрузка обновления v{$updateInfo.version}...</span>
              <span class="tnum font-medium">{$downloadProgress.percent.toFixed(0)}%</span>
            </div>
            <div class="startup-update-bar">
              <div class="startup-update-fill" style="width: {$downloadProgress.percent}%"></div>
            </div>
          </div>
        {:else if $updateStatus === 'ready' && $updateInfo}
          <div class="startup-update-banner is-ready">
            <div class="startup-update-text">
              <span>Новая версия v{$updateInfo.version} загружена!</span>
            </div>
            <button class="startup-install-btn" on:click={installDownloadedUpdate}>
              Установить и перезапустить
            </button>
          </div>
        {/if}

        <div class="startup-bottom">
          <label class="startup-checkbox-label">
            <span class="startup-checkbox-box" class:checked={dontShowAgain}>
              {#if dontShowAgain}
                <Check size={11} strokeWidth={3} />
              {/if}
            </span>
            <input type="checkbox" bind:checked={dontShowAgain} class="startup-checkbox-input" />
            <span>Не показывать для версии {APP_VERSION}</span>
          </label>

          <button
            class="startup-action"
            bind:this={startupAction}
            use:focusOnMount
            on:click={dismissStartupNotice}
          >
            Понятно
          </button>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .startup-veil {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.25rem;
    background: rgba(3, 4, 7, 0.74);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    animation: startup-fade-in 180ms ease-out both;
  }

  .startup-card {
    position: relative;
    overflow: hidden;
    width: min(32rem, 94vw);
    max-height: 88vh;
    display: flex;
    flex-direction: column;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 1.25rem;
    background: rgba(16, 17, 23, 0.94);
    box-shadow:
      inset 0 1px 0 rgba(255, 255, 255, 0.08),
      0 24px 70px rgba(0, 0, 0, 0.75),
      0 4px 16px rgba(0, 0, 0, 0.4);
    animation: startup-card-in 220ms cubic-bezier(0.16, 1, 0.3, 1) both;
    font-family: var(--font-ui);
  }

  .startup-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.15rem 1.35rem 0.65rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  }

  .startup-badge-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .startup-app-name {
    font-size: 13px;
    font-weight: 700;
    color: rgba(255, 255, 255, 0.95);
    letter-spacing: -0.01em;
  }

  .startup-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.2rem 0.55rem;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.05);
    color: rgba(255, 255, 255, 0.75);
    font-size: 11px;
    font-weight: 600;
  }

  .startup-badge-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: #4ade80;
    box-shadow: 0 0 6px rgba(74, 222, 128, 0.5);
  }

  .startup-date {
    font-size: 11.5px;
    color: rgba(255, 255, 255, 0.38);
    font-variant-numeric: tabular-nums;
  }

  .startup-close {
    width: 1.85rem;
    height: 1.85rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.04);
    color: rgba(255, 255, 255, 0.45);
    cursor: pointer;
    transition: background-color 140ms ease, color 140ms ease, transform 140ms ease;
  }

  .startup-close:hover {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.95);
    transform: scale(1.05);
  }

  .startup-body {
    padding: 1rem 1.35rem 1.35rem;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .startup-title-group {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .startup-title {
    margin: 0;
    color: rgba(255, 255, 255, 0.95);
    font-size: 1.15rem;
    font-weight: 700;
    letter-spacing: -0.015em;
    line-height: 1.3;
  }

  .startup-subhead {
    margin: 0;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.45);
    line-height: 1.4;
  }

  .startup-highlights {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .startup-highlight-card {
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
    padding: 0.55rem 0.75rem;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.025);
    transition: background-color 140ms ease, border-color 140ms ease;
  }

  .startup-highlight-card:hover {
    background: rgba(255, 255, 255, 0.045);
    border-color: rgba(255, 255, 255, 0.1);
  }

  .startup-highlight-tag {
    flex-shrink: 0;
    padding: 0.15rem 0.45rem;
    border-radius: 0.4rem;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.75);
    font-size: 10.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .startup-highlight-text {
    font-size: 12px;
    line-height: 1.4;
    color: rgba(255, 255, 255, 0.78);
  }

  .startup-expand-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.55rem 0.75rem;
    border: 1px dashed rgba(255, 255, 255, 0.12);
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.02);
    color: rgba(255, 255, 255, 0.6);
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease;
  }

  .startup-expand-btn:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.2);
    color: rgba(255, 255, 255, 0.9);
  }

  .startup-expand-copy {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }

  .startup-expand-icon {
    color: var(--color-primary, #1DB954);
  }

  .startup-details-pane {
    max-height: 190px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.4rem 0.3rem 0.4rem 0.1rem;
  }

  .startup-detail-item {
    padding: 0.5rem 0.65rem;
    border-radius: 0.65rem;
    background: rgba(0, 0, 0, 0.25);
    border: 1px solid rgba(255, 255, 255, 0.04);
  }

  .startup-detail-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.2rem;
  }

  .startup-category-badge {
    padding: 0.1rem 0.4rem;
    border-radius: 0.35rem;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.02em;
    text-transform: uppercase;
  }

  .startup-category-badge.category-feature {
    background: rgba(34, 197, 94, 0.15);
    border: 1px solid rgba(34, 197, 94, 0.25);
    color: #4ade80;
  }

  .startup-category-badge.category-improvement {
    background: rgba(168, 85, 247, 0.15);
    border: 1px solid rgba(168, 85, 247, 0.25);
    color: #c084fc;
  }

  .startup-category-badge.category-fix {
    background: rgba(245, 158, 11, 0.15);
    border: 1px solid rgba(245, 158, 11, 0.25);
    color: #fbbf24;
  }

  .startup-detail-title {
    font-size: 11.5px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.88);
  }

  .startup-detail-desc {
    margin: 0;
    font-size: 11px;
    line-height: 1.35;
    color: rgba(255, 255, 255, 0.5);
    padding-left: 0.1rem;
  }

  .startup-update-banner {
    padding: 0.75rem 0.9rem;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.75rem;
    background: rgba(255, 255, 255, 0.03);
  }

  .startup-update-banner.is-ready {
    border-color: rgba(29, 185, 84, 0.3);
    background: rgba(29, 185, 84, 0.07);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .startup-update-text {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.85);
    margin-bottom: 0.45rem;
  }

  .startup-update-banner.is-ready .startup-update-text {
    margin-bottom: 0;
    color: #4ade80;
    font-weight: 600;
  }

  .startup-update-bar {
    height: 4px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
    overflow: hidden;
  }

  .startup-update-fill {
    height: 100%;
    background: var(--color-primary, #1DB954);
    transition: width 150ms ease;
  }

  .startup-install-btn {
    padding: 0.4rem 0.8rem;
    border-radius: 0.5rem;
    background: var(--color-primary, #1DB954);
    color: #fff;
    font-size: 11.5px;
    font-weight: 700;
    cursor: pointer;
    border: none;
    transition: filter 140ms ease;
  }

  .startup-install-btn:hover {
    filter: brightness(1.1);
  }

  .startup-bottom {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding-top: 0.65rem;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }

  .startup-checkbox-label {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    user-select: none;
    color: rgba(255, 255, 255, 0.55);
    font-size: 12px;
    transition: color 140ms ease;
  }

  .startup-checkbox-label:hover {
    color: rgba(255, 255, 255, 0.85);
  }

  .startup-checkbox-box {
    width: 1.1rem;
    height: 1.1rem;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 0.3rem;
    background: rgba(255, 255, 255, 0.04);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #fff;
    flex-shrink: 0;
  }

  .startup-checkbox-box.checked {
    background: var(--color-primary, #1DB954);
    border-color: var(--color-primary, #1DB954);
  }

  .startup-checkbox-input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
    pointer-events: none;
  }

  .startup-action {
    padding: 0.55rem 1.35rem;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 0.65rem;
    background: rgba(255, 255, 255, 0.1);
    color: #ffffff;
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
    transition: background-color 140ms ease, transform 120ms ease;
  }

  .startup-action:hover {
    background: rgba(255, 255, 255, 0.16);
  }

  .startup-action:active {
    transform: scale(0.97);
  }

  @keyframes startup-fade-in {
    from { opacity: 0; }
  }

  @keyframes startup-card-in {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
  }

  @media (max-width: 560px) {
    .startup-veil { padding: 0.75rem; }
    .startup-card { border-radius: 1rem; }
    .startup-body { padding: 0.75rem 1.1rem 1.1rem; }
    .startup-bottom { align-items: stretch; flex-direction: column; }
    .startup-action { width: 100%; text-align: center; }
  }

  @media (prefers-reduced-motion: reduce) {
    .startup-card {
      animation: startup-fade-in 140ms ease-out both;
    }
  }
</style>
