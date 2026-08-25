<script lang="ts">
  import { settings, playlists, listenStats, notify, currentTrack, isPlaying } from '$lib/stores';
  import { Download, Loader2, Check, Music, Volume2, RefreshCw } from 'lucide-svelte';
  import { enable, isEnabled, disable } from '@tauri-apps/plugin-autostart';
  import { appDataDir, appLocalDataDir } from '@tauri-apps/api/path';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { onMount } from 'svelte';
  import { withCount } from '$lib/utils/plural';
  import { APP_NAME, APP_VERSION, APP_CHANNEL } from '$lib/version';
  import { listOutputs, applyOutput, type AudioOutput } from '$lib/audioOutput';
  let autostartEnabled = false;
  let dataPath = '';
  let localDataPath = '';

  async function handleGibberishToggle() {
    $settings.gibberishMode = !$settings.gibberishMode;
    if ($settings.gibberishMode) {
      try {
        const { getSoundCloudClientId, safeFetch, findBestTranscoding } = await import('$lib/api');
        const clientId = await getSoundCloudClientId();
        const url = "https://soundcloud.com/denismellstroy/tyomnyy-prints-madk1d-ty-che-obkukurikalas-prod-by-k4neswagga-yngyuuuchi";
        const res = await safeFetch(`https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${clientId}`);
        const t = await res.json();
        if (t && t.id) {
           const cover = t.artwork_url ? t.artwork_url.replace('large', 't500x500') : '';
           const track = {
             id: t.id,
             title: t.title,
             artist: t.user?.username || 'Unknown',
             coverUrl: cover,
             audioUrl: findBestTranscoding(t),
             source: 'soundcloud',
             duration: t.duration || 0,
             permalinkUrl: t.permalink_url || url,
             transcodings: t.media?.transcodings?.map((tr: any) => `${tr.url}?client_id=${clientId}`) || []
           };
           currentTrack.set(track as any);
           isPlaying.set(true);
        }
      } catch (e) {
        console.error("Gibberish track load failed", e);
      }
    }
  }

  onMount(() => {
    if ($settings.uiStyle === 'style3') {
      $settings.uiStyle = 'style1';
    }
    (async () => {
      try {
        if (window && '__TAURI_INTERNALS__' in window) {
          autostartEnabled = await isEnabled();
          dataPath = await appDataDir();
          localDataPath = await appLocalDataDir();
        }
      } catch(e) {
        console.error("Failed to load settings data", e);
      }
    })();
    // Список устройств перечитывается на каждом открытии вкладки (компонент здесь
    // создаётся заново, см. +page.svelte), поэтому воткнутые наушники видно без кнопки.
    refreshOutputs();
  });

  // ── Устройство вывода ────────────────────────────────────────────────────────
  let outputs: AudioOutput[] = [];
  let outputsLoading = false;
  // `name` устройства, которое сейчас открывается, или '' для «системного». Открытие
  // Bluetooth-приёмника занимает секунды, и всё это время нужно показывать, что выбор
  // принят и идёт, — иначе по списку начинают щёлкать повторно.
  let outputSwitching: string | null = null;

  // Сохранённое устройство, которого нет в списке: колонку выключили или переставили в
  // другой разъём. Отдельная строка нужна, чтобы выбор не выглядел потерянным — вывод
  // сейчас идёт через системное, но настройка жива и вернётся вместе с устройством.
  $: missingOutput =
    $settings.outputDevice && !outputs.some(o => o.name === $settings.outputDevice)
      ? ($settings.outputDeviceLabel || $settings.outputDevice)
      : null;

  async function refreshOutputs() {
    outputsLoading = true;
    try {
      outputs = await listOutputs();
    } catch (e) {
      console.error('[audio] list devices failed', e);
      notify('Не смог получить список устройств', 'error');
    }
    outputsLoading = false;
  }

  /** `device === null` — вернуться на системное устройство по умолчанию. */
  async function chooseOutput(device: AudioOutput | null) {
    const name = device?.name ?? null;
    if (outputSwitching !== null) return;
    if (name === $settings.outputDevice) return;

    outputSwitching = name ?? '';
    try {
      await applyOutput(name);
      // Пишем настройку только после успешного открытия: сохранённое устройство
      // применяется на каждом запуске, и записать то, что не открылось, значит повторять
      // одну и ту же ошибку при каждом старте.
      $settings.outputDevice = name;
      $settings.outputDeviceLabel = device?.description ?? '';
      notify(
        device ? `Играю через «${device.description}»` : 'Играю через системное устройство',
        'success'
      );
    } catch (e: any) {
      // Тишины не будет: выходной поток в device.rs при неудаче откатывается на
      // устройство по умолчанию, а ошибка доезжает сюда уже после этого.
      notify(
        device
          ? `Не смог открыть «${device.description}» — звук идёт через системное`
          : 'Не смог переключиться на системное устройство',
        'error'
      );
      console.error('[audio] switch device failed', e);
      refreshOutputs();
    }
    outputSwitching = null;
  }

  async function toggleAutostart() {
    try {
      if (autostartEnabled) {
        await disable();
        autostartEnabled = false;
      } else {
        await enable();
        autostartEnabled = true;
      }
    } catch(e) {
      notify('Не смог настроить автозапуск', 'error');
    }
  }

  let scInputUrl = '';
  let scLoading = false;
  async function linkSoundCloud() {
    if (!scInputUrl) return;
    scLoading = true;
    try {
      const { resolveSoundCloudProfile, getUserPlaylists } = await import('$lib/api');
      let url = scInputUrl;
      if (!url.startsWith('http')) url = 'https://soundcloud.com/' + url;
      const user = await resolveSoundCloudProfile(url);
      if (!user) {
        notify('Такого профиля нет — проверь ссылку', 'error');
        scLoading = false;
        return;
      }

      $settings.scUser = user;
      notify('Профиль на месте', 'success');

      const userPlaylists = await getUserPlaylists(user.id);
      if (userPlaylists.length > 0) {
        playlists.update(p => {
          const fresh = userPlaylists.filter((up: any) => !p.some((existing: any) => existing.id === up.id));
          return [...fresh, ...p];
        });
        notify(`Перенёс ${withCount(userPlaylists.length, 'плейлист', 'плейлиста', 'плейлистов')}`, 'success');
      }

      // Лайки тянет сверка, а не отдельный проход по списку. Она делает то же самое (берёт
      // из профиля то, чего здесь нет), но заодно заводит снимок, по которому дальше видно
      // снятые лайки — без него первое зеркалирование ничего бы не удаляло, и расхождение
      // жило бы до второго запуска. Об итоге сверка сообщает сама.
      const { syncLikes } = await import('$lib/likes');
      await syncLikes({ only: 'soundcloud' });
    } catch (e) {
      notify('Не получилось привязать профиль', 'error');
    }
    scLoading = false;
  }

  /** Свести лайки с профилем SoundCloud по кнопке. Разбор зеркала — в `$lib/likes`. */
  async function refreshSCLikes() {
    if (!$settings.scUser) return;
    scLoading = true;
    try {
      const { syncLikes } = await import('$lib/likes');
      // Итог показывает сама сверка: она одна знает, сколько пришло и сколько ушло, и
      // отличает «списки сходятся» от «источник ответил не целиком».
      await syncLikes({ only: 'soundcloud' });
    } catch (e) {
      notify('Не смог обновить лайки', 'error');
    }
    scLoading = false;
  }

  /**
   * Переключатель эффекта движения. Один на все четыре, а не четыре обработчика подряд:
   * тумблеры отличаются только именем настройки.
   *
   * Сравнение с `false`, а не `!value`, — из-за уже сохранённых настроек: у тех, кто
   * поставил приложение до этой версии, полей в localStorage нет, и `undefined` должен
   * читаться как «включено» (эффекты работали и раньше). `!undefined` дало бы обратное —
   * первое нажатие ничего бы не изменило, потому что тумблер уже показан включённым.
   */
  function toggleFx(key: 'coverTilt' | 'coverGlare' | 'cardSheen' | 'panelPress') {
    $settings[key] = $settings[key] === false;
  }

  function toggleAutoCache() {
    $settings.autoCache = !$settings.autoCache;
  }

  function setSource(source: 'soundcloud' | 'yandex') {
    // Переключиться на Яндекс без токена — это выбрать источник, который сразу же ничего
    // не найдёт. Поэтому не даём молча уйти в нерабочее состояние, а показываем, чего не
    // хватает: плашка привязки стоит ниже в этой же вкладке.
    if (source === 'yandex' && !$settings.yandexToken) {
      notify('Сначала привяжи Яндекс Музыку — плашка ниже', 'info');
      return;
    }
    $settings.searchSource = source;
  }

  let ymInputToken = '';
  let ymLoading = false;

  async function linkYandex() {
    const raw = ymInputToken.trim();
    if (!raw) return;
    ymLoading = true;
    try {
      const { normalizeYandexToken, yandexAccountStatus, yandexAvatarUrl } = await import('$lib/yandex');
      // Проверка запросом, а не регуляркой: единственный способ узнать, что токен живой —
      // спросить у API, кто по нему вошёл. Заодно получаем uid для импорта лайков.
      const account = await yandexAccountStatus(raw);
      // Аватар отдаёт Паспорт, а не Музыка, и права на него у музыкального токена может не
      // быть — поэтому отдельным запросом, который не умеет бросать (вернёт пустую строку).
      const avatarUrl = await yandexAvatarUrl(raw);
      $settings.yandexToken = normalizeYandexToken(raw);
      $settings.yandexUser = { ...account, avatarUrl };
      $settings.searchSource = 'yandex';
      ymInputToken = '';
      notify(`Яндекс Музыка на месте — ${account.displayName}`, 'success');
      // Лайки забираем сразу: привязка ради них и делается, а ждать перезапуска ради первой
      // сверки — ровно та ручная работа, от которой мы уходим. Отдельным `catch`, чтобы
      // отказ сверки не превратился в жалобу на токен: токен уже приняли строкой выше.
      try {
        const { syncLikes } = await import('$lib/likes');
        await syncLikes({ only: 'yandex' });
      } catch (e) {
        console.warn('[likes] первая сверка после привязки не прошла', e);
      }
    } catch (e: any) {
      // Текст берём как есть, без приставки «Токен не принят»: она была здесь всегда и
      // подменяла собой причину. Причина не обязана быть в токене — это может быть и
      // неопознанный клиент, и лимит запросов, и запуск в браузере. Формулировку под каждый
      // случай даёт `describeYmError` в yandex.ts, дублировать её догадкой не нужно.
      notify(e?.message || 'Не удалось связаться с Яндекс Музыкой', 'error');
    }
    ymLoading = false;
  }

  function unlinkYandex() {
    $settings.yandexToken = '';
    $settings.yandexUser = null;
    // Оставлять выбранным источник, доступа к которому больше нет, нельзя — поиск бы
    // молча падал в SoundCloud, и было бы непонятно, почему.
    if ($settings.searchSource === 'yandex') $settings.searchSource = 'soundcloud';
    notify('Яндекс Музыка отвязана', 'info');
  }

  /**
   * Свести лайки с аккаунтом Яндекса по кнопке.
   *
   * Раньше это был односторонний импорт: он умел только добавлять сюда то, чего здесь нет.
   * Теперь то же действие ведёт зеркало — отправляет в аккаунт отметки, поставленные здесь,
   * забирает поставленные в вебе и убирает снятые там (разбор в `$lib/likes`). Кнопка
   * осталась потому, что автоматическая сверка идёт при запуске, а лайк в вебе могли
   * поставить, пока приложение открыто.
   */
  async function syncYandexLikes() {
    if (!$settings.yandexToken) return;
    ymLoading = true;
    try {
      const { syncLikes } = await import('$lib/likes');
      await syncLikes({ only: 'yandex' });
    } catch (e: any) {
      notify(e?.message ? `Лайки не пришли: ${e.message}` : 'Лайки не пришли', 'error');
    }
    ymLoading = false;
  }

  function setLyricsAlignment(align: 'left' | 'right' | 'fullscreen') {
    $settings.lyricsAlignment = align;
  }
  
  function setTheme(theme: string) {
    $settings.theme = theme;
  }
  
  const themes = [
    { id: 'default', name: 'Pure', color: '#1DB954' },
    { id: 'toxic-sludge', name: 'Lime', color: '#bada55' },
    { id: 'dragon-sc', name: 'SC Prime', color: '#ff5500' },
    { id: 'n1xoy', name: 'n1xoy', color: '#B00000' },
    { id: 'night-city', name: 'Lemon', color: '#fce205' },
    { id: 'vice-city', name: 'Magenta', color: '#ff2a85' },
    { id: 'abyss-water', name: 'Cyan', color: '#00d2ff' },
    { id: 'purple-haze', name: 'Violet', color: '#9b59b6' },
    { id: 'martian-dust', name: 'Brick', color: '#ff7e5f' },
    { id: 'blood-moon', name: 'Wine', color: '#8a0303' },
    { id: 'electric-indigo', name: 'Space', color: '#6600ff' },
    { id: 'dracula', name: 'Dracula', color: '#bd93f9' }
  ];

  function clearLyricsCache() {
    if (confirm('Очистить кэш текстов песен?')) {
      localStorage.removeItem('lomifynext_lyrics_cache');
    }
  }

  function resetProfileStats() {
    if (confirm('Обнулить часы прослушивания и историю? Треки и лайки останутся.')) {
      listenStats.set({ listenSeconds: 0, tracksPlayed: 0, history: {} });
      notify('Профиль сброшен', 'success');
    }
  }

  function resetAllData() {
    if (confirm('Снести всё: настройки, историю, лайки, плейлисты. Вернуть не получится. Точно?')) {
      localStorage.clear();
      window.location.reload();
    }
  }
</script>

<div class="max-w-3xl mx-auto py-8 perspective-[1000px]">
  <h2 class="page-title mb-8">Настройки</h2>

  <!-- Страница была плоским столбцом из полутора десятков плашек в порядке, в котором их
       когда-то добавляли: автозапуск, системные пути, привязка SoundCloud, привязка Яндекса,
       офлайн-режим, Discord, easter egg, источник аудио, тема… Родственные настройки стояли
       на разных концах списка — «Тема оформления», «Глобальный дизайн» и «Стиль интерфейса»
       разделяли Discord и системные пути, — поэтому найти нужное можно было только
       прокруткой сверху донизу.

       Теперь порядок отвечает на вопрос «за чем я сюда пришёл»: сначала то, что видно
       постоянно (внешний вид), потом движение, потом музыка и её источники, потом текст
       песен, потом системные вещи, которые открывают раз в жизни, и в самом конце
       необратимое. Заголовок группы стоит НАД плашками, а не оборачивает их рамкой:
       ещё один уровень вложенных рамок сделал бы страницу тяжелее, а не понятнее.

       Разметка групп — `<section>` с внутренним `space-y-6`, а не общий `space-y-*` на всю
       страницу: у Tailwind `space-y` вешает отступ на всех соседей кроме первого селектором
       с тремя классами, и заголовку группы пришлось бы перебивать его через `!mt-*`. С
       вложенностью каждый отступ задан там, где он нужен, и ничего перебивать не надо. -->
  <div class="space-y-12">

    <!-- ── Внешний вид ─────────────────────────────────────────────────────── -->
    <section>
      <div class="settings-group">
        <span class="settings-group-title">Внешний вид</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="space-y-6">

        <!-- Global design -->
        <div class="plate p-8">
          <h3 class="section-title">Глобальный дизайн</h3>
          <p class="empty-hint !mt-1.5 !max-w-[54ch] mb-6">
            Полностью меняет облик приложения: материалы панелей, типографику, карточки и текст песни.
            Цвет темы и плотность стекла настраиваются отдельно и продолжают работать в обоих дизайнах.
          </p>
          <div class="grid grid-cols-2 gap-3">
            <!-- Не просто две кнопки, а два превью: разницу между дизайнами видно до
                 переключения, поэтому каждый вариант рисует сам себя в миниатюре. -->
            <button
              class="design-card {$settings.design !== 'aurora' ? 'is-active' : ''}"
              on:click={() => $settings.design = 'classic'}
            >
              <span class="design-card-preview design-preview-classic">
                <span class="design-preview-bar"></span>
                <span class="design-preview-bar is-short"></span>
                <span class="design-preview-tile"></span>
              </span>
              <span class="design-card-name">Классический</span>
              <span class="design-card-hint">Мягкое стекло, спокойная типографика</span>
            </button>
            <button
              class="design-card {$settings.design === 'aurora' ? 'is-active' : ''}"
              on:click={() => $settings.design = 'aurora'}
            >
              <span class="design-card-preview design-preview-aurora">
                <span class="design-preview-bar"></span>
                <span class="design-preview-bar is-short"></span>
                <span class="design-preview-tile"></span>
              </span>
              <span class="design-card-name">Aurora</span>
              <span class="design-card-hint">Контраст, акцентные кромки, плотный набор</span>
            </button>
          </div>
        </div>

        <!-- Interface Blur & Theme Depth -->
        <div class="plate p-8">
          <h3 class="section-title">Стиль интерфейса</h3>
          <p class="empty-hint !mt-1.5 !max-w-[54ch] mb-6">Плотность панелей и то, насколько цвет темы проникает в фон.</p>
          <div class="flex gap-3 mb-5">
            <button
              class="flex-1 py-3.5 rounded-2xl text-[14px] font-medium transition-[transform,background-color,color] interactive-item { $settings.uiStyle === 'style1' ? 'bg-primary text-black shadow-[0_0_25px_color-mix(in_srgb,var(--color-primary)_60%,transparent)]' : 'glass-button' }"
              on:click={() => $settings.uiStyle = 'style1'}
            >
              Светлее
            </button>
            <button
              class="flex-1 py-3.5 rounded-2xl text-[14px] font-medium transition-[transform,background-color,color] interactive-item { $settings.uiStyle === 'style2' ? 'bg-primary text-black shadow-[0_0_25px_color-mix(in_srgb,var(--color-primary)_60%,transparent)]' : 'glass-button' }"
              on:click={() => $settings.uiStyle = 'style2'}
            >
              Темнее
            </button>
          </div>

          <div class="setting-row">
            <div>
              <div class="setting-title">Глубина темы</div>
              <div class="setting-hint">Цвет темы аккуратно подмешивается в фон приложения.</div>
            </div>
            <button
              aria-label="Глубина темы"
              role="switch"
              aria-checked={$settings.globalThemeEffect}
              class="switch"
              on:click={() => $settings.globalThemeEffect = !$settings.globalThemeEffect}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <div class="setting-row mt-3">
            <div class="flex-1 min-w-0">
              <div class="setting-title">Стиль волны</div>
              <div class="setting-hint">
                Как «Моя волна» на главной реагирует на музыку: сглаженное дыхание или живой ритм.
              </div>
            </div>
            <div
              class="seg-control"
              style="--seg-count: 2; --seg-index: {$settings.waveStyle === 'pulse' ? 1 : 0}"
              role="radiogroup"
              aria-label="Стиль волны"
            >
              <span class="seg-pill" aria-hidden="true"></span>
              <button
                type="button"
                role="radio"
                aria-checked={$settings.waveStyle !== 'pulse'}
                class="seg-item"
                class:is-active={$settings.waveStyle !== 'pulse'}
                on:click={() => $settings.waveStyle = 'smooth'}
              >
                Плавная
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={$settings.waveStyle === 'pulse'}
                class="seg-item"
                class:is-active={$settings.waveStyle === 'pulse'}
                on:click={() => $settings.waveStyle = 'pulse'}
              >
                Ритмичная
              </button>
            </div>
          </div>

          <div class="setting-row mt-3">
            <div>
              <div class="setting-title">Режим производительности</div>
              <div class="setting-hint">
                Снимает всё дорогое сразу: живое размытие под панелями, атмосферную подложку,
                блик под курсором, наклон обложки, световую полосу и объём нажатия. Помогает
                на ноутбуках и слабых видеокартах. Выключателями эффектов ниже не управляет —
                ваш выбор там сохраняется и вернётся, когда режим выключите.
              </div>
            </div>
            <button
              aria-label="Режим производительности"
              role="switch"
              aria-checked={$settings.perfMode}
              class="switch"
              on:click={() => $settings.perfMode = !$settings.perfMode}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <div class="setting-row mt-3">
            <div>
              <div class="setting-title">Треки слева</div>
              <div class="setting-hint">Списки треков прижимаются к левому краю. Остальной интерфейс не двигается.</div>
            </div>
            <button
              aria-label="Левосторонний список треков"
              role="switch"
              aria-checked={$settings.leftAlignTracks}
              class="switch"
              on:click={() => $settings.leftAlignTracks = !$settings.leftAlignTracks}
            >
              <span class="switch-knob"></span>
            </button>
          </div>
        </div>

        <!-- Theme Selection -->
        <div class="plate p-8">
          <h3 class="section-title">Тема оформления</h3>
          <p class="empty-hint !mt-1.5 !max-w-[54ch] mb-6">Акцентный цвет всего интерфейса — подписи, активные элементы, свечение.</p>

          <!-- The adaptive accent used to live in another plate entirely, which made the
               palette below look broken for no visible reason once it was on. It *replaces*
               the palette, so it belongs right above it. -->
          <div class="setting-row mb-5">
            <div>
              <div class="setting-title">Адаптивная тема</div>
              <div class="setting-hint">Акцент берётся с обложки текущего трека. Палитра ниже при этом не используется.</div>
            </div>
            <button
              aria-label="Адаптивная тема"
              role="switch"
              aria-checked={$settings.accentFromCover}
              class="switch"
              on:click={() => $settings.accentFromCover = !$settings.accentFromCover}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <div
            class="grid grid-cols-2 md:grid-cols-3 gap-3 transition-opacity duration-300 {$settings.accentFromCover ? 'opacity-35 pointer-events-none' : ''}"
            aria-disabled={$settings.accentFromCover}
          >
            {#each themes as theme}
              <button
                class="theme-swatch {$settings.theme === theme.id && !$settings.accentFromCover ? 'is-active' : ''}"
                disabled={$settings.accentFromCover}
                on:click={() => setTheme(theme.id)}
              >
                <span class="w-9 h-9 rounded-full shrink-0 shadow-inner" style="background: {theme.color}"></span>
                <span class="text-[13px] font-medium truncate">{theme.name}</span>
              </button>
            {/each}
          </div>

          {#if $settings.accentFromCover}
            <p class="empty-hint !max-w-[56ch]">Пока адаптивная тема включена, цвет диктует обложка. Выключи тумблер, чтобы выбрать вручную.</p>
          {/if}
        </div>
      </div>
    </section>

    <!-- ── Движение и эффекты ──────────────────────────────────────────────── -->
    <section>
      <div class="settings-group">
        <span class="settings-group-title">Движение и эффекты</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="space-y-6">
        <!-- Четыре эффекта в одной плашке, а не четыре плашки по тумблеру: выключают их, как
             правило, все разом и по одной причине — «пусть ничего не дёргается». Разложенные
             по странице, они бы читались как четыре независимые функции, и связь между ними
             (все четыре — движение под курсором) пришлось бы угадывать. -->
        <div class="plate p-8">
          <h3 class="section-title">Движение под курсором</h3>
          <p class="empty-hint !mt-1.5 !max-w-[54ch] mb-6">
            Выключенный эффект не «анимируется в ноль», а не выполняется вовсе: ни расчётов
            на кадр, ни отдельного слоя на видеокарте под него. При системной настройке
            «меньше движения» все четыре отключаются сами, независимо от этих тумблеров.
          </p>

          <div class="flex flex-col gap-3">
            <div class="setting-row">
              <div>
                <div class="setting-title">3D-наклон обложек</div>
                <div class="setting-hint">
                  Обложка под курсором наклоняется и приподнимается над карточкой. Единственный
                  из четырёх, который двигает геометрию, — если полки подтормаживают, выключать
                  стоит первым.
                </div>
              </div>
              <button
                aria-label="3D-наклон обложек"
                role="switch"
                aria-checked={$settings.coverTilt !== false}
                class="switch"
                on:click={() => toggleFx('coverTilt')}
              >
                <span class="switch-knob"></span>
              </button>
            </div>

            <div class="setting-row">
              <div>
                <div class="setting-title">Блик под курсором</div>
                <div class="setting-hint">
                  Свет по карточке: мягкое свечение на стекле и отражение на обложке. Обложка —
                  глянцевая плоскость, поэтому при включённом наклоне блик едет к той кромке,
                  которую вы отклоняете, — как на фотографии, которую поворачивают под лампой.
                </div>
              </div>
              <button
                aria-label="Блик под курсором"
                role="switch"
                aria-checked={$settings.coverGlare !== false}
                class="switch"
                on:click={() => toggleFx('coverGlare')}
              >
                <span class="switch-knob"></span>
              </button>
            </div>

            <div class="setting-row">
              <div>
                <div class="setting-title">Проблеск по плоским карточкам</div>
                <div class="setting-hint">
                  Полоса света, один раз пробегающая по карточке на входе курсора: строки
                  исполнителей, плитки без обложки. На самих обложках её нет — там свет ходит
                  отражением, и два блика на одной поверхности выглядели рябью.
                </div>
              </div>
              <button
                aria-label="Проблеск по плоским карточкам"
                role="switch"
                aria-checked={$settings.cardSheen !== false}
                class="switch"
                on:click={() => toggleFx('cardSheen')}
              >
                <span class="switch-knob"></span>
              </button>
            </div>

            <div class="setting-row">
              <div>
                <div class="setting-title">Отклик боковой панели</div>
                <div class="setting-hint">
                  Пункты навигации мягко сдвигаются к курсору и коротко отзываются на нажатие.
                  Сама панель остаётся на месте, поэтому переходы между разделами её не дёргают.
                </div>
              </div>
              <button
                aria-label="Отклик боковой панели"
                role="switch"
                aria-checked={$settings.panelPress !== false}
                class="switch"
                on:click={() => toggleFx('panelPress')}
              >
                <span class="switch-knob"></span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Музыка ──────────────────────────────────────────────────────────── -->
    <section>
      <div class="settings-group">
        <span class="settings-group-title">Музыка</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="space-y-6">

        <!-- Audio Source. Стоит первым в группе, а плашки привязок — сразу за ним: выбор
             источника без привязанного аккаунта не работает, и подсказка «плашка ниже» в
             `setSource` теперь действительно указывает на соседний блок, а не на другой
             конец страницы. -->
        <div class="plate p-8">
          <h3 class="section-title mb-2">Источник аудио</h3>
          <p class="setting-hint !mt-0 mb-5">Откуда искать и играть треки. Локальные файлы и кэш работают при любом выборе.</p>
          <div class="flex gap-4">
            <button
              class="flex-1 py-4 rounded-xl font-bold transition-all shadow-md {$settings.searchSource === 'soundcloud'
                ? 'bg-[#ff5500] text-white shadow-[0_0_20px_rgba(255,85,0,0.35)]'
                : 'bg-neutral-800/50 text-neutral-300 border border-white/5 hover:bg-neutral-700/60'}"
              on:click={() => setSource('soundcloud')}
            >
              SoundCloud (Рекомендуется)
            </button>
            <button
              class="flex-1 py-4 rounded-xl font-bold transition-all shadow-md flex flex-col items-center justify-center gap-0.5 {$settings.searchSource === 'yandex'
                ? 'bg-[#ffcc00] text-black shadow-[0_0_20px_rgba(255,204,0,0.35)]'
                : 'bg-neutral-800/50 text-neutral-300 border border-white/5 hover:bg-neutral-700/60'}"
              on:click={() => setSource('yandex')}
            >
              <span>Яндекс Музыка</span>
              <span class="text-xs font-normal opacity-60">
                {$settings.yandexUser ? $settings.yandexUser.displayName : 'Нужен OAuth-токен'}
              </span>
            </button>
          </div>
        </div>

        <!-- SoundCloud Integration -->
        <div class="plate p-8 border border-[#ff5500]/30 bg-gradient-to-br from-[#ff5500]/5 to-transparent">
          <h3 class="section-title mb-4 !text-[#ff5500]">Привязка SoundCloud</h3>
          {#if $settings.scUser}
            <div class="flex items-center justify-between gap-4 bg-black/20 p-4 rounded-xl border border-white/5">
              <div class="flex items-center gap-4">
                {#if $settings.scUser.avatarUrl}
                  <img src={$settings.scUser.avatarUrl} alt="Avatar" class="w-12 h-12 rounded-full" />
                {/if}
                <div>
                  <div class="font-bold text-white">{$settings.scUser.username}</div>
                  <div class="text-xs text-neutral-500">Синхронизировано</div>
                </div>
              </div>
              <div class="flex items-center gap-2">
                <button class="glass-button px-4 py-2 text-sm font-bold rounded-lg hover:bg-[#ff5500] hover:text-white transition-all disabled:opacity-50" on:click={refreshSCLikes} disabled={scLoading}>
                  {scLoading ? 'Сверяю...' : 'Сверить лайки'}
                </button>
                <button class="glass-button px-4 py-2 text-sm text-red-400 font-bold rounded-lg hover:bg-red-500/20 transition-all" on:click={() => $settings.scUser = null}>Отвязать</button>
              </div>
            </div>
            <p class="setting-hint !mt-4">
              Лайки из профиля приезжают сюда сами при запуске. Обратно — нет: SoundCloud
              принимает отметки только по токену аккаунта, а приложение работает с ним без
              входа. Снятое здесь остаётся снятым только здесь.
            </p>
          {:else}
            <p class="text-neutral-300 text-sm mb-4 leading-relaxed">
              Дай ссылку на профиль SoundCloud или просто никнейм — подтяну имя и публичные плейлисты.
            </p>
            <div class="flex gap-2">
              <input type="text" bind:value={scInputUrl} placeholder="https://soundcloud.com/никнейм" class="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#ff5500] transition-colors" />
              <button class="px-6 py-3 bg-[#ff5500] text-white rounded-xl font-bold shadow-md hover:scale-105 transition" on:click={linkSoundCloud} disabled={scLoading}>
                {#if scLoading}
                  <Loader2 class="animate-spin w-5 h-5" />
                {:else}
                  Привязать
                {/if}
              </button>
            </div>
          {/if}
        </div>

        <!-- Yandex Music Integration -->
        <div class="plate p-8 border border-[#ffcc00]/30 bg-gradient-to-br from-[#ffcc00]/5 to-transparent">
          <h3 class="section-title mb-4 !text-[#ffcc00]">Привязка Яндекс Музыки</h3>
          {#if $settings.yandexUser}
            <div class="flex items-center justify-between gap-4 bg-black/20 p-4 rounded-xl border border-white/5">
              <div class="flex items-center gap-4">
                <!-- Аватар, если Паспорт его отдал: у музыкального токена может не быть на
                     это прав, и тогда остаётся фирменный знак — как было всегда. -->
                <div class="w-12 h-12 rounded-full bg-[#ffcc00] text-black grid place-items-center shrink-0 overflow-hidden">
                  {#if $settings.yandexUser.avatarUrl}
                    <img src={$settings.yandexUser.avatarUrl} alt="" class="w-full h-full object-cover" />
                  {:else}
                    <Music class="w-6 h-6" />
                  {/if}
                </div>
                <div class="min-w-0">
                  <div class="font-bold text-white truncate">{$settings.yandexUser.displayName}</div>
                  <div class="text-xs text-neutral-500">
                    {$settings.yandexUser.login || 'аккаунт привязан'}{$settings.yandexUser.hasPlus ? ' · Плюс' : ''}
                  </div>
                </div>
              </div>
              <div class="flex items-center gap-2 shrink-0">
                <button class="glass-button px-4 py-2 text-sm font-bold rounded-lg hover:bg-[#ffcc00] hover:text-black transition-all disabled:opacity-50" on:click={syncYandexLikes} disabled={ymLoading}>
                  {ymLoading ? 'Сверяю...' : 'Сверить лайки'}
                </button>
                <button class="glass-button px-4 py-2 text-sm text-red-400 font-bold rounded-lg hover:bg-red-500/20 transition-all" on:click={unlinkYandex}>Отвязать</button>
              </div>
            </div>
            <p class="setting-hint !mt-4">
              Без Плюса Яндекс отдаёт только тридцатисекундные отрывки — такие треки плеер пропускает как недоступные.
            </p>
          {:else}
            <p class="text-neutral-300 text-sm mb-2 leading-relaxed">
              Нужен OAuth-токен аккаунта. Официального способа выдать его приложению у Яндекса нет,
              поэтому токен добывается расширением <span class="font-mono text-xs text-[#ffcc00]">yandex-music-token</span>
              и вставляется сюда строкой.
            </p>
            <p class="setting-hint !mt-0 mb-4">
              Токен остаётся только на этом компьютере и уходит исключительно на api.music.yandex.net.
              Он даёт полный доступ к аккаунту — не показывай его никому.
            </p>
            <div class="flex gap-2">
              <input
                type="password"
                bind:value={ymInputToken}
                placeholder="y0_AgAAAA..."
                autocomplete="off"
                spellcheck="false"
                class="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm text-white font-mono focus:outline-none focus:border-[#ffcc00] transition-colors"
              />
              <button class="px-6 py-3 bg-[#ffcc00] text-black rounded-xl font-bold shadow-md hover:scale-105 transition disabled:opacity-50 grid place-items-center" on:click={linkYandex} disabled={ymLoading}>
                {#if ymLoading}
                  <Loader2 class="animate-spin w-5 h-5" />
                {:else}
                  Привязать
                {/if}
              </button>
            </div>
            <button
              class="text-xs text-neutral-500 hover:text-[#ffcc00] transition-colors mt-3"
              on:click={() => openUrl('https://github.com/MarshalX/yandex-music-token')}
            >
              Где взять токен →
            </button>
          {/if}
        </div>

        <!-- Устройство вывода. Стоит сразу за источниками: группа «Музыка» читается как
             «откуда играем» → «куда играем» → что делаем с кэшем. Выбор оформлен одним
             списком, а не списком плюс тумблером «следовать за системой»: «Системное по
             умолчанию» — это и есть слежение, и два элемента управления одной вещью
             неизбежно расходились бы между собой (см. applyOutput в $lib/audioOutput). -->
        <div class="plate p-8">
          <div class="flex items-start justify-between gap-4 mb-6">
            <div>
              <h3 class="section-title">Устройство воспроизведения</h3>
              <p class="setting-hint !mt-2 !max-w-[54ch]">
                Куда идёт звук. Переключается на ходу: трек продолжает играть с той же
                секунды, очередь не сбрасывается.
              </p>
            </div>
            <button
              class="glass-button px-4 py-2.5 text-sm font-medium rounded-xl flex items-center gap-2 shrink-0 disabled:opacity-50"
              on:click={refreshOutputs}
              disabled={outputsLoading || outputSwitching !== null}
              title="Обновить список"
            >
              <RefreshCw class="w-4 h-4 {outputsLoading ? 'animate-spin' : ''}" />
              Обновить
            </button>
          </div>

          <div class="flex flex-col gap-2.5">
            <button
              class="output-row {$settings.outputDevice === null ? 'is-active' : ''}"
              on:click={() => chooseOutput(null)}
              disabled={outputSwitching !== null}
            >
              <span class="output-row-icon">
                {#if outputSwitching === ''}
                  <Loader2 class="w-4 h-4 animate-spin" />
                {:else}
                  <Volume2 class="w-4 h-4" />
                {/if}
              </span>
              <span class="min-w-0">
                <span class="output-row-name">Системное по умолчанию</span>
                <span class="output-row-hint">
                  Следовать за системой: сменили устройство в Windows — звук уходит туда же.
                </span>
              </span>
              {#if $settings.outputDevice === null}
                <Check class="w-4 h-4 shrink-0 text-primary" />
              {/if}
            </button>

            {#each outputs as device (device.name)}
              <button
                class="output-row {$settings.outputDevice === device.name ? 'is-active' : ''}"
                on:click={() => chooseOutput(device)}
                disabled={outputSwitching !== null}
              >
                <span class="output-row-icon">
                  {#if outputSwitching === device.name}
                    <Loader2 class="w-4 h-4 animate-spin" />
                  {:else}
                    <Volume2 class="w-4 h-4" />
                  {/if}
                </span>
                <span class="min-w-0">
                  <span class="output-row-name">{device.description}</span>
                  {#if device.is_default}
                    <span class="output-row-hint">Выбрано системой по умолчанию</span>
                  {/if}
                </span>
                {#if $settings.outputDevice === device.name}
                  <Check class="w-4 h-4 shrink-0 text-primary" />
                {/if}
              </button>
            {/each}

            {#if missingOutput}
              <div class="output-row is-missing">
                <span class="output-row-icon">
                  <Volume2 class="w-4 h-4" />
                </span>
                <span class="min-w-0">
                  <span class="output-row-name">{missingOutput}</span>
                  <span class="output-row-hint">
                    Сейчас не подключено — звук идёт через системное. Выбор сохранён и
                    вернётся вместе с устройством.
                  </span>
                </span>
              </div>
            {/if}

            {#if outputs.length === 0 && !outputsLoading}
              <p class="empty-hint !max-w-[54ch]">
                Устройств не нашлось. В браузере такой список пуст — он собирается только в
                собранном приложении.
              </p>
            {/if}
          </div>
        </div>

        <!-- Кеш и подготовка следующего трека. Раньше здесь стояла одна плашка про офлайн; обе
             настройки про одно и то же — что приложение успевает скачать заранее, — поэтому
             стоят рядом, а не в разных местах вкладки. -->
        <div class="plate p-8">
          <h3 class="section-title mb-6">Кеш и загрузка</h3>

          <div class="setting-row mb-6">
            <div>
              <div class="setting-title">Офлайн-режим (автокеширование)</div>
              <div class="setting-hint">Сохранять прослушанные треки на диск, чтобы они играли без интернета.</div>
            </div>
            <button
              aria-label="Офлайн-режим"
              role="switch"
              aria-checked={$settings.autoCache}
              class="switch"
              on:click={toggleAutoCache}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <div class="setting-row">
            <div>
              <div class="setting-title">Готовить следующий трек заранее</div>
              <div class="setting-hint">
                За несколько секунд до конца берём ссылку на следующий трек — переход получается
                без паузы на запрос. С микшированием запас больше: загрузка обязана успеть до
                начала перехода. При включённом кеше он же начинает докачиваться.
              </div>
            </div>
            <button
              aria-label="Готовить следующий трек заранее"
              role="switch"
              aria-checked={$settings.preloadNext !== false}
              class="switch"
              on:click={() => $settings.preloadNext = $settings.preloadNext === false}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <!-- Ползунок показывается только при включённой подготовке: микшировать нечего,
               пока следующий трек не готов заранее (разбор — у `crossfadeMs` в stores.ts).
               Показывать неработающую настройку хуже, чем не показывать никакой. -->
          {#if $settings.preloadNext !== false}
            <div class="mt-6">
              <div class="flex justify-between items-center mb-4">
                <h4 class="setting-title !text-[15px]">Микширование перехода</h4>
                <span class="text-neutral-400 tnum text-sm">
                  {$settings.crossfadeMs > 0 ? `${($settings.crossfadeMs / 1000).toFixed(1)} сек` : 'выключено'}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="12000"
                step="500"
                bind:value={$settings.crossfadeMs}
                class="w-full accent-primary bg-neutral-700/50 rounded-lg h-2"
              />
              <div class="flex justify-between mt-2 text-xs text-neutral-500">
                <span>встык</span>
                <span>6 сек</span>
                <span>12 сек</span>
              </div>
              <div class="setting-hint mt-3">
                Уходящий трек гаснет, пока следующий нарастает, — на автоматическом переходе.
                Кнопка «дальше» переключает сразу. На короткой склейке переход укорачивается сам:
                дольше четверти трека он не длится.
              </div>
            </div>
          {/if}
        </div>

        <!-- Preview Settings -->
        <div class="plate p-8">
          <h3 class="section-title mb-6">Предпросмотр при наведении</h3>
          <div class="setting-row mb-6">
            <div>
              <div class="setting-title">Включить превью</div>
              <div class="setting-hint">Автоматически воспроизводить превью трека при наведении.</div>
            </div>
            <button
              aria-label="Предпросмотр при наведении"
              role="switch"
              aria-checked={$settings.enableHoverPreview}
              class="switch"
              on:click={() => $settings.enableHoverPreview = !$settings.enableHoverPreview}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          {#if $settings.enableHoverPreview}
            <div>
              <div class="flex justify-between items-center mb-4">
                <h4 class="setting-title !text-[15px]">Задержка перед включением</h4>
                <span class="text-neutral-400 tnum text-sm">{$settings.hoverPreviewDelay} мс</span>
              </div>
              <input
                type="range"
                min="200"
                max="3000"
                step="100"
                bind:value={$settings.hoverPreviewDelay}
                class="w-full accent-primary bg-neutral-700/50 rounded-lg h-2"
              />
              <div class="flex justify-between mt-2 text-xs text-neutral-500">
                <span>200 мс</span>
                <span>1.5 сек</span>
                <span>3 сек</span>
              </div>
            </div>
          {/if}
        </div>
      </div>
    </section>

    <!-- ── Текст песен ─────────────────────────────────────────────────────── -->
    <section>
      <div class="settings-group">
        <span class="settings-group-title">Текст песен</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="space-y-6">
        <!-- Плашка «Текст в полноэкранном режиме» была отдельной и содержала ровно один
             тумблер, стоя при этом далеко от настроек текста. Тумблер переехал сюда первой
             строкой: это одна и та же тема, и держать её в двух плашках было незачем. -->
        <div class="plate p-8">
          <h3 class="section-title mb-6">Отображение текста</h3>

          <div class="setting-row mb-8">
            <div>
              <div class="setting-title">Показывать сразу в полноэкранном режиме</div>
              <div class="setting-hint">Открывая полноэкранный плеер, сразу разворачивать текст, не нажимая кнопку.</div>
            </div>
            <button
              aria-label="Текст по умолчанию"
              role="switch"
              aria-checked={$settings.showLyricsByDefault}
              class="switch"
              on:click={() => $settings.showLyricsByDefault = !$settings.showLyricsByDefault}
            >
              <span class="switch-knob"></span>
            </button>
          </div>

          <div>
            <div class="flex justify-between items-center mb-4">
              <h4 class="setting-title !text-[15px]">Смещение текста</h4>
              <span class="text-neutral-400 tnum text-sm">{$settings.lyricsOffset > 0 ? '+' : ''}{$settings.lyricsOffset} мс</span>
            </div>
            <input
              type="range"
              min="-5000"
              max="5000"
              step="100"
              bind:value={$settings.lyricsOffset}
              class="w-full accent-primary bg-neutral-700/50 rounded-lg h-2"
            />
            <div class="flex justify-between mt-2 text-xs text-neutral-500">
              <span>-5 сек (Раньше)</span>
              <span>0 (Синхронно)</span>
              <span>+5 сек (Позже)</span>
            </div>
          </div>

          <div class="setting-row mt-8">
            <div>
              <div class="setting-title">Кэш текстов</div>
              <div class="setting-hint">Удалить уже скачанные слова песен, чтобы приложение поискало их заново.</div>
            </div>
            <button class="danger-btn" on:click={clearLyricsCache}>
              Сбросить
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Система ─────────────────────────────────────────────────────────── -->
    <section>
      <div class="settings-group">
        <span class="settings-group-title">Система</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="space-y-6">

        <!-- Autostart -->
        <div class="plate p-8 flex items-center justify-between">
          <div>
            <h3 class="section-title">Запуск вместе с системой</h3>
            <p class="setting-hint !mt-2">Автоматически открывать Lomify при включении ПК.</p>
          </div>
          <button
            aria-label="Запуск вместе с системой"
            role="switch"
            aria-checked={autostartEnabled}
            class="switch"
            on:click={toggleAutostart}
          >
            <span class="switch-knob"></span>
          </button>
        </div>

        <!-- Discord RPC Setting -->
        <div class="plate p-8 flex items-center justify-between">
          <div>
            <h3 class="section-title">Discord Rich Presence</h3>
            <p class="setting-hint !mt-2">Показывать текущий трек в статусе Discord</p>
          </div>
          <div class="flex items-center gap-4">
            {#if $settings.enableDiscordRpc !== false}
            <button
              class="px-4 py-2 bg-neutral-700/50 hover:bg-neutral-600 rounded-xl transition text-sm font-bold shadow-md text-white"
              on:click={async () => {
                 const { invoke } = await import('@tauri-apps/api/core');
                 try {
                    await invoke('discord_disconnect');
                    await invoke('discord_connect');
                    notify('Discord подключён заново', 'success');
                 } catch (e) {
                    notify('Discord не отвечает — подключусь, когда появится', 'error');
                 }
              }}
            >
              Перезапустить
            </button>
            {/if}
            <button
              aria-label="Discord Rich Presence"
              role="switch"
              aria-checked={$settings.enableDiscordRpc !== false}
              class="switch"
              on:click={() => $settings.enableDiscordRpc = $settings.enableDiscordRpc === false ? true : false}
            >
              <span class="switch-knob"></span>
            </button>
          </div>
        </div>

        <!-- App Data Paths -->
        <div class="plate p-8">
          <h3 class="section-title mb-4">Системные файлы</h3>
          <div class="space-y-4">
            <div class="bg-black/20 p-4 rounded-xl border border-white/5">
              <div class="text-sm font-bold text-neutral-300 mb-1">Данные приложения (App Data):</div>
              <div class="font-mono text-xs text-neutral-500 break-all">{dataPath || 'Загрузка...'}</div>
            </div>
            <div class="bg-black/20 p-4 rounded-xl border border-white/5">
              <div class="text-sm font-bold text-neutral-300 mb-1">Локальные данные (Кэш, настройки):</div>
              <div class="font-mono text-xs text-neutral-500 break-all">{localDataPath || 'Загрузка...'}</div>
            </div>
          </div>
        </div>

        <!-- Gibberish Easter Egg Setting -->
        <div class="plate p-8 flex items-center justify-between">
          <div>
            <h3 class="section-title">чеянесунахуй</h3>
            <p class="setting-hint !mt-2">ывавылаывоапа ывывоалдываор ывлдаоыдвраун</p>
          </div>
          <button
            aria-label="Секретный режим"
            role="switch"
            aria-checked={$settings.gibberishMode}
            class="switch"
            on:click={handleGibberishToggle}
          >
            <span class="switch-knob"></span>
          </button>
        </div>
      </div>
    </section>

    <!-- ── Опасная зона ────────────────────────────────────────────────────── -->
    <section>
      <div class="settings-group">
        <span class="settings-group-title">Опасная зона</span>
        <span class="settings-group-rule"></span>
      </div>
      <div class="plate p-8 border border-red-500/20">
        <h3 class="section-title !text-red-400">Отсюда ничего не возвращается</h3>
        <p class="empty-hint !mt-1.5 !max-w-[54ch] mb-6">Отмены нет ни у одного из трёх действий.</p>
        <div class="flex flex-col gap-3">
          <div class="setting-row">
            <div>
              <div class="setting-title">Сбросить профиль</div>
              <div class="setting-hint">Обнулить часы прослушивания и счётчик включённых треков.</div>
            </div>
            <button class="danger-btn" on:click={resetProfileStats}>
              Сбросить
            </button>
          </div>

          <div class="setting-row">
            <div>
              <div class="setting-title">Удалить кэш треков</div>
              <div class="setting-hint">Стереть все сохранённые аудиофайлы. Лайки и плейлисты останутся.</div>
            </div>
            <button
              class="danger-btn"
              on:click={async () => {
                const { invoke } = await import('@tauri-apps/api/core');
                try {
                  await invoke('track_clear_cache');
                  await invoke('track_clear_liked_cache');
                  window.dispatchEvent(new CustomEvent('cacheCleared'));
                  notify('Кэш чист', 'success');
                } catch(e) {
                  notify('Не смог очистить кэш', 'error');
                }
              }}
            >
              Удалить
            </button>
          </div>

          <div class="setting-row">
            <div>
              <div class="setting-title">Удалить всё</div>
              <div class="setting-hint">Приложение станет как после установки: ни лайков, ни истории, ни настроек.</div>
            </div>
            <button class="danger-btn is-solid" on:click={resetAllData}>
              Удалить всё
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- About / Info -->
    <div class="flex flex-col items-center justify-center mt-10 mb-12 gap-3">
      <!-- Капсула вместо трёх отдельных строк текста: имя, версия и канал сборки —
           одна сущность, и читаются они как один объект. -->
      <div class="version-badge">
        <span class="version-badge-name">{APP_NAME}</span>
        <span class="version-badge-sep"></span>
        <span class="version-badge-num">{APP_VERSION}</span>
        <span class="version-badge-tag">
          <span class="version-badge-dot"></span>
          {APP_CHANNEL}
        </span>
      </div>
      <a href="https://t.me/dopaminegdev" target="_blank" class="text-[12.5px] text-white/35 hover:text-white/75 transition-colors mt-1">
        Автор — @dopaminegdev
      </a>
    </div>
  </div>
</div>
