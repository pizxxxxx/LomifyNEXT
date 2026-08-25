<script lang="ts">
  import { currentTrack, currentView, previousView, settings, lyricsStatus } from '$lib/stores';
  import { Minimize2, AlignLeft, AlignCenter, Settings2, Ghost } from 'lucide-svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import Lyrics from './Lyrics.svelte';
  import ArtistTag from './ArtistTag.svelte';
  import { FFT_BINS, readFftInto } from '$lib/fft';

  let canvas: HTMLCanvasElement;
  let unlistenFft: UnlistenFn;
  /** Буфер полос: один на весь режим, чтобы не выделять массив тридцать раз в секунду. */
  const bins = new Float32Array(FFT_BINS);
  let vizGrad: CanvasGradient | null = null;
  let vizGradKey = '';

  let showLyrics = $settings.showLyricsByDefault ?? true;
  let showSettings = false;

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
  $: fullscreenLyricsSync = $settings.fullscreenLyricsSync !== false;

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
      ? 'Текста нет — только музыка'
      : $lyricsStatus === 'loading'
        ? 'Ищу текст…'
        : 'Показать текст';

  /** Переключить текст, если его есть что показывать. */
  function toggleLyrics() {
    if (noLyrics) return;
    showLyrics = !showLyrics;
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
        const barWidth = (width / barCount);
        // Небольшая рамка по краям и тонкие щели между полосами, чтобы они не сливались
        // в сплошную белую полосу: визуализатор — фон, а не «огни сцены».
        const gx = width * 0.015;
        const gw = Math.max(24, width * 0.97);
        const barW = Math.max(3, (gw / barCount) * 0.68);

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
          // Полосы приходят долями единицы, а не байтами (см. lib/fft.ts). Здесь стояло
          // деление на 255 — то есть высота каждого столбика выходила меньше пикселя, и
          // визуализация в полном экране была ровным пустым местом всё это время.
          const v = bins[i];
          // Слегка степенная кривая: удары выстреливают, тихий фон оседает.
          const intensity = Math.pow(v, 1.4);
          const barHeight = intensity * height * 0.34;

          const x = gx + i * barWidth;
          const rad = Math.min(barW * 0.5, 10);

          ctx.beginPath();
          ctx.roundRect(x, height - barHeight, barW, barHeight, [rad, rad, 2, 2]);
          ctx.fill();
        }
      });
    }
  });

  onDestroy(() => {
    if (unlistenFft) unlistenFft();
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
    <div class="absolute inset-0 z-0 pointer-events-none overflow-hidden">
      <img src={$currentTrack.coverUrl} alt="bg" class="w-full h-full object-cover blur-[100px] scale-150 opacity-40 transition-transform duration-1000" />
      <div class="absolute inset-0 bg-gradient-to-b from-black/20 via-black/40 to-[var(--color-dark)]"></div>
      {#if visualizerOn}
        <canvas bind:this={canvas} class="absolute inset-0 w-full h-full opacity-60"></canvas>
      {/if}
    </div>
    
    <div class="absolute top-8 right-8 z-50 flex gap-4">
      {#if immersive}
        <!-- В иммерсивной раскладке обложка с включённым текстом уходит за экран — вместе с
             ней уезжает и наведение на неё, которым текст переключали. Без этой кнопки
             состояние было бы необратимым, поэтому здесь она обязательна, а не украшение.
             В панельной раскладке её нет намеренно: там обложка на месте и всё уже работает. -->
        <button
          class="w-12 h-12 bg-white/10 rounded-full flex items-center justify-center backdrop-blur-md transition-colors {showLyrics ? 'text-primary hover:bg-white/20' : noLyrics ? 'text-white/40 cursor-not-allowed' : 'text-white hover:bg-white/20'}"
          on:click={toggleLyrics}
          disabled={noLyrics}
          aria-pressed={showLyrics}
          aria-label={lyricsHint}
          title={lyricsHint}
        >
          {#if showLyrics}
            <AlignCenter size={24} />
          {:else if noLyrics}
            <Ghost size={24} />
          {:else}
            <AlignLeft size={24} />
          {/if}
        </button>
      {/if}

      <div class="relative">
        <button 
          class="w-12 h-12 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center backdrop-blur-md transition-colors {showSettings ? 'bg-white/20 text-primary' : 'text-white'}"
          on:click={() => showSettings = !showSettings}
          aria-label="Settings"
        >
          <Settings2 size={24} />
        </button>
        
        {#if showSettings}
          <div transition:popFade class="absolute top-14 right-0 w-64 bg-black/40 backdrop-blur-xl border border-white/10 rounded-2xl p-5 shadow-2xl flex flex-col gap-6 origin-top-right">
            <!-- Раскладка экрана. Стоит первой: она меняет всё остальное, что здесь есть. -->
            <div class="flex flex-col gap-2">
              <div class="flex flex-col">
                <span class="text-white/70 font-medium text-sm">Раскладка</span>
                <span class="text-white/35 text-[11px] leading-snug mt-0.5">
                  {immersive ? 'Обложка уезжает вверх, текст — крупно во всю ширину' : 'Обложка слева, текст в панели справа'}
                </span>
              </div>
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

            <!-- Переключатель спектра стоит здесь, а не в общих настройках: он относится
                 только к этому экрану, и включают его, глядя ровно на то, что он меняет. -->
            <div class="flex items-center justify-between gap-3">
              <div class="flex flex-col">
                <span class="text-white/70 font-medium text-sm">Визуализатор</span>
                <span class="text-white/35 text-[11px] leading-snug mt-0.5">Полосы спектра внизу экрана</span>
              </div>
              <button
                aria-label="Визуализатор"
                role="switch"
                aria-checked={visualizerOn}
                class="switch shrink-0"
                on:click={() => settings.update(s => ({ ...s, fullscreenVisualizer: !visualizerOn }))}
              >
                <span class="switch-knob"></span>
              </button>
            </div>

            <div class="flex items-center justify-between gap-3">
              <div class="flex min-w-0 flex-col">
                <span class="text-white/70 font-medium text-sm">Синхронизация текста</span>
                <span class="text-white/35 text-[11px] leading-snug mt-0.5">
                  {fullscreenLyricsSync ? 'Караоке-подсветка по буквам' : 'Активная строка следует за музыкой'}
                </span>
              </div>
              <button
                aria-label="Подсветка текста по буквам"
                role="switch"
                aria-checked={fullscreenLyricsSync}
                class="switch shrink-0"
                on:click={() => settings.update(s => ({ ...s, fullscreenLyricsSync: !fullscreenLyricsSync }))}
              >
                <span class="switch-knob"></span>
              </button>
            </div>

            <div
              class="flex flex-col gap-2 transition-opacity"
              class:opacity-35={!fullscreenLyricsSync}
              aria-disabled={!fullscreenLyricsSync}
            >
              <div class="flex justify-between items-center text-sm">
                <span class="text-white/70 font-medium">Смещение текста (мс)</span>
                <div class="flex items-center gap-2">
                  <button
                    class="text-xs text-white/40 hover:text-white transition-colors disabled:cursor-not-allowed"
                    disabled={!fullscreenLyricsSync}
                    on:click={() => $settings.lyricsOffset = 0}
                  >сброс</button>
                  <span class="text-white tnum bg-white/10 px-2 py-0.5 rounded">
                    {fullscreenLyricsSync ? ($settings.lyricsOffset || 0) : '—'}
                  </span>
                </div>
              </div>
              <input
                type="range" 
                min="-5000" max="5000" step="50" 
                bind:value={$settings.lyricsOffset} 
                disabled={!fullscreenLyricsSync}
                class="w-full accent-primary"
              />
            </div>
          
            <div class="flex flex-col gap-2">
              <div class="flex justify-between items-center text-sm">
                <span class="text-white/70 font-medium">Скорость трека</span>
                <div class="flex items-center gap-2">
                  <button class="text-xs text-white/40 hover:text-white transition-colors" on:click={() => $settings.playbackRate = 1.0}>сброс</button>
                  <span class="text-white tnum bg-white/10 px-2 py-0.5 rounded">{($settings.playbackRate || 1.0).toFixed(2)}x</span>
                </div>
              </div>
              <input 
                type="range" 
                min="0.5" max="2.0" step="0.05" 
                bind:value={$settings.playbackRate} 
                class="w-full accent-primary"
              />
              <div class="w-full relative text-[10px] text-white/40 tnum px-1 h-4 mt-1">
                <span class="absolute left-0">0.5x</span>
                <span class="absolute left-1/3 -translate-x-1/2">1.0x</span>
                <span class="absolute right-0">2.0x</span>
              </div>
            </div>
          </div>
        {/if}
      </div>

      <button
        class="w-12 h-12 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center backdrop-blur-md transition-colors"
        on:click={exitOverlay}
        aria-label="Exit Fullscreen"
      >
        <Minimize2 size={24} />
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
          <img src={$currentTrack.coverUrl} alt="Cover" class="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105" />

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
                <span>Текста нет — только музыка</span>
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
          <h2 class="fs-title" class:is-compact={showLyrics && !immersive}>{$currentTrack.title}</h2>
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
      <div class="empty-hint !mt-0 text-center">Поставь что-нибудь — и здесь появится обложка.</div>
    </div>
  {/if}
</div>
