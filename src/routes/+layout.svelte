<script lang="ts">
  import '../app.css';
  import { settings, initStore, currentTrack } from '$lib/stores';
  import Titlebar from '$lib/components/Titlebar.svelte';
  import { onMount } from 'svelte';
  import { Wrench } from 'lucide-svelte';
  import { APP_CHANNEL, APP_NAME, APP_VERSION } from '$lib/version';
  import { extractCoverAccent, rgbToHex } from '$lib/utils/coverAccent';
  import { lockDevTools } from '$lib/utils/devLock';
  import { trackSheen } from '$lib/utils/sheen';
  import { trackTilt } from '$lib/utils/tilt';
  import { trackPress } from '$lib/utils/press';

  let showStartupWarning = false;

  /** Отложенная сверка лайков. Держим ссылку, чтобы снять её, если окно закрыли раньше. */
  let likesSyncTask: ReturnType<typeof setTimeout> | null = null;
  let likesSyncInterval: ReturnType<typeof setInterval> | null = null;
  let lastLikesSyncAt = 0;
  let lastLikesSyncToken = '';

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

  function dismissWarning() {
    showStartupWarning = false;
    sessionStorage.setItem('lomify_unstable_warning_v2', 'true');
  }

  // Клавиатура закрывает окно так же, как кнопка: пока оно висит поверх всего, Enter и Esc
  // больше ни на что не назначены, а тянуться к мыши ради одной кнопки незачем.
  function onStartupKeydown(e: KeyboardEvent) {
    if (!showStartupWarning) return;
    if (e.key === 'Escape' || e.key === 'Enter') {
      e.preventDefault();
      dismissWarning();
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

      // Яндекс не присылает push-событие о лайке, поставленном на другом устройстве, поэтому
      // держим лёгкую фоновую сверку. Она не чаще раза в минуту, не работает без токена и
      // дополнительно срабатывает при возврате фокуса в окно.
      likesSyncInterval = setInterval(refreshYandexLikes, 60_000);
      window.addEventListener('focus', refreshYandexLikes);
      document.addEventListener('visibilitychange', refreshYandexLikes);

      const hasSeenWarning = sessionStorage.getItem('lomify_unstable_warning_v2');
      if (!hasSeenWarning) {
        showStartupWarning = true;
      }
    }

    return () => {
      releaseDevLock();
      releaseSheen();
      releaseTilt();
      releasePress();
      if (likesSyncTask !== null) clearTimeout(likesSyncTask);
      if (likesSyncInterval !== null) clearInterval(likesSyncInterval);
      window.removeEventListener('focus', refreshYandexLikes);
      document.removeEventListener('visibilitychange', refreshYandexLikes);
    };
  });

  $: {
    if (typeof document !== 'undefined' && $settings) {
      if ($settings.uiStyle === 'style3') {
        $settings.uiStyle = 'style1';
      }
      if ($settings.theme) {
        document.body.setAttribute('data-theme', $settings.theme);
      }
      document.body.setAttribute('data-ui-style', $settings.uiStyle || 'style1');
      document.body.setAttribute('data-global-theme', $settings.globalThemeEffect ? 'true' : 'false');
      // Глобальный дизайн — отдельная ось от uiStyle/theme: он переопределяет сами
      // материалы и типографику (src/design-aurora.css), а не только оттенок.
      document.body.setAttribute('data-design', $settings.design === 'aurora' ? 'aurora' : 'classic');

      // Режим производительности. Снимает самые дорогие эффекты (живое размытие фона под
      // панелями) без потери визуального строя: вместо стекла — плотная тёмная заливка.
      document.body.setAttribute('data-perf', $settings.perfMode ? 'light' : 'full');

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
      const lite = $settings.perfMode === true;
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
  $: applyCoverAccent($currentTrack?.coverUrl, $settings?.accentFromCover !== false);

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

{#if showStartupWarning}
  <div class="startup-veil" role="presentation">
    <div
      class="startup-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="startup-title"
      aria-describedby="startup-text"
    >
      <span class="startup-halo" aria-hidden="true"></span>

      <div class="startup-badge">
        <Wrench size={12} strokeWidth={2} />
        <span>{APP_NAME} {APP_VERSION} · {APP_CHANNEL}</span>
      </div>

      <h2 id="startup-title" class="display-title startup-title">Это сборка на ходу</h2>
      <p id="startup-text" class="startup-text">
        Что-то может отвалиться на полпути — трек не загрузится, кнопка не нажмётся.
        Если поймаешь такое, это баг, а не ты.
      </p>

      <button class="startup-action" use:focusOnMount on:click={dismissWarning}>
        Понял, поехали
      </button>
      <p class="startup-footnote">Показывается один раз за запуск</p>
    </div>
  </div>
{/if}

<style>
  /* Стартовое окно.
     Раньше первым, что человек видел при запуске, была жёлтая плашка со знаком опасности —
     тот же значок, которым системы предупреждают о потере данных. Здесь речь всего лишь о
     недоделанной сборке, так что смысл остался, а тон снят: значок инструмента в спокойной
     подложке и строка с версией вместо тревожного цвета.

     Появление вынесено в реальные `@keyframes`: в разметке стояли классы `animate-in
     fade-in zoom-in` из tailwindcss-animate, а этого плагина в проекте нет — то есть окно
     не анимировалось вовсе, просто возникало рывком поверх интерфейса. */
  .startup-veil {
    position: fixed;
    inset: 0;
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(14px) saturate(120%);
    -webkit-backdrop-filter: blur(14px) saturate(120%);
    animation: startup-veil-in 260ms ease-out both;
  }

  .startup-card {
    position: relative;
    overflow: hidden;
    width: 100%;
    max-width: 27rem;
    padding: 2rem;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    border-radius: 1.75rem;
    background: linear-gradient(
      168deg,
      rgba(255, 255, 255, 0.085) 0%,
      rgba(255, 255, 255, 0.035) 55%,
      rgba(255, 255, 255, 0.05) 100%
    );
    border: 1px solid rgba(255, 255, 255, 0.09);
    box-shadow:
      0 34px 90px rgba(0, 0, 0, 0.5),
      inset 0 1px 0 rgba(255, 255, 255, 0.07);
    backdrop-filter: blur(22px) saturate(150%);
    -webkit-backdrop-filter: blur(22px) saturate(150%);
    animation: startup-card-in 340ms cubic-bezier(0.16, 1, 0.3, 1) both;
  }

  /* Акцент темы (он же следует за обложкой) — единственное цветное пятно в окне, и оно
     светит из-за края, а не заливает значок. */
  .startup-halo {
    position: absolute;
    top: -45%;
    left: 50%;
    width: 130%;
    height: 90%;
    transform: translateX(-50%);
    pointer-events: none;
    background: radial-gradient(
      50% 50% at 50% 50%,
      color-mix(in srgb, var(--color-primary, #ffffff) 26%, transparent) 0%,
      transparent 70%
    );
    opacity: 0.55;
  }

  .startup-badge {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.3rem 0.65rem 0.3rem 0.5rem;
    margin-bottom: 1.35rem;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.055);
    border: 1px solid rgba(255, 255, 255, 0.075);
    color: rgba(255, 255, 255, 0.5);
    font-size: 11.5px;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .startup-title {
    position: relative;
    margin-bottom: 0.6rem;
  }

  .startup-text {
    position: relative;
    margin-bottom: 1.6rem;
    font-size: 13.5px;
    line-height: 1.65;
    color: rgba(255, 255, 255, 0.48);
  }

  .startup-action {
    position: relative;
    width: 100%;
    padding: 0.85rem 0;
    border-radius: 0.85rem;
    background: rgba(255, 255, 255, 0.94);
    color: #000;
    font-size: 14px;
    font-weight: 500;
    transition:
      background 150ms ease,
      transform 150ms ease;
  }

  .startup-action:hover {
    background: #fff;
  }

  .startup-action:active {
    transform: scale(0.99);
  }

  .startup-action:focus-visible {
    outline: 2px solid rgba(255, 255, 255, 0.35);
    outline-offset: 2px;
  }

  .startup-footnote {
    position: relative;
    width: 100%;
    margin-top: 0.85rem;
    text-align: center;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.28);
  }

  @keyframes startup-veil-in {
    from {
      opacity: 0;
    }
  }

  @keyframes startup-card-in {
    from {
      opacity: 0;
      transform: translateY(10px) scale(0.975);
    }
  }

  /* Уважаем системную просьбу «без анимаций»: окно всё равно должно появиться. */
  @media (prefers-reduced-motion: reduce) {
    .startup-veil,
    .startup-card {
      animation-duration: 1ms;
    }
  }
</style>
