<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { ChevronRight, Home, Search, Library, Settings, Sliders, HeartHandshake, Star } from '@lucide/svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { currentView, settings, notify } from '$lib/stores';
  import { LASTFM_TASTE_UPDATED_EVENT, getLastFmSession, type LastFmSession } from '$lib/lastfm';

  /** Страница проекта. Звезда ставится на ней же, отдельного адреса для этого нет. */
  const GITHUB_URL = 'https://github.com/pizxxxxx/LomifyNEXT';

  let osUsername = 'User';
  let lastFmSession: LastFmSession | null = null;
  $: scUsername = $settings.scUser?.username || '';

  // Личность профиля — та же, что на самой странице профиля: сначала SoundCloud, затем
  // Яндекс, Last.fm и только потом своё имя. Правило продублировано, а не вынесено: это две строки,
  // и общая функция ради них связала бы панель со страницей крепче, чем они связаны сейчас.
  // Аватар — обязательно того же аккаунта, чьё имя показано (разбор в Profile.svelte).
  $: yandexUser = $settings.yandexUser;
  $: displayUsername =
    scUsername || yandexUser?.displayName || lastFmSession?.username || $settings.customProfileName || osUsername;
  $: avatarUrl = scUsername
    ? $settings.scUser?.avatarUrl || ''
    : yandexUser
      ? yandexUser.avatarUrl || ''
      : lastFmSession?.avatarUrl || '';

  // Порядок пунктов = порядок в разметке. Раньше каждая кнопка была отдельным блоком с
  // одной и той же строкой утилит и одним и тем же маркером внутри — пять копий, которые
  // приходилось править синхронно.
  const primaryNav = [
    { view: 'home', label: 'Главная', icon: Home },
    { view: 'search', label: 'Поиск', icon: Search },
    { view: 'library', label: 'Медиатека', icon: Library }
  ] as const;

  const secondaryNav = [
    { view: 'equalizer', label: 'Эквалайзер', icon: Sliders },
    { view: 'settings', label: 'Настройки', icon: Settings }
  ] as const;

  onMount(() => {
    lastFmSession = getLastFmSession();
    const syncLastFmIdentity = () => lastFmSession = getLastFmSession();
    window.addEventListener(LASTFM_TASTE_UPDATED_EVENT, syncLastFmIdentity);

    void (async () => {
      try {
        if (window && '__TAURI_INTERNALS__' in window) {
          osUsername = await invoke('get_os_username');
        }
      } catch (e) {
        console.error(e);
      }
    })();

    return () => window.removeEventListener(LASTFM_TASTE_UPDATED_EVENT, syncLastFmIdentity);
  });

  async function openSupport() {
    currentView.set('settings');
    await tick();
    window.dispatchEvent(new Event('lomify:open-support'));
  }

  /**
   * Страница проекта открывается в системном браузере, а не внутри окна: звезда ставится из
   * аккаунта, и просить человека входить в него внутри плеера неправильно.
   */
  async function openGithub() {
    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        await openUrl(GITHUB_URL);
      } else {
        const externalWindow = window.open(GITHUB_URL, '_blank', 'noopener,noreferrer');
        if (!externalWindow) throw new Error('Popup blocked');
      }
    } catch (e) {
      console.warn('Не удалось открыть страницу проекта', e);
      notify('Не удалось открыть страницу проекта. Проверьте подключение к интернету.', 'error');
    }
  }
</script>

<!-- Панель остаётся неподвижной: это постоянная опора интерфейса, а не карточка. Движутся
     только пункты под курсором, поэтому переход между разделами не сбрасывает положение
     всей колонки и не пересобирает размытие фона под ней. -->
<aside class="sidebar-shell">
  <img class="sidebar-watermark" src="/app-icon.png?v=2" alt="" aria-hidden="true" />
  <div class="sidebar-brand">
    <span class="sidebar-brand-copy">
      <strong>Lomify<span>NEXT</span></strong>
      <small>Твоя музыка, без лишнего</small>
    </span>
  </div>

  <nav class="sidebar-nav" aria-label="Основная навигация">
    <span class="sidebar-section-label">Музыка</span>
    {#each primaryNav as item}
      <button
        type="button"
        class="nav-item"
        class:is-active={($currentView === item.view || ($currentView === 'daily-mix' && item.view === 'home'))}
        aria-current={($currentView === item.view || ($currentView === 'daily-mix' && item.view === 'home')) ? 'page' : undefined}
        on:mousedown|preventDefault
        on:click={() => currentView.set(item.view)}
      >
        <!-- Полоска активного пункта живёт в разметке всегда, состояние ей задаёт CSS по
             `.nav-item.is-active`. Условный рендер убивал бы её появление: элемент,
             которого в DOM ещё нет, возникает сразу в конечном виде, анимировать нечего. -->
        <span class="nav-marker"></span>
        <svelte:component this={item.icon} size={19} aria-hidden="true" />
        <span>{item.label}</span>
      </button>
    {/each}
  </nav>

  <div class="sidebar-secondary">
    <span class="sidebar-section-label">Управление</span>
    {#each secondaryNav as item}
      <button
        type="button"
        class="nav-item"
        class:is-active={$currentView === item.view}
        aria-current={$currentView === item.view ? 'page' : undefined}
        on:mousedown|preventDefault
        on:click={() => currentView.set(item.view)}
      >
        <!-- Полоска активного пункта живёт в разметке всегда, состояние ей задаёт CSS по
             `.nav-item.is-active`. Условный рендер убивал бы её появление: элемент,
             которого в DOM ещё нет, возникает сразу в конечном виде, анимировать нечего. -->
        <span class="nav-marker"></span>
        <svelte:component this={item.icon} size={19} aria-hidden="true" />
        <span>{item.label}</span>
      </button>
    {/each}

    <div class="sidebar-foot">
      <button type="button" class="sidebar-star" on:click={openGithub} aria-label="Открыть страницу проекта на GitHub, чтобы поставить звезду">
        <span class="sidebar-star-icon" aria-hidden="true"><Star size={16} /></span>
        <span class="sidebar-star-copy"><strong>Поставьте звезду на GitHub</strong><small>Откроется в браузере</small></span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
      <button type="button" class="sidebar-support" on:click={openSupport} aria-label="Поддержать проект через ЮMoney">
        <span class="sidebar-support-icon" aria-hidden="true"><HeartHandshake size={18} /></span>
        <span class="sidebar-support-copy"><strong>Поддержать проект</strong><small>Через ЮMoney</small></span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        class="sidebar-profile"
        class:is-active={$currentView === 'profile'}
        aria-current={$currentView === 'profile' ? 'page' : undefined}
        on:mousedown|preventDefault
        on:click={() => currentView.set('profile')}
        title="Профиль ({displayUsername})"
      >
        <span class="nav-marker"></span>
        <span class="sidebar-avatar" aria-hidden="true">
          {#if avatarUrl}
            <img src={avatarUrl} alt="" />
          {:else}
            {displayUsername.charAt(0).toUpperCase()}
          {/if}
        </span>
        <span class="sidebar-profile-copy">
          <strong>{displayUsername}</strong>
          <small>Открыть профиль</small>
        </span>
        <ChevronRight class="sidebar-profile-arrow" size={16} aria-hidden="true" />
      </button>
    </div>
  </div>
</aside>
