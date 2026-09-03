<script lang="ts">
  import '../app.css';
  import { settings, initStore, currentTrack, effectivePerformanceMode } from '$lib/stores';
  import Titlebar from '$lib/components/Titlebar.svelte';
  import { onMount } from 'svelte';
  import { ArrowRight, Terminal } from 'lucide-svelte';
  import { APP_CHANNEL, APP_NAME, APP_VERSION } from '$lib/version';
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
  let startupAction: HTMLButtonElement;
  const STARTUP_NOTICE_KEY = 'lomify_stable_notice_v1';

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
    lastLikesSyncAt = Date.now();
    lastLikesSyncToken = $settings.yandexToken || '';
    import('$lib/likes').then(({ syncLikes }) => {
      syncLikes({ silent: true }).catch((e) => console.warn('[likes] сверка сорвалась', e));
    });
  }

  function dismissStartupNotice() {
    showStartupNotice = false;
    sessionStorage.setItem(STARTUP_NOTICE_KEY, 'true');
  }

  // Клавиатура закрывает окно так же, как кнопка: пока оно висит поверх всего, Enter и Esc
  // больше ни на что не назначены, а тянуться к мыши ради одной кнопки незачем.
  function onStartupKeydown(e: KeyboardEvent) {
    if (!showStartupNotice) return;
    if (e.key === 'Tab') {
      e.preventDefault();
      startupAction?.focus();
      return;
    }
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      dismissStartupNotice();
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

      const hasSeenNotice = sessionStorage.getItem(STARTUP_NOTICE_KEY);
      if (!hasSeenNotice) {
        showStartupNotice = true;
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

<svelte:window on:keydown={onStartupKeydown} />

<Titlebar />
<slot />

{#if showStartupNotice}
  <div class="startup-veil">
    <div
      class="startup-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="startup-title"
      aria-describedby="startup-text"
    >
      <div class="startup-copy">
        <div class="startup-heading">
          <span class="startup-icon" aria-hidden="true"><Terminal size={18} /></span>
          <div class="startup-meta">
            <span class="startup-build">{APP_NAME} {APP_VERSION}</span>
            <span class="startup-status"><i></i>{APP_CHANNEL}</span>
          </div>
        </div>

        <h2 id="startup-title" class="display-title startup-title">Версия уже стабильна</h2>
        <p id="startup-text" class="startup-text">
          Основные сценарии работают уверенно — можно пользоваться каждый день. Зелёный
          тег оставили для честности: редкая шероховатость всё ещё возможна.
        </p>

        <div class="startup-footer">
          <button
            class="startup-action"
            bind:this={startupAction}
            use:focusOnMount
            on:click={dismissStartupNotice}
          >
            <span>Открыть Lomify</span>
            <ArrowRight size={17} strokeWidth={2} />
          </button>
          <p class="startup-footnote">Один раз за запуск <span>Enter</span></p>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  /* Стартовый статус намеренно спокойнее основного интерфейса: одна компактная панель,
     обычная иерархия и единственный зелёный акцент на честной пометке канала. */
  .startup-veil {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(3, 3, 4, 0.56);
    backdrop-filter: blur(12px) saturate(108%);
    -webkit-backdrop-filter: blur(12px) saturate(108%);
    animation: startup-fade-in 250ms var(--ease-smooth-out) both;
  }

  .startup-card {
    position: relative;
    overflow: hidden;
    width: min(31rem, 100%);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 1.5rem;
    background: linear-gradient(155deg, rgba(29, 28, 31, 0.97), rgba(17, 16, 19, 0.97));
    box-shadow:
      0 24px 72px rgba(0, 0, 0, 0.48),
      inset 0 1px 0 rgba(255, 255, 255, 0.06);
    animation: startup-card-in 250ms var(--ease-smooth-out) both;
  }

  .startup-card::before {
    content: '';
    position: absolute;
    inset: 0 12% auto;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.18), transparent);
    pointer-events: none;
  }

  .startup-copy {
    padding: 1.85rem;
  }

  .startup-heading {
    display: flex;
    align-items: center;
    gap: 0.8rem;
    margin-bottom: 1.45rem;
  }

  .startup-icon {
    width: 2.55rem;
    height: 2.55rem;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid rgba(255, 255, 255, 0.09);
    border-radius: 0.85rem;
    background: rgba(255, 255, 255, 0.045);
    color: rgba(255, 255, 255, 0.58);
  }

  .startup-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.45rem;
  }

  .startup-build,
  .startup-status {
    display: inline-flex;
    align-items: center;
    min-height: 1.5rem;
    border-radius: 999px;
    font: 600 10px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
    letter-spacing: 0.035em;
    white-space: nowrap;
  }

  .startup-build {
    padding: 0.28rem 0.58rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.03);
    color: rgba(255, 255, 255, 0.48);
  }

  .startup-status {
    gap: 0.38rem;
    padding: 0.28rem 0.6rem;
    border: 1px solid rgba(113, 241, 151, 0.18);
    background: rgba(93, 222, 131, 0.075);
    color: rgba(156, 243, 182, 0.78);
  }

  .startup-status i {
    width: 0.38rem;
    height: 0.38rem;
    border-radius: 50%;
    background: #72ea96;
    box-shadow: 0 0 0.5rem rgba(114, 234, 150, 0.38);
  }

  .startup-title {
    margin: 0 0 0.85rem;
    color: rgba(255, 255, 255, 0.9);
    font-size: clamp(1.75rem, 4vw, 2.15rem);
    line-height: 1.06;
    letter-spacing: -0.035em;
  }

  .startup-text {
    max-width: 56ch;
    margin: 0 0 1.55rem;
    color: rgba(255, 255, 255, 0.46);
    font-size: 13px;
    line-height: 1.6;
  }

  .startup-footer {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .startup-action {
    flex: 1;
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.85rem 1rem 0.85rem 1.05rem;
    border: 1px solid rgba(255, 255, 255, 0.11);
    border-radius: 0.9rem;
    background: rgba(255, 255, 255, 0.075);
    color: rgba(255, 255, 255, 0.86);
    font-size: 13px;
    font-weight: 650;
    transition:
      background-color 150ms ease,
      border-color 150ms ease,
      transform 160ms var(--ease-smooth-out);
  }

  .startup-action:active {
    transform: scale(0.97);
  }

  .startup-action:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.28);
    outline-offset: 3px;
  }

  .startup-footnote {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    color: rgba(255, 255, 255, 0.3);
    font-size: 10.5px;
    white-space: nowrap;
  }

  .startup-footnote span {
    padding: 0.25rem 0.38rem;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 0.35rem;
    color: rgba(255, 255, 255, 0.46);
    font: 600 9px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
    text-transform: uppercase;
  }

  @media (hover: hover) and (pointer: fine) {
    .startup-action:hover {
      border-color: rgba(255, 255, 255, 0.17);
      background: rgba(255, 255, 255, 0.11);
    }
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
    .startup-card { border-radius: 1.25rem; }
    .startup-copy { padding: 1.45rem; }
    .startup-title { font-size: 1.75rem; }
    .startup-footer { align-items: stretch; flex-direction: column; }
    .startup-action { width: 100%; }
    .startup-footnote { justify-content: center; }
  }

  @media (prefers-reduced-motion: reduce) {
    .startup-card {
      animation: startup-fade-in 180ms var(--ease-smooth-out) both;
    }

  }
</style>
