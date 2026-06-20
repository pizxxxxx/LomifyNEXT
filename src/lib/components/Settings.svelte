<script lang="ts">
  import { settings, playlists, listenStats, notify, currentTrack, isPlaying } from '$lib/stores';
  import { Download, Loader2, Check, Music } from 'lucide-svelte';
  import { enable, isEnabled, disable } from '@tauri-apps/plugin-autostart';
  import { appDataDir, appLocalDataDir } from '@tauri-apps/api/path';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { onMount } from 'svelte';
  import { isGlassSupported } from 'tauri-plugin-liquid-glass-api';

  let importLoading = false;
  let autostartEnabled = false;
  let dataPath = '';
  let localDataPath = '';
  let glassSupported = false;

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
    (async () => {
      try {
        if (window && '__TAURI_INTERNALS__' in window) {
          autostartEnabled = await isEnabled();
          dataPath = await appDataDir();
          localDataPath = await appLocalDataDir();
          glassSupported = await isGlassSupported();
        }
      } catch(e) {
        console.error("Failed to load settings data", e);
      }
    })();
  });

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
      notify('Ошибка автозапуска', 'error');
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
      if (user) {
        $settings.scUser = user;
        notify('Профиль привязан!', 'success');
        // Fetch likes and playlists
        const { getUserLikes, getUserPlaylists } = await import('$lib/api');
        const userLikes = await getUserLikes(user.id);
        const userPlaylists = await getUserPlaylists(user.id);
        
        import('$lib/stores').then(({ likedTracks, playlists }) => {
          if (userLikes.length > 0) {
            likedTracks.update(lt => {
              const newLikes = userLikes.filter((ul: any) => !lt.some((existing: any) => existing.id === ul.id));
              return [...newLikes, ...lt];
            });
          }
          if (userPlaylists.length > 0) {
            playlists.update(p => {
              const newPlaylists = userPlaylists.filter((up: any) => !p.some((existing: any) => existing.id === up.id));
              return [...newPlaylists, ...p];
            });
          }
          notify(`Импортировано ${userLikes.length} лайков и ${userPlaylists.length} плейлистов`, 'success');
        });
      } else {
        notify('Профиль не найден', 'error');
      }
    } catch (e) {
      notify('Ошибка привязки', 'error');
    }
    scLoading = false;
  }

  async function refreshSCLikes() {
    if (!$settings.scUser) return;
    scLoading = true;
    try {
      const { getUserLikes } = await import('$lib/api');
      const userLikes = await getUserLikes($settings.scUser.id);
      if (userLikes.length > 0) {
        import('$lib/stores').then(({ likedTracks }) => {
          likedTracks.update(lt => {
            const newLikes = userLikes.filter((ul: any) => !lt.some((existing: any) => existing.id === ul.id));
            if (newLikes.length > 0) {
              notify(`Найдено новых лайков: ${newLikes.length}`, 'success');
              return [...newLikes, ...lt];
            } else {
              notify('Новых лайков не найдено', 'info');
              return lt;
            }
          });
        });
      } else {
        notify('Нет лайков в SoundCloud', 'info');
      }
    } catch (e) {
      notify('Ошибка обновления лайков', 'error');
    }
    scLoading = false;
  }

  function toggleParallax() {
    $settings.parallax = !$settings.parallax;
  }

  function toggleAutoCache() {
    $settings.autoCache = !$settings.autoCache;
  }

  function setSource(source: 'soundcloud') {
    $settings.searchSource = source;
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
    if (confirm("Вы уверены, что хотите сбросить часы прослушивания и историю в профиле?")) {
      listenStats.set({ listenSeconds: 0, tracksPlayed: 0, history: {} });
      notify("Профиль успешно сброшен", "success");
    }
  }

  function resetAllData() {
    if (confirm("Вы уверены, что хотите полностью очистить все данные приложения (настройки, историю, любимые треки)? Это действие нельзя отменить!")) {
      localStorage.clear();
      window.location.reload();
    }
  }
</script>

<div class="max-w-3xl mx-auto py-8 perspective-[1000px]">
  <h2 class="text-4xl font-extrabold mb-8 drop-shadow-md">Настройки</h2>

  <div class="space-y-6">
    
    <!-- Parallax removed -->

    <!-- Autostart -->
    <div class="glass-panel p-8 flex items-center justify-between">
      <div>
        <h3 class="font-bold text-xl drop-shadow-md">Запуск вместе с системой</h3>
        <p class="text-neutral-400 text-sm mt-2">Автоматически открывать Lomify при включении ПК.</p>
      </div>
      <button 
        aria-label="Toggle autostart"
        class="w-16 h-8 rounded-full transition-all duration-300 relative shadow-inner { autostartEnabled ? 'bg-primary shadow-[0_0_15px_var(--color-primary)]' : 'bg-neutral-700/50' }"
        on:click={toggleAutostart}
      >
        <div class="absolute top-1 left-1 w-6 h-6 rounded-full bg-white transition-transform duration-300 shadow-md { autostartEnabled ? 'translate-x-8' : 'translate-x-0' }"></div>
      </button>
    </div>


    <!-- App Data Paths -->
    <div class="glass-panel p-8">
      <h3 class="font-bold text-xl mb-4 drop-shadow-md">Системные файлы</h3>
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

    <!-- SoundCloud Integration -->
    <div class="glass-panel p-8 border border-[#ff5500]/30 bg-gradient-to-br from-[#ff5500]/5 to-transparent">
      <h3 class="font-bold text-xl mb-4 drop-shadow-md text-[#ff5500]">Привязка SoundCloud</h3>
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
              {scLoading ? 'Обновление...' : 'Обновить лайки'}
            </button>
            <button class="glass-button px-4 py-2 text-sm text-red-400 font-bold rounded-lg hover:bg-red-500/20 transition-all" on:click={() => $settings.scUser = null}>Отвязать</button>
          </div>
        </div>
      {:else}
        <p class="text-neutral-300 text-sm mb-4 leading-relaxed">
          Введите ссылку на ваш профиль SoundCloud или никнейм, чтобы синхронизировать имя и импортировать публичные плейлисты.
        </p>
        <div class="flex gap-2">
          <input type="text" bind:value={scInputUrl} placeholder="https://soundcloud.com/ваш_профиль" class="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm text-white focus:outline-none focus:border-[#ff5500] transition-colors" />
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

    <!-- Auto-Cache Setting -->
    <div class="glass-panel p-8 flex items-center justify-between">
      <div>
        <h3 class="font-bold text-xl drop-shadow-md">Офлайн-режим (Автокеширование)</h3>
        <p class="text-neutral-400 text-sm mt-2">Автоматически сохранять все прослушанные треки для работы без интернета.</p>
      </div>
      <button 
        aria-label="Toggle auto-cache"
        class="w-16 h-8 rounded-full transition-all duration-300 relative shadow-inner { $settings.autoCache ? 'bg-primary shadow-[0_0_15px_var(--color-primary)]' : 'bg-neutral-700/50' }"
        on:click={toggleAutoCache}
      >
        <div class="absolute top-1 left-1 w-6 h-6 rounded-full bg-white transition-transform duration-300 shadow-md { $settings.autoCache ? 'translate-x-8' : 'translate-x-0' }"></div>
      </button>
    </div>


    <!-- Discord RPC Setting -->
    <div class="glass-panel p-8 flex items-center justify-between">
      <div>
        <h3 class="font-bold text-xl drop-shadow-md">Discord Rich Presence</h3>
        <p class="text-neutral-400 text-sm mt-2">Показывать текущий трек в статусе Discord</p>
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
                notify('Discord RPC перезапущен', 'success');
             } catch (e) {
                notify('Ошибка RPC', 'error');
             }
          }}
        >
          Перезапустить
        </button>
        {/if}
        <button 
          aria-label="Toggle Discord RPC"
          class="w-16 h-8 rounded-full transition-all duration-300 relative shadow-inner { $settings.enableDiscordRpc !== false ? 'bg-primary shadow-[0_0_15px_var(--color-primary)]' : 'bg-neutral-700/50' }"
          on:click={() => $settings.enableDiscordRpc = $settings.enableDiscordRpc === false ? true : false}
        >
          <div class="absolute top-1 left-1 w-6 h-6 rounded-full bg-white transition-transform duration-300 shadow-md { $settings.enableDiscordRpc !== false ? 'translate-x-8' : 'translate-x-0' }"></div>
        </button>
      </div>
    </div>

    <!-- Gibberish Easter Egg Setting -->
    <div class="glass-panel p-8 flex items-center justify-between">
      <div>
        <h3 class="font-bold text-xl drop-shadow-md">чеянесунахуй</h3>
        <p class="text-neutral-400 text-sm mt-2">ывавылаывоапа ывывоалдываор ывлдаоыдвраун</p>
      </div>
      <button 
        aria-label="Toggle gibberish"
        class="w-16 h-8 rounded-full transition-all duration-300 relative shadow-inner { $settings.gibberishMode ? 'bg-primary shadow-[0_0_15px_var(--color-primary)]' : 'bg-neutral-700/50' }"
        on:click={handleGibberishToggle}
      >
        <div class="absolute top-1 left-1 w-6 h-6 rounded-full bg-white transition-transform duration-300 shadow-md { $settings.gibberishMode ? 'translate-x-8' : 'translate-x-0' }"></div>
      </button>
    </div>

    <!-- Audio Source -->
    <div class="glass-panel p-8">
      <h3 class="font-bold text-xl mb-2 drop-shadow-md">Источник аудио</h3>
      <div class="flex gap-4">
        <button 
          class="flex-1 py-4 rounded-xl font-bold transition-all shadow-md bg-orange-500 text-white scale-105 shadow-[0_0_20px_rgba(249,115,22,0.4)]"
          on:click={() => setSource('soundcloud')}
        >
          SoundCloud (Рекомендуется)
        </button>
        <button 
          class="flex-1 py-4 rounded-xl font-bold transition-all shadow-md bg-neutral-800/50 text-neutral-500 cursor-not-allowed flex flex-col items-center justify-center gap-0.5 border border-white/5"
          disabled
        >
          <span>Яндекс Музыка</span>
          <span class="text-xs font-normal opacity-50">Может быть...</span>
        </button>
      </div>
    </div>

    <!-- Integrations Section Removed -->
    <!-- Theme Selection -->
    <div class="glass-panel p-8">
      <h3 class="font-bold text-xl mb-6 drop-shadow-md">Тема оформления</h3>
      <div class="grid grid-cols-2 md:grid-cols-3 gap-4">
        {#each themes as theme}
          <button 
            class="p-4 rounded-2xl flex flex-col items-center gap-3 interactive-item transition-all { $settings.theme === theme.id ? 'ring-2 ring-white scale-105 shadow-xl bg-white/10' : 'glass-button' }"
            on:click={() => setTheme(theme.id)}
          >
            <div class="w-12 h-12 rounded-full shadow-inner" style="background: {theme.color}"></div>
            <span class="font-bold text-sm text-center">{theme.name}</span>
          </button>
        {/each}
      </div>
    </div>


    <!-- UI Style Toggle -->
    <div class="glass-panel p-8">
      <h3 class="font-bold text-xl mb-6 drop-shadow-md">Отображение текста (Fullscreen)</h3>
      <div class="flex items-center justify-between bg-black/20 p-4 rounded-xl border border-white/5">
        <div>
          <div class="font-bold">Текст по умолчанию</div>
          <div class="text-sm text-neutral-400">Сразу показывать текст при переходе в полноэкранный режим.</div>
        </div>
        <button 
          aria-label="Toggle default lyrics visibility"
          class="w-14 h-7 rounded-full transition-colors relative { $settings.showLyricsByDefault ? 'bg-primary' : 'bg-neutral-600' }"
          on:click={() => $settings.showLyricsByDefault = !$settings.showLyricsByDefault}
        >
          <div class="w-5 h-5 bg-white rounded-full absolute top-1 transition-all { $settings.showLyricsByDefault ? 'left-8' : 'left-1' }"></div>
        </button>
      </div>
    </div>

    <!-- Preview Settings -->
    <div class="glass-panel p-8">
      <h3 class="font-bold text-xl mb-6 drop-shadow-md">Предпросмотр при наведении</h3>
      <div class="flex items-center justify-between bg-black/20 p-4 rounded-xl border border-white/5 mb-6">
        <div>
          <div class="font-bold">Включить превью</div>
          <div class="text-sm text-neutral-400">Автоматически воспроизводить превью трека при наведении.</div>
        </div>
        <button 
          aria-label="Toggle hover preview"
          class="w-14 h-7 rounded-full transition-colors relative { $settings.enableHoverPreview ? 'bg-primary' : 'bg-neutral-600' }"
          on:click={() => $settings.enableHoverPreview = !$settings.enableHoverPreview}
        >
          <div class="w-5 h-5 bg-white rounded-full absolute top-1 transition-all { $settings.enableHoverPreview ? 'left-8' : 'left-1' }"></div>
        </button>
      </div>

      {#if $settings.enableHoverPreview}
        <div>
          <div class="flex justify-between items-center mb-4">
            <h4 class="font-bold text-lg drop-shadow-md">Задержка перед включением</h4>
            <span class="text-neutral-400 font-mono text-sm">{$settings.hoverPreviewDelay} мс</span>
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

    <!-- Interface Blur & Theme Depth -->
    <div class="glass-panel p-8">
      <h3 class="font-bold text-xl mb-6 drop-shadow-md">Настройки стиля (Размытие и Глубина)</h3>
      <div class="flex gap-4 mb-6">
        <button 
          class="flex-1 py-4 rounded-2xl font-bold transition-all interactive-item { $settings.uiStyle === 'style1' ? 'bg-primary text-black shadow-[0_0_25px_color-mix(in_srgb,var(--color-primary)_60%,transparent)]' : 'glass-button' }"
          on:click={() => $settings.uiStyle = 'style1'}
        >
          Вариант 1 (светлее)
        </button>
        <button 
          class="flex-1 py-4 rounded-2xl font-bold transition-all interactive-item { $settings.uiStyle === 'style2' ? 'bg-primary text-black shadow-[0_0_25px_color-mix(in_srgb,var(--color-primary)_60%,transparent)]' : 'glass-button' }"
          on:click={() => $settings.uiStyle = 'style2'}
        >
          Вариант 2 (темнее)
        </button>
        <button 
          class="flex-1 py-4 rounded-2xl font-bold transition-all relative { $settings.uiStyle === 'style3' ? 'bg-primary text-black shadow-[0_0_25px_color-mix(in_srgb,var(--color-primary)_60%,transparent)]' : 'glass-button' } { !glassSupported ? 'opacity-50 cursor-not-allowed' : 'interactive-item' }"
          on:click={() => { if (glassSupported) $settings.uiStyle = 'style3'; }}
          disabled={!glassSupported}
        >
          Вариант 3 (Liquid Glass)
          {#if !glassSupported}
            <div class="absolute -bottom-6 left-0 right-0 text-[10px] text-neutral-400 font-normal text-center">Только для macOS 26+</div>
          {/if}
        </button>
      </div>

      <div class="flex items-center justify-between bg-black/20 p-4 rounded-xl border border-white/5">
        <div>
          <div class="font-bold">Глубина темы</div>
          <div class="text-sm text-neutral-400">Цвет темы аккуратно подмешивается в фон приложения.</div>
        </div>
        <button 
          aria-label="Toggle global theme"
          class="w-14 h-7 rounded-full transition-colors relative { $settings.globalThemeEffect ? 'bg-primary' : 'bg-neutral-600' }"
          on:click={() => $settings.globalThemeEffect = !$settings.globalThemeEffect}
        >
          <div class="w-5 h-5 bg-white rounded-full absolute top-1 transition-all { $settings.globalThemeEffect ? 'left-8' : 'left-1' }"></div>
        </button>
      </div>

      <div class="flex items-center justify-between bg-black/20 p-4 rounded-xl border border-white/5 mt-4">
        <div>
          <div class="font-bold">Левосторонний список треков</div>
          <div class="text-sm text-neutral-400">Сместить списки треков влево, вместо выравнивания по центру.</div>
        </div>
        <button 
          aria-label="Toggle left align tracks"
          class="w-14 h-7 rounded-full transition-colors relative { $settings.leftAlignTracks ? 'bg-primary' : 'bg-neutral-600' }"
          on:click={() => $settings.leftAlignTracks = !$settings.leftAlignTracks}
        >
          <div class="w-5 h-5 bg-white rounded-full absolute top-1 transition-all { $settings.leftAlignTracks ? 'left-8' : 'left-1' }"></div>
        </button>
      </div>
    </div>
    <!-- Lyrics Settings -->
    <div class="glass-panel p-8">
      <h3 class="font-bold text-xl mb-6 drop-shadow-md">Отображение текста</h3>
      
      <div>
        <div class="flex justify-between items-center mb-4">
          <h4 class="font-bold text-lg drop-shadow-md">Смещение текста (Offset)</h4>
          <span class="text-neutral-400 font-mono text-sm">{$settings.lyricsOffset > 0 ? '+' : ''}{$settings.lyricsOffset} мс</span>
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

      <div class="mt-8 pt-6 border-t border-white/5 flex justify-between items-center">
        <div>
          <h4 class="font-bold">Управление кэшем текстов</h4>
          <p class="text-xs text-neutral-400 mt-1">Удалить загруженные тексты песен для поиска заново</p>
        </div>
        <button 
          class="px-4 py-2 bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white rounded-xl transition-colors text-sm font-bold"
          on:click={clearLyricsCache}
        >
          Сбросить кэш
        </button>
      </div>
    </div>

    <!-- Danger Zone -->
    <div class="glass-panel p-8 border border-red-500/20">
      <h3 class="font-bold text-xl mb-6 drop-shadow-md text-red-500">Опасная зона</h3>
      <div class="space-y-6">
        <div class="flex items-center justify-between">
          <div>
            <div class="font-bold text-white">Сбросить профиль</div>
            <div class="text-sm text-neutral-400">Сбросить часы прослушивания и счетчик включений треков.</div>
          </div>
          <button 
            class="px-6 py-3 bg-red-500/20 text-red-500 rounded-xl hover:bg-red-500/30 transition font-bold"
            on:click={resetProfileStats}
          >
            Сбросить профиль
          </button>
        </div>
        
        <div class="flex items-center justify-between">
          <div>
            <div class="font-bold text-white">Удалить кэш треков</div>
            <div class="text-sm text-neutral-400">Очистить все локально сохраненные аудиофайлы треков.</div>
          </div>
          <button 
            class="px-6 py-3 bg-red-500/20 text-red-500 rounded-xl hover:bg-red-500/30 transition font-bold"
            on:click={async () => {
              const { invoke } = await import('@tauri-apps/api/core');
              try {
                await invoke('track_clear_cache');
                await invoke('track_clear_liked_cache');
                window.dispatchEvent(new CustomEvent('cacheCleared'));
                notify('Кэш аудиофайлов очищен!', 'success');
              } catch(e) {
                notify('Ошибка очистки кэша', 'error');
              }
            }}
          >
            Удалить кэш
          </button>
        </div>

        <div class="flex items-center justify-between">
          <div>
            <div class="font-bold text-white">Удалить все данные</div>
            <div class="text-sm text-neutral-400">Полностью сбросить приложение (любимые треки, историю, настройки).</div>
          </div>
          <button 
            class="px-6 py-3 bg-red-600 text-white rounded-xl hover:bg-red-700 transition font-bold shadow-[0_0_15px_rgba(220,38,38,0.4)]"
            on:click={resetAllData}
          >
            Удалить всё
          </button>
        </div>
      </div>
    </div>
    <!-- About / Info -->
    <div class="flex flex-col items-center justify-center text-neutral-500 mt-8 mb-12 gap-2">
      <div class="font-bold text-xl drop-shadow-md">LomifyNEXT</div>
      <div class="flex flex-col items-center gap-2">
        <div class="text-sm">Версия приложения: 8.6.0</div>
        <div class="bg-yellow-500/20 text-yellow-500 px-3 py-1 rounded-full text-xs font-bold border border-yellow-500/30">
          НЕСТАБИЛЬНАЯ ВЕРСИЯ
        </div>
      </div>
      <a href="https://t.me/dopaminegdev" target="_blank" class="text-sm hover:text-white hover:underline transition-colors mt-2">
        Мой ТГ: @dopaminegdev
      </a>
    </div>
  </div>
</div>
