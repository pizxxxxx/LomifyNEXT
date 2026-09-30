<script lang="ts">
  import { currentTrack, currentView, previousView, isPlaying, settings, lyricsStatus, lyricsReloadTrigger, notify, rebootCurrentTrack } from '$lib/stores';
  import {
    Minimize2, AlignLeft, AlignCenter, Settings2, Ghost, Search, Sparkles, Loader2,
    Volume2, Mic2, MessageSquareQuote, Gauge, Layout, Activity, Clapperboard, Maximize2, ChevronRight, X
  } from 'lucide-svelte';
  import { refetchLyrics } from '$lib/api';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { onMount, onDestroy } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import Lyrics from './Lyrics.svelte';
  import BackdropAdlibStage from './BackdropAdlibStage.svelte';
  import ArtistTag from './ArtistTag.svelte';
  import { FFT_BINS, readFftInto } from '$lib/fft';
  import { coverUrlForTrack, downloadedCoverCache } from '$lib/offlineCovers';
  import { getYandexTrackVideoUri, normalizeYandexVideoUri } from '$lib/yandex';

  let canvas: HTMLCanvasElement;
  let unlistenFft: UnlistenFn;
  /** Буфер полос: один на весь режим, чтобы не выделять массив тридцать раз в секунду. */
  const bins = new Float32Array(FFT_BINS);
  let vizGrad: CanvasGradient | null = null;
  let vizGradKey = '';

  /**
   * Панель текста закрыта на входе, даже когда настройка «показывать сразу» включена.
   * Разворачивает её реактивное правило ниже - и только после того, как текст реально
   * нашёлся. Раньше здесь стояло `$settings.showLyricsByDefault`, и панель открывалась
   * до ответа баз: на треке без текста человек попадал в пустую половину экрана и закрывал
   * её руками на каждом втором треке. Настройка обещает текст, а не место под текст.
   */
  let showLyrics = false;
  let showSettings = false;
  let activeModule: 'spatial' | 'lyrics' | 'adlibs' | 'speed' | 'layout' | null = null;

  function selectModule(mod: 'spatial' | 'lyrics' | 'adlibs' | 'speed' | 'layout') {
    activeModule = activeModule === mod ? null : mod;
  }

  function activateModuleKey(event: KeyboardEvent, mod: 'spatial' | 'lyrics' | 'adlibs' | 'speed' | 'layout') {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectModule(mod);
    }
  }

  function toggleSpatial() {
    const nextVal = !$settings.spatialAudio;
    settings.update(s => ({ ...s, spatialAudio: nextVal }));
    if (nextVal) {
      activeModule = 'spatial';
    }
    invoke('audio_set_spatial', {
      enabled: nextVal,
      roomSize: Number($settings.spatialRoomSize ?? 0.5),
      intensity: Number($settings.spatialIntensity ?? 0.85)
    }).catch(() => {});
  }

  function setRoomSize(size: number) {
    settings.update(s => ({ ...s, spatialRoomSize: size }));
    invoke('audio_set_spatial', {
      enabled: Boolean($settings.spatialAudio),
      roomSize: size,
      intensity: Number($settings.spatialIntensity ?? 0.85)
    }).catch(() => {});
  }

  function setSpatialIntensity(intensity: number) {
    settings.update(s => ({ ...s, spatialIntensity: intensity }));
    invoke('audio_set_spatial', {
      enabled: Boolean($settings.spatialAudio),
      roomSize: Number($settings.spatialRoomSize ?? 0.5),
      intensity: intensity
    }).catch(() => {});
  }

  /**
   * Рисовать ли спектр. `!== false` — чтобы сохранённые настройки без этого ключа вели себя
   * как «включено»: у людей, которые обновились, полноэкранный режим не должен внезапно
   * стать другим.
   *
   * Проверяется и в обработчике `audio:fft`, и на самом `<canvas>`. Только разметки не хватит:
   * событие приходит шестьдесят раз в секунду независимо от того, есть ли куда рисовать, и
   * без проверки обработчик продолжал бы будить страницу впустую. Только проверки в
   * обработчике тоже не хватит — на холсте остался бы последний кадр полос.
   */
  $: visualizerOn = $settings.fullscreenVisualizer !== false;
  $: yandexVideoOn = $settings.fullscreenYandexVideo !== false;
  $: yandexVideoFill = $settings.fullscreenYandexVideoFill !== false;
  $: fullscreenLyricsSync = $settings.fullscreenLyricsSync !== false;
  $: currentDisplayCover = coverUrlForTrack($currentTrack, $downloadedCoverCache);

  const titleDetailPattern = /\([^()]+\)|\[[^\[\]]+\]/g;

  function splitTrackTitle(title: string): { main: string; detail: string } {
    const details = title.match(titleDetailPattern) ?? [];
    const main = title.replace(titleDetailPattern, ' ').replace(/\s+/g, ' ').trim();
    return main && details.length
      ? { main, detail: details.join(' ') }
      : { main: title, detail: '' };
  }
  $: displayedTitle = splitTrackTitle($currentTrack?.title || '');

  function panOverflow(node: HTMLElement) {
    const content = node.firstElementChild as HTMLElement | null;
    if (!content) return {};
    const update = () => {
      const distance = Math.max(0, Math.ceil(content.scrollWidth - node.clientWidth));
      node.style.setProperty('--title-pan-distance', `${distance}px`);
      node.style.setProperty('--title-pan-duration', `${Math.max(8, distance / 22 + 4)}s`);
      node.classList.toggle('is-overflowing', distance > 2);
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    observer.observe(content);
    update();
    return { destroy: () => observer.disconnect() };
  }

  let videoElement: HTMLVideoElement | undefined;
  let videoUrl = '';
  let videoFailed = false;
  let videoGeneration = 0;
  let lastVideoKey = '';
  $: videoKey = yandexVideoOn && $currentTrack?.source === 'yandex' && $currentTrack.id
    ? `${$currentTrack.id}|${$settings.yandexToken}` : '';
  $: if (videoKey !== lastVideoKey) {
    lastVideoKey = videoKey;
    void loadTrackVideo(videoKey);
  }

  async function loadTrackVideo(key: string) {
    const generation = ++videoGeneration;
    videoUrl = '';
    videoFailed = false;
    if (!key || !$currentTrack) return;
    const mapped = normalizeYandexVideoUri($currentTrack.backgroundVideoUri);
    if (mapped) {
      videoUrl = mapped;
      return;
    }
    try {
      const found = await getYandexTrackVideoUri($settings.yandexToken, `${$currentTrack.id}`);
      if (generation === videoGeneration) videoUrl = found;
    } catch (error) {
      // Видео необязательно: обложка остаётся фоном, даже если этот запрос не прошёл.
      console.debug('[yandex] видеошот недоступен', error);
    }
  }

  $: if (videoElement) {
    if ($isPlaying) {
      const element = videoElement;
      void element.play().catch(() => { if (videoElement === element) videoFailed = true; });
    }
    else videoElement.pause();
  }

  /**
   * Иммерсивная раскладка: с включённым текстом обложка вместе с названием уезжает вверх за
   * край экрана, а слова выезжают снизу без панели, крупным кеглем почти во всю ширину.
   *
   * `=== 'immersive'` (а не `!== 'panel'`) — чтобы и отсутствие ключа в старых сохранённых
   * настройках, и любое незнакомое значение давали привычную раскладку.
   */
  $: immersive = $settings.fullscreenStyle === 'immersive';

  /**
   * Подпись переключателя текста. Обещать текст на треке, которого нет ни в одной базе, —
   * единственная неправда, которую этот экран говорил: человек открывал панель, видел
   * пустоту, закрывал и открывал ещё раз, потому что кнопка продолжала звать. Ответ известен
   * заранее — плеер спрашивает текст в фоне при загрузке трека ([[lyricsStatus]]).
   *
   * `unknown` (ещё не спрашивали или сеть отвалилась) намеренно ведёт себя как раньше:
   * «текста нет» — это утверждение, и говорить его без ответа нельзя.
   *
   * При `none` переключатель ещё и не нажимается: показывать пустую панель не за чем, а
   * подпись под курсором объясняет, почему кнопка не отвечает. Отключён именно вход — уже
   * открытый текст всегда можно закрыть, иначе состояние стало бы необратимым.
   */
  $: noLyrics = !showLyrics && $lyricsStatus === 'none';
  $: lyricsHint = showLyrics
    ? 'Скрыть текст'
    : $lyricsStatus === 'none'
      ? 'Текста нет - только музыка'
      : $lyricsStatus === 'loading'
        ? 'Ищу текст...'
        : 'Показать текст';

  /**
   * Автооткрытие текста по настройке. Условие ровно одно: текст подтверждён (`found`).
   * `loading` и `unknown` не считаются - на них ответ ещё неизвестен, а `none` означает,
   * что открывать нечего.
   *
   * `lyricsTouched` ставит ручной выбор выше настройки: закрыл панель на этом треке - она
   * не откроется обратно сама. Флаг снимается на смене трека, поэтому на следующем треке
   * настройка снова работает, а не остаётся выключенной до конца сеанса.
   */
  let lyricsTouched = false;
  let lyricsAutoTrack: unknown = null;

  $: if ($currentTrack !== lyricsAutoTrack) {
    lyricsAutoTrack = $currentTrack;
    lyricsTouched = false;
  }

  $: if (!showLyrics && !lyricsTouched && $settings.showLyricsByDefault && $lyricsStatus === 'found') {
    showLyrics = true;
  }

  /** Переключить текст, если его есть что показывать. */
  function toggleLyrics() {
    if (noLyrics) return;
    lyricsTouched = true;
    showLyrics = !showLyrics;
  }

  let isSearchingLyrics = false;
  let lyricsSearchResult: 'idle' | 'found' | 'not_found' = 'idle';
  let lyricsSearchTimeout: any = null;

  $: if ($currentTrack) {
    lyricsSearchResult = 'idle';
  }

  async function handleMbNaydetsa() {
    if (!$currentTrack || isSearchingLyrics) return;
    isSearchingLyrics = true;
    lyricsSearchResult = 'idle';
    lyricsStatus.set('loading');
    clearTimeout(lyricsSearchTimeout);

    try {
      const text = await refetchLyrics($currentTrack);
      if (text) {
        lyricsSearchResult = 'found';
        lyricsStatus.set('found');
        lyricsReloadTrigger.update(n => n + 1);
        showLyrics = true;
        notify('Текст песни найден и синхронизирован!', 'success');
      } else {
        lyricsSearchResult = 'not_found';
        lyricsStatus.set('none');
        lyricsReloadTrigger.update(n => n + 1);
        notify('Текст для этого трека пока не найден.', 'info');
      }
    } catch (e) {
      lyricsSearchResult = 'not_found';
      lyricsStatus.set('none');
      notify('Не удалось выполнить повторный поиск текста.', 'error');
    } finally {
      isSearchingLyrics = false;
      lyricsSearchTimeout = setTimeout(() => {
        lyricsSearchResult = 'idle';
      }, 3000);
    }
  }

  /**
   * Появление попапа настроек. Раньше переход назывался `blurFadeScale` и на каждом кадре
   * пересчитывал `filter: blur()` — а размытие браузер не отдаёт композитору: он заново
   * растрирует и панель, и `backdrop-blur` под ней, 60 раз в секунду. Именно это и было
   * видно как рывок при открытии. Остались только `opacity` и `transform` — их анимирует
   * GPU, не касаясь layout и paint.
   */
  function popFade(node: HTMLElement, params: { duration?: number } = {}) {
    const duration = params.duration ?? 350;
    return {
      duration,
      easing: cubicOut,
      css: (t: number) => `opacity: ${t}; transform: scale(${0.95 + 0.05 * t});`
    };
  }

  $: {
    if (typeof window !== 'undefined' && $settings.playbackRate) {
       invoke('audio_set_playback_rate', { rate: Number($settings.playbackRate) }).catch(console.error);
    }
  }

  onMount(async () => {
    // Сознательно НЕ трогаем нативный полный экран (ни setFullscreen окна в Tauri, ни
    // requestFullscreen в браузере). На Windows растянутое окно перекрывает меню «Пуск»,
    // а само переключение размера окна ломало попадание клика по левой части интерфейса.
    // «Fullscreen» здесь — оверлей внутри окна, и этого достаточно.
    window.addEventListener('keydown', onKeydown);

    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      unlistenFft = await listen<number[]>('audio:fft', (event) => {
        if (!canvas || !visualizerOn) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        // ensure canvas dimensions match its physical size
        if (canvas.width !== canvas.offsetWidth || canvas.height !== canvas.offsetHeight) {
            canvas.width = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
        }

        const bars = event.payload;
        if (!readFftInto(bars, bins)) return;

        const width = canvas.width;
        const height = canvas.height;

        ctx.clearRect(0, 0, width, height);

        const barCount = bins.length;
        // Симметричные отступы по краям и равномерный шаг полос
        const gx = width * 0.015;
        const gw = Math.max(24, width * 0.97);
        const barStep = gw / barCount;
        const barW = Math.max(3, barStep * 0.68);
        const slotOffset = (barStep - barW) * 0.5;

        // Вертикальный градиент: прозрачный низ, лёгкий белый к середине, почти прозрачный
        // верх. Никакого акцентного свечения — мягкие столбики, растворяющиеся кверху.
        const key = `${width}|${height}|${gw}`;
        if (!vizGrad || vizGradKey !== key) {
          vizGradKey = key;
          vizGrad = ctx.createLinearGradient(0, height, 0, 0);
          vizGrad.addColorStop(0, 'rgba(255, 255, 255, 0.02)');
          vizGrad.addColorStop(0.45, 'rgba(255, 255, 255, 0.16)');
          vizGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');
        }
        ctx.fillStyle = vizGrad!;

        for (let i = 0; i < barCount; i++) {
          const v = bins[i];
          // Слегка степенная кривая: удары выстреливают, тихий фон оседает.
          const intensity = Math.pow(v, 1.4);
          const barHeight = Math.max(2, intensity * height * 0.34);

          const x = gx + i * barStep + slotOffset;
          const rad = Math.min(barW * 0.5, 10);

          ctx.beginPath();
          ctx.roundRect(x, height - barHeight, barW, barHeight, [rad, rad, 2, 2]);
          ctx.fill();
        }
      });
    }
  });

  onDestroy(() => {
    videoGeneration += 1;
    if (unlistenFft) unlistenFft();
    if (lyricsSearchTimeout) clearTimeout(lyricsSearchTimeout);
    if (typeof window !== 'undefined') window.removeEventListener('keydown', onKeydown);
  });

  // Единственный выход из режима. `previousView` может уже указывать на 'fullscreen'
  // (например, режим открыли со страницы, которая сама успела туда записаться) — тогда
  // кнопка «выйти» не сделала бы ничего, поэтому подстраховываемся главной.
  function exitOverlay() {
    $currentView = $previousView && $previousView !== 'fullscreen' ? $previousView : 'home';
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    // Esc — «на шаг назад»: сперва закрывается попап настроек, и только потом режим.
    if (showSettings) {
      showSettings = false;
      return;
    }
    exitOverlay();
  }
</script>

<div class="relative w-full h-full flex items-center justify-center">
  {#if $currentTrack}
    <div class="fs-backdrop-layer absolute inset-0 z-0 pointer-events-none overflow-hidden">
      <img src={currentDisplayCover} alt="bg" class="fs-cover-backdrop w-full h-full object-cover blur-[100px] scale-150 opacity-40 transition-transform duration-1000" />
      {#if yandexVideoOn && videoUrl && !videoFailed}
        {#key videoUrl}
          <video
            bind:this={videoElement}
            class="fs-yandex-video"
            class:is-screen-fill={yandexVideoFill}
            src={videoUrl}
            autoplay
            muted
            loop
            playsinline
            preload="auto"
            aria-hidden="true"
            on:error={() => videoFailed = true}
          ></video>
        {/key}
      {/if}
      <div class="absolute inset-0 bg-gradient-to-b from-black/20 via-black/40 to-[var(--color-dark)]"></div>
      {#if visualizerOn}
        <canvas bind:this={canvas} class="absolute inset-0 w-full h-full opacity-60"></canvas>
      {/if}
    </div>
    
    <BackdropAdlibStage isFullscreen={true} />

    <div class="fs-top-actions">
      {#if immersive}
        <!-- В иммерсивной раскладке обложка с включённым текстом уходит за экран — вместе с
             ней уезжает и наведение на неё, которым текст переключали. Без этой кнопки
             состояние было бы необратимым, поэтому здесь она обязательна, а не украшение.
             В панельной раскладке её нет намеренно: там обложка на месте и всё уже работает. -->
        <button
          type="button"
          class="fs-top-action"
          class:is-active={showLyrics}
          on:click={toggleLyrics}
          disabled={noLyrics}
          aria-pressed={showLyrics}
          aria-label={lyricsHint}
          data-label={lyricsHint}
        >
          {#if showLyrics}
            <AlignCenter size={21} strokeWidth={1.8} />
          {:else if noLyrics}
            <Ghost size={21} strokeWidth={1.8} />
          {:else}
            <AlignLeft size={21} strokeWidth={1.8} />
          {/if}
        </button>
      {/if}

      <div class="fs-settings-anchor">
        <button
          type="button"
          class="fs-top-action"
          class:is-active={showSettings}
          on:click={() => showSettings = !showSettings}
          aria-label="Настройки полноэкранного режима"
          aria-expanded={showSettings}
          aria-controls="fullscreen-settings-pop"
          data-label="Настройки экрана"
        >
          <Settings2 size={21} strokeWidth={1.8} />
        </button>
        
        {#if showSettings}
          <div
            id="fullscreen-settings-pop"
            role="dialog"
            aria-label="Настройки полноэкранного режима"
            transition:popFade
            class="fs-settings-pop-wrapper origin-top-right"
          >
            <!-- Главный столбец со списком модулей -->
            <div class="fs-settings-card fs-settings-main">
              <div class="fs-modules-heading">
                <span>Модули экрана</span>
              </div>

              <!-- 1. Модуль: Объемный звук -->
              <div
                class="fs-module-row group"
                class:is-active={activeModule === 'spatial'}
              >
                <button type="button" class="fs-module-open" on:click={() => selectModule('spatial')} aria-expanded={activeModule === 'spatial'} aria-label="Настройки объемного звука">
                  <div class="fs-module-icon">
                    <Volume2 size={15} />
                  </div>
                  <div class="fs-module-copy">
                    <span class="fs-module-title">Объемный звук</span>
                    <span class="fs-module-status">
                      {$settings.spatialAudio
                        ? (($settings.spatialRoomSize ?? 0.5) < 0.35 ? 'Студия' : ($settings.spatialRoomSize ?? 0.5) < 0.7 ? 'Комната' : 'Зал')
                        : 'Выключено'}
                    </span>
                  </div>
                </button>
                <div class="fs-module-actions">
                  <button
                    type="button"
                    aria-label="Объемный звук"
                    role="switch"
                    aria-checked={Boolean($settings.spatialAudio)}
                    class="switch fs-module-switch"
                    on:click={toggleSpatial}
                  >
                    <span class="switch-knob"></span>
                  </button>
                  <button
                    type="button"
                    class="fs-module-chevron"
                    on:click={() => selectModule('spatial')}
                    aria-label={activeModule === 'spatial' ? 'Закрыть настройки объемного звука' : 'Открыть настройки объемного звука'}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>

              <!-- 2. Модуль: Синхронизация текста -->
              <div
                class="fs-module-row group"
                class:is-active={activeModule === 'lyrics'}
              >
                <button type="button" class="fs-module-open" on:click={() => selectModule('lyrics')} aria-expanded={activeModule === 'lyrics'} aria-label="Настройки текста и караоке">
                  <div class="fs-module-icon">
                    <Mic2 size={15} />
                  </div>
                  <div class="fs-module-copy">
                    <span class="fs-module-title">Текст и караоке</span>
                    <span class="fs-module-status">
                      {fullscreenLyricsSync ? 'Подсветка по буквам' : 'Построчно'}
                    </span>
                  </div>
                </button>
                <div class="fs-module-actions">
                  <button
                    type="button"
                    aria-label="Подсветка текста по буквам"
                    role="switch"
                    aria-checked={fullscreenLyricsSync}
                    class="switch fs-module-switch"
                    on:click={() => settings.update(s => ({ ...s, fullscreenLyricsSync: !fullscreenLyricsSync }))}
                  >
                    <span class="switch-knob"></span>
                  </button>
                  <button
                    type="button"
                    class="fs-module-chevron"
                    on:click={() => selectModule('lyrics')}
                    aria-label={activeModule === 'lyrics' ? 'Закрыть настройки текста' : 'Открыть настройки текста'}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>

              <!-- 3. Модуль: Фоновые эдлибы -->
              <div
                class="fs-module-row group"
                class:is-active={activeModule === 'adlibs'}
              >
                <button type="button" class="fs-module-open" on:click={() => selectModule('adlibs')} aria-expanded={activeModule === 'adlibs'} aria-label="Настройки фоновых эдлибов">
                  <div class="fs-module-icon">
                    <MessageSquareQuote size={15} />
                  </div>
                  <div class="fs-module-copy">
                    <span class="fs-module-title">Фоновые эдлибы</span>
                    <span class="fs-module-status">
                      {$settings.lyricsAdlibs !== false ? ($settings.lyricsAdlibStyle === 'backdrop' ? 'Под текстом' : 'Над текстом') : 'Выключено'}
                    </span>
                  </div>
                </button>
                <div class="fs-module-actions">
                  <button
                    type="button"
                    aria-label="Выделение эдлибов (damn)"
                    role="switch"
                    aria-checked={$settings.lyricsAdlibs !== false}
                    class="switch fs-module-switch"
                    on:click={() => {
                      settings.update(s => ({ ...s, lyricsAdlibs: s.lyricsAdlibs === false }));
                      rebootCurrentTrack();
                    }}
                  >
                    <span class="switch-knob"></span>
                  </button>
                  <button
                    type="button"
                    class="fs-module-chevron"
                    on:click={() => selectModule('adlibs')}
                    aria-label={activeModule === 'adlibs' ? 'Закрыть настройки эдлибов' : 'Открыть настройки эдлибов'}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              </div>

              <!-- 4. Модуль: Скорость трека -->
              <div
                class="fs-module-row group"
                class:is-active={activeModule === 'speed'}
                on:click={() => selectModule('speed')}
                on:keydown={(event) => activateModuleKey(event, 'speed')}
                role="button"
                tabindex="0"
                aria-expanded={activeModule === 'speed'}
                aria-label="Настройки скорости трека"
              >
                <div class="flex items-center gap-2.5 min-w-0">
                  <div class="fs-module-icon">
                    <Gauge size={15} />
                  </div>
                  <div class="fs-module-copy">
                    <span class="fs-module-title">Скорость трека</span>
                    <span class="fs-module-status">Темп воспроизведения</span>
                  </div>
                </div>
                <div class="fs-module-actions">
                  <span class="fs-module-value tnum">
                    {($settings.playbackRate || 1.0).toFixed(2)}x
                  </span>
                  <span class="fs-module-chevron" aria-hidden="true"><ChevronRight size={14} /></span>
                </div>
              </div>

              <!-- 5. Модуль: Раскладка экрана -->
              <div
                class="fs-module-row group"
                class:is-active={activeModule === 'layout'}
                on:click={() => selectModule('layout')}
                on:keydown={(event) => activateModuleKey(event, 'layout')}
                role="button"
                tabindex="0"
                aria-expanded={activeModule === 'layout'}
                aria-label="Настройки раскладки экрана"
              >
                <div class="flex items-center gap-2.5 min-w-0">
                  <div class="fs-module-icon">
                    <Layout size={15} />
                  </div>
                  <div class="fs-module-copy">
                    <span class="fs-module-title">Раскладка</span>
                    <span class="fs-module-status">
                      {immersive ? 'Погружение' : 'Панель'}
                    </span>
                  </div>
                </div>
                <div class="fs-module-actions">
                  <span class="fs-module-chevron" aria-hidden="true"><ChevronRight size={14} /></span>
                </div>
              </div>

              <!-- 6. Модуль: Визуализатор (простой переключатель без подменю) -->
              <div
                class="fs-module-row"
              >
                <div class="flex items-center gap-2.5 min-w-0">
                  <div class="fs-module-icon">
                    <Activity size={15} />
                  </div>
                  <div class="fs-module-copy">
                    <span class="fs-module-title">Визуализатор</span>
                    <span class="fs-module-status">Полосы спектра внизу</span>
                  </div>
                </div>
                <div class="fs-module-actions">
                  <button
                    type="button"
                    aria-label="Визуализатор"
                    role="switch"
                    aria-checked={visualizerOn}
                    class="switch fs-module-switch"
                    on:click={() => settings.update(s => ({ ...s, fullscreenVisualizer: !visualizerOn }))}
                  >
                    <span class="switch-knob"></span>
                  </button>
                </div>
              </div>
              <div class="fs-module-row">
                <div class="flex items-center gap-2.5 min-w-0">
                  <div class="fs-module-icon"><Clapperboard size={15} /></div>
                  <div class="fs-module-copy">
                    <span class="fs-module-title">Видеошоты Яндекса</span>
                    <span class="fs-module-status">Фон, если видео есть у трека</span>
                  </div>
                </div>
                <div class="fs-module-actions">
                  <button
                    type="button"
                    aria-label="Видеошоты Яндекс Музыки на фоне"
                    role="switch"
                    aria-checked={yandexVideoOn}
                    class="switch fs-module-switch"
                    on:click={() => settings.update(s => ({ ...s, fullscreenYandexVideo: !yandexVideoOn }))}
                  ><span class="switch-knob"></span></button>
                </div>
              </div>
              <div class="fs-module-row">
                <div class="flex items-center gap-2.5 min-w-0">
                  <div class="fs-module-icon"><Maximize2 size={15} /></div>
                  <div class="fs-module-copy">
                    <span class="fs-module-title">Видео на весь экран</span>
                    <span class="fs-module-status">Растянуть и слегка размыть</span>
                  </div>
                </div>
                <div class="fs-module-actions">
                  <button
                    type="button"
                    aria-label="Растянуть и размыть видеошоты на весь экран"
                    role="switch"
                    aria-checked={yandexVideoFill}
                    class="switch fs-module-switch"
                    on:click={() => settings.update(s => ({ ...s, fullscreenYandexVideoFill: !yandexVideoFill }))}
                  ><span class="switch-knob"></span></button>
                </div>
              </div>
            </div>

            <!-- Левая панель с подробными настройками активного модуля -->
            {#if activeModule}
              <div
                class="fs-settings-card fs-settings-sub origin-top-right"
                transition:fly={{ x: 16, duration: 220, easing: cubicOut }}
              >
                <!-- Заголовок подпанели -->
                <div class="flex items-center justify-between pb-2 border-b border-white/[0.08]">
                  <div class="flex items-center gap-2 min-w-0">
                    {#if activeModule === 'spatial'}
                      <Volume2 size={16} class="text-white/70" />
                      <span class="text-white font-medium text-sm">Объемный звук</span>
                    {:else if activeModule === 'lyrics'}
                      <Mic2 size={16} class="text-primary" />
                      <span class="text-white font-medium text-sm">Текст и караоке</span>
                    {:else if activeModule === 'adlibs'}
                      <MessageSquareQuote size={16} class="text-white/70" />
                      <span class="text-white font-medium text-sm">Фоновые эдлибы</span>
                    {:else if activeModule === 'speed'}
                      <Gauge size={16} class="text-white/80" />
                      <span class="text-white font-medium text-sm">Скорость воспроизведения</span>
                    {:else if activeModule === 'layout'}
                      <Layout size={16} class="text-white/80" />
                      <span class="text-white font-medium text-sm">Раскладка полноэкранного режима</span>
                    {/if}
                  </div>
                  <button
                    type="button"
                    class="w-6 h-6 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
                    on:click={() => activeModule = null}
                    title="Закрыть настройки модуля"
                  >
                    <X size={15} />
                  </button>
                </div>

                <!-- Содержимое конкретного модуля -->
                {#if activeModule === 'spatial'}
                  <!-- Настройки Объемного звука -->
                  <div class="flex flex-col gap-3">
                    <div class="flex items-center justify-between p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08]">
                      <div class="flex flex-col">
                        <span class="text-white/90 text-xs font-medium">Объемный звук</span>
                        <span class="text-white/40 text-[11px] leading-tight">Пространственная сцена и отражения</span>
                      </div>
                      <button
                        type="button"
                        aria-label="Объемный звук"
                        role="switch"
                        aria-checked={Boolean($settings.spatialAudio)}
                        class="switch"
                        on:click={toggleSpatial}
                      >
                        <span class="switch-knob"></span>
                      </button>
                    </div>

                    <div class="flex flex-col gap-2 p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] {
                      !$settings.spatialAudio ? 'opacity-40 pointer-events-none' : ''
                    }">
                      <div class="flex justify-between items-center text-xs">
                        <span class="text-white/75 font-medium">Размер виртуальной комнаты</span>
                        <div class="flex items-center gap-1.5">
                          <span class="text-cyan-300 text-[11px] font-medium">
                            {($settings.spatialRoomSize ?? 0.5) < 0.35 ? 'Студия' : ($settings.spatialRoomSize ?? 0.5) < 0.7 ? 'Комната' : 'Зал'}
                          </span>
                          <span class="text-white tnum bg-white/10 px-1.5 py-0.5 rounded text-[11px]">
                            {Math.round(($settings.spatialRoomSize ?? 0.5) * 100)}%
                          </span>
                        </div>
                      </div>
                      <input
                        type="range"
                        min="0.1"
                        max="1.0"
                        step="0.05"
                        value={$settings.spatialRoomSize ?? 0.5}
                        on:input={(e) => setRoomSize(Number(e.currentTarget.value))}
                        class="w-full accent-primary mt-1"
                      />
                      <div class="grid grid-cols-3 gap-1 pt-1.5">
                        <button
                          type="button"
                          class="py-1 text-center rounded text-[11px] transition-colors {($settings.spatialRoomSize ?? 0.5) <= 0.3 ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/40 font-medium' : 'text-white/45 hover:text-white/80 bg-white/5'}"
                          on:click={() => setRoomSize(0.25)}
                        >
                          Студия
                        </button>
                        <button
                          type="button"
                          class="py-1 text-center rounded text-[11px] transition-colors {($settings.spatialRoomSize ?? 0.5) > 0.3 && ($settings.spatialRoomSize ?? 0.5) < 0.7 ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/40 font-medium' : 'text-white/45 hover:text-white/80 bg-white/5'}"
                          on:click={() => setRoomSize(0.5)}
                        >
                          Комната
                        </button>
                        <button
                          type="button"
                          class="py-1 text-center rounded text-[11px] transition-colors {($settings.spatialRoomSize ?? 0.5) >= 0.7 ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/40 font-medium' : 'text-white/45 hover:text-white/80 bg-white/5'}"
                          on:click={() => setRoomSize(0.85)}
                        >
                          Зал
                        </button>
                      </div>
                    </div>

                    <!-- Интенсивность / Глубина 3D сцены -->
                    <div class="flex flex-col gap-2 p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] {
                      !$settings.spatialAudio ? 'opacity-40 pointer-events-none' : ''
                    }">
                      <div class="flex justify-between items-center text-xs">
                        <span class="text-white/75 font-medium">Интенсивность объема</span>
                        <div class="flex items-center gap-1.5">
                          <span class="text-cyan-300 text-[11px] font-medium">
                            {($settings.spatialIntensity ?? 0.85) < 0.55 ? 'Мягкий' : ($settings.spatialIntensity ?? 0.85) < 0.9 ? 'Выраженный' : 'Максимум'}
                          </span>
                          <span class="text-white tnum bg-white/10 px-1.5 py-0.5 rounded text-[11px]">
                            {Math.round(($settings.spatialIntensity ?? 0.85) * 100)}%
                          </span>
                        </div>
                      </div>
                      <input
                        type="range"
                        min="0.3"
                        max="1.0"
                        step="0.05"
                        value={$settings.spatialIntensity ?? 0.85}
                        on:input={(e) => setSpatialIntensity(Number(e.currentTarget.value))}
                        class="w-full accent-primary mt-1"
                      />
                      <div class="grid grid-cols-3 gap-1 pt-1.5">
                        <button
                          type="button"
                          class="py-1 text-center rounded text-[11px] transition-colors {($settings.spatialIntensity ?? 0.85) <= 0.55 ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/40 font-medium' : 'text-white/45 hover:text-white/80 bg-white/5'}"
                          on:click={() => setSpatialIntensity(0.5)}
                        >
                          Мягкий
                        </button>
                        <button
                          type="button"
                          class="py-1 text-center rounded text-[11px] transition-colors {($settings.spatialIntensity ?? 0.85) > 0.55 && ($settings.spatialIntensity ?? 0.85) < 0.95 ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/40 font-medium' : 'text-white/45 hover:text-white/80 bg-white/5'}"
                          on:click={() => setSpatialIntensity(0.85)}
                        >
                          Выраженный
                        </button>
                        <button
                          type="button"
                          class="py-1 text-center rounded text-[11px] transition-colors {($settings.spatialIntensity ?? 0.85) >= 0.95 ? 'bg-cyan-500/25 text-cyan-200 border border-cyan-400/40 font-medium' : 'text-white/45 hover:text-white/80 bg-white/5'}"
                          on:click={() => setSpatialIntensity(1.0)}
                        >
                          Максимум
                        </button>
                      </div>
                    </div>

                    <div class="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.05] text-[11px] text-white/40 leading-relaxed">
                      Виртуальная стереосцена с отражениями комнаты. Эффект лучше слышен в наушниках; оригинальный звук возвращается при выключении.
                    </div>
                  </div>

                {:else if activeModule === 'lyrics'}
                  <!-- Настройки Текста и караоке -->
                  <div class="flex flex-col gap-3">
                    <!-- Повторный поиск текста («мб найдеца») -->
                    <div class="flex flex-col gap-2 p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08]">
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-white/85 font-medium text-xs whitespace-nowrap">Поиск слов</span>
                        {#if lyricsSearchResult === 'found'}
                          <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/35 tracking-wide">Найдено</span>
                        {:else if lyricsSearchResult === 'not_found'}
                          <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-rose-500/20 text-rose-300 border border-rose-500/35 tracking-wide">Не нашлось</span>
                        {/if}
                      </div>
                      <span class="text-white/40 text-[11px] leading-snug">
                        {#if isSearchingLyrics}
                          Ищу слова в каталогах...
                        {:else if lyricsSearchResult === 'found'}
                          Слова успешно синхронизированы
                        {:else if lyricsSearchResult === 'not_found'}
                          В базах пока нет слов для этого трека
                        {:else if $lyricsStatus === 'found'}
                          Обновить или поискать текст глубже
                        {:else}
                          Сбросить кеш и поискать текст заново
                        {/if}
                      </span>
                      <button
                        type="button"
                        class="w-full mt-0.5 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all select-none cursor-pointer {
                          lyricsSearchResult === 'found'
                            ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                            : lyricsSearchResult === 'not_found'
                            ? 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                            : 'bg-white/10 hover:bg-white/15 active:scale-95 text-white/90 border border-white/10 shadow-sm'
                        }"
                        disabled={isSearchingLyrics}
                        on:click={handleMbNaydetsa}
                      >
                        {#if isSearchingLyrics}
                          <Loader2 size={13} class="animate-spin text-white/80" />
                          <span>Ищу...</span>
                        {:else if lyricsSearchResult === 'found'}
                          <Sparkles size={13} class="text-emerald-300" />
                          <span>Нашлось!</span>
                        {:else}
                          <Search size={13} class="text-white/70" />
                          <span>мб найдеца</span>
                        {/if}
                      </button>
                    </div>

                    <!-- Смещение текста -->
                    <div
                      class="flex flex-col gap-2 p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08] transition-opacity"
                      class:opacity-35={!fullscreenLyricsSync}
                      aria-disabled={!fullscreenLyricsSync}
                    >
                      <div class="flex justify-between items-center text-xs">
                        <span class="text-white/75 font-medium">Смещение текста (мс)</span>
                        <div class="flex items-center gap-2">
                          <button
                            class="text-[11px] text-white/40 hover:text-white transition-colors disabled:cursor-not-allowed"
                            disabled={!fullscreenLyricsSync}
                            on:click={() => $settings.lyricsOffset = 0}
                          >сброс</button>
                          <span class="text-white tnum bg-white/10 px-1.5 py-0.5 rounded text-[11px]">
                            {fullscreenLyricsSync ? ($settings.lyricsOffset || 0) : '-'}
                          </span>
                        </div>
                      </div>
                      <input
                        type="range"
                        min="-5000" max="5000" step="50"
                        bind:value={$settings.lyricsOffset}
                        disabled={!fullscreenLyricsSync}
                        class="w-full accent-primary mt-0.5"
                      />
                    </div>
                  </div>

                {:else if activeModule === 'adlibs'}
                  <!-- Настройки Эдлибов -->
                  <div class="flex flex-col gap-3">
                    <div class="flex items-center justify-between p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08]">
                      <div class="flex flex-col">
                        <span class="text-white/90 text-xs font-medium">Выделять звуки в скобках</span>
                        <span class="text-white/40 text-[11px] leading-tight">Отдельный визуальный слой</span>
                      </div>
                      <button
                        type="button"
                        aria-label="Выделение эдлибов (damn)"
                        role="switch"
                        aria-checked={$settings.lyricsAdlibs !== false}
                        class="switch"
                        on:click={() => {
                          settings.update(s => ({ ...s, lyricsAdlibs: s.lyricsAdlibs === false }));
                          rebootCurrentTrack();
                        }}
                      >
                        <span class="switch-knob"></span>
                      </button>
                    </div>

                    {#if $settings.lyricsAdlibs !== false}
                      <div class="flex flex-col gap-2 p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08]">
                        <span class="text-white/75 text-xs font-medium">Положение слоя эдлибов</span>
                        <div class="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-white/[0.06] border border-white/[0.08]">
                          <button
                            type="button"
                            class="py-1.5 text-center rounded text-[11px] transition-colors {$settings.lyricsAdlibStyle !== 'backdrop' ? 'bg-white/15 text-white font-medium' : 'text-white/45 hover:text-white/80'}"
                            on:click={() => {
                              settings.update(s => ({ ...s, lyricsAdlibStyle: 'overlay' }));
                              rebootCurrentTrack();
                            }}
                          >
                            Над текстом
                          </button>
                          <button
                            type="button"
                            class="py-1.5 text-center rounded text-[11px] transition-colors {$settings.lyricsAdlibStyle === 'backdrop' ? 'bg-white/15 text-white font-medium' : 'text-white/45 hover:text-white/80'}"
                            on:click={() => {
                              settings.update(s => ({ ...s, lyricsAdlibStyle: 'backdrop' }));
                              rebootCurrentTrack();
                            }}
                          >
                            Под текстом
                          </button>
                        </div>
                      </div>
                    {/if}

                    <div class="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.05] text-[11px] text-white/40 leading-relaxed">
                      Короткие фоновые звуки отображаются под легким углом с динамическим разбросом, а длинные - по центру с плавным размытием при смене.
                    </div>
                  </div>

                {:else if activeModule === 'speed'}
                  <!-- Настройки Скорости трека -->
                  <div class="flex flex-col gap-3">
                    <div class="flex flex-col gap-2 p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08]">
                      <div class="flex justify-between items-center text-xs">
                        <span class="text-white/75 font-medium">Скорость воспроизведения</span>
                        <div class="flex items-center gap-2">
                          <button
                            class="text-[11px] text-white/40 hover:text-white transition-colors"
                            on:click={() => $settings.playbackRate = 1.0}
                          >сброс</button>
                          <span class="text-white tnum bg-white/10 px-2 py-0.5 rounded text-xs">
                            {($settings.playbackRate || 1.0).toFixed(2)}x
                          </span>
                        </div>
                      </div>
                      <input
                        type="range"
                        min="0.5" max="2.0" step="0.05"
                        bind:value={$settings.playbackRate}
                        class="w-full accent-primary mt-1"
                      />
                      <div class="grid grid-cols-4 gap-1 pt-1.5">
                        <button
                          type="button"
                          class="py-1 text-center rounded text-[11px] transition-colors {Math.abs(($settings.playbackRate || 1.0) - 0.75) < 0.04 ? 'bg-white/20 text-white font-medium' : 'text-white/40 hover:text-white/70 bg-white/5'}"
                          on:click={() => $settings.playbackRate = 0.75}
                        >
                          0.75x
                        </button>
                        <button
                          type="button"
                          class="py-1 text-center rounded text-[11px] transition-colors {Math.abs(($settings.playbackRate || 1.0) - 1.0) < 0.04 ? 'bg-white/20 text-white font-medium' : 'text-white/40 hover:text-white/70 bg-white/5'}"
                          on:click={() => $settings.playbackRate = 1.0}
                        >
                          1.00x
                        </button>
                        <button
                          type="button"
                          class="py-1 text-center rounded text-[11px] transition-colors {Math.abs(($settings.playbackRate || 1.0) - 1.25) < 0.04 ? 'bg-white/20 text-white font-medium' : 'text-white/40 hover:text-white/70 bg-white/5'}"
                          on:click={() => $settings.playbackRate = 1.25}
                        >
                          1.25x
                        </button>
                        <button
                          type="button"
                          class="py-1 text-center rounded text-[11px] transition-colors {Math.abs(($settings.playbackRate || 1.0) - 1.5) < 0.04 ? 'bg-white/20 text-white font-medium' : 'text-white/40 hover:text-white/70 bg-white/5'}"
                          on:click={() => $settings.playbackRate = 1.5}
                        >
                          1.50x
                        </button>
                      </div>
                    </div>
                  </div>

                {:else if activeModule === 'layout'}
                  <!-- Настройки Раскладки -->
                  <div class="flex flex-col gap-3">
                    <div class="flex flex-col gap-2 p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.08]">
                      <span class="text-white/75 text-xs font-medium">Режим отображения</span>
                      <div
                        class="seg-control mt-1"
                        style="--seg-count: 2; --seg-index: {immersive ? 1 : 0}"
                        role="radiogroup"
                        aria-label="Раскладка полноэкранного режима"
                      >
                        <span class="seg-pill" aria-hidden="true"></span>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={!immersive}
                          class="seg-item"
                          class:is-active={!immersive}
                          on:click={() => settings.update(s => ({ ...s, fullscreenStyle: 'panel' }))}
                        >
                          Панель
                        </button>
                        <button
                          type="button"
                          role="radio"
                          aria-checked={immersive}
                          class="seg-item"
                          class:is-active={immersive}
                          on:click={() => settings.update(s => ({ ...s, fullscreenStyle: 'immersive' }))}
                        >
                          Погружение
                        </button>
                      </div>
                    </div>

                    <div class="p-2.5 rounded-xl bg-white/[0.02] border border-white/[0.05] text-[11px] text-white/45 leading-relaxed">
                      {#if immersive}
                        <strong>Погружение:</strong> обложка уезжает вверх при включении текста, а слова отображаются крупным кеглем почти во всю ширину экрана.
                      {:else}
                        <strong>Панель:</strong> обложка остается слева на постоянном месте, а текст аккуратно отображается в полупрозрачной стеклянной панели справа.
                      {/if}
                    </div>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <span class="fs-top-actions-divider" aria-hidden="true"></span>

      <button
        type="button"
        class="fs-top-action fs-top-action-exit"
        on:click={exitOverlay}
        aria-label="Выйти из полноэкранного режима"
        data-label="Свернуть экран"
      >
        <Minimize2 size={21} strokeWidth={1.8} />
      </button>
    </div>

    <!-- Геометрия сцены переехала из инлайновых стилей и утилит в классы `.fs-*` (app.css):
         одна разметка обслуживает обе раскладки, а разница между ними — набор правил под
         `.is-immersive`, а не второе дерево элементов. Состояние помечено классами на самой
         сцене, потому что анимируемым свойствам место в CSS: иначе каждое переключение
         перезаписывало бы атрибут `style` у четырёх узлов сразу. -->
    <div class="fs-stage" class:is-lyrics={showLyrics} class:is-immersive={immersive}>

      <!-- Обложка с подписью. В «Погружении» с включённым текстом уезжает вверх за край. -->
      <div class="fs-cover-side">
        <div class="fs-cover group">
          <img src={currentDisplayCover} alt="Cover" class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />

          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div class="fs-cover-hover" class:is-idle={noLyrics} on:click={toggleLyrics}>
            <div class="fs-cover-hover-inner">
              {#if showLyrics}
                <AlignCenter size={42} strokeWidth={1.5} />
                <span>Скрыть текст</span>
              {:else if noLyrics}
                <!-- Наведение — единственный момент, когда человек ещё ничего не потерял:
                     сказать про отсутствие текста надо здесь, а не пустой панелью после. -->
                <Ghost size={42} strokeWidth={1.5} />
                <span>Текста нет: только музыка</span>
              {:else}
                <AlignLeft size={42} strokeWidth={1.5} />
                <span>{$lyricsStatus === 'loading' ? 'Ищу текст…' : 'Показать текст'}</span>
              {/if}
            </div>
          </div>
        </div>

        <!-- Бокс обложки постоянного размера, поэтому при сжатии под ней остаётся ровно 5vh
             пустоты (половина от 55vh × 0.182). Подпись догоняет обложку тем же `transform` —
             компенсация точная и, в отличие от анимации `margin`, ничего не пересчитывает. -->
        <div class="fs-meta">
          <!-- Размеры, кегль и обрезка — в `.fs-title`/`.fs-artist` (app.css): именно там
               живёт починка подрезанных снизу букв, которую утилитарный `text-5xl`
               (line-height: 1) вызывал в паре с `truncate`.
               `is-compact` — уступка панельной раскладке, где заголовок делится шириной с
               панелью текста. В «Погружении» он вместе с обложкой улетает за экран, и
               анимировать ему на прощание `font-size` (а это пересчёт раскладки на каждом
               кадре) незачем. -->
          <div class="fs-title-viewport" use:panOverflow title={$currentTrack.title}>
            <h2 class="fs-title" class:is-compact={showLyrics && !immersive}>{displayedTitle.main}</h2>
          </div>
          {#if displayedTitle.detail}
            <div class="fs-title-viewport fs-title-detail-viewport" use:panOverflow title={displayedTitle.detail}>
              <div class="fs-title-detail" class:is-compact={showLyrics && !immersive}>{displayedTitle.detail}</div>
            </div>
          {/if}
          <div class="fs-artist" class:is-compact={showLyrics && !immersive}>
            <ArtistTag artist={$currentTrack.artist} artists={$currentTrack.artists} />
          </div>
        </div>
      </div>

      <!-- Текст. Стекло панели навешивается классом, а не отключается переопределениями:
           в «Погружении» текст лежит прямо на обложке-фоне — панели там нет вовсе. -->
      <div class="fs-lyrics-side" class:glass-panel={!immersive}>
        <div class="w-full h-full">
          {#if showLyrics}
            <div transition:fade={{ duration: 400 }} class="w-full h-full">
              <Lyrics letterSync={fullscreenLyricsSync} />
            </div>
          {/if}
        </div>
      </div>
    </div>
  {:else}
    <div class="z-10 flex flex-col items-center gap-1.5">
      <div class="display-title">Тишина</div>
      <div class="empty-hint !mt-0 text-center">Включите трек, и здесь появится обложка.</div>
    </div>
  {/if}
</div>
