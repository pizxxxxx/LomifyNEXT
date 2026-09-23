<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { cubicOut, cubicIn } from 'svelte/easing';
  import {
    updateStatus,
    updateInfo,
    downloadProgress,
    startDownload,
    installDownloadedUpdate,
    showStartupUpdateModal,
    showTopUpdateNotification
  } from '$lib/updater';
  import { APP_NAME, APP_VERSION } from '$lib/version';
  import { settings } from '$lib/stores';
  import {
    Sparkles,
    Download,
    Check,
    Loader2,
    X,
    ArrowUpCircle,
    FileText
  } from 'lucide-svelte';

  function dismissTopNotification() {
    showTopUpdateNotification.set(false);
  }

  function dismissStartupModal() {
    showStartupUpdateModal.set(false);
    // При закрытии стартовой модалки оставляем аккуратное уведомление сверху,
    // чтобы пользователь мог обновиться позже в любой момент
    if ($updateStatus === 'available' || $updateStatus === 'downloading' || $updateStatus === 'ready') {
      showTopUpdateNotification.set(true);
    }
  }

  async function handleUpdateClick() {
    if ($updateStatus === 'ready') {
      await installDownloadedUpdate();
    } else if ($updateStatus !== 'downloading') {
      await startDownload();
    }
  }

  function formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }
</script>

<!-- 1. Плавающее уведомление сверху во время работы плеера -->
{#if $showTopUpdateNotification && $updateInfo}
  <aside
    class="fixed top-10 left-1/2 -translate-x-1/2 z-[9990] flex items-center gap-3 px-4 py-2 rounded-2xl shadow-2xl backdrop-blur-xl bg-neutral-900/95 border border-primary/40 text-white pointer-events-auto select-none"
    in:fly={{ y: -24, duration: 280, easing: cubicOut }}
    out:fly={{ y: -24, duration: 200, easing: cubicIn }}
    role="status"
    aria-live="polite"
    aria-label="Уведомление об обновлении"
  >
    <div class="flex items-center gap-2">
      <span class="relative flex h-2 w-2" aria-hidden="true">
        <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
        <span class="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
      </span>
      <ArrowUpCircle size={15} class="text-primary flex-shrink-0" aria-hidden="true" />
      <span class="text-xs font-semibold text-white/95">Доступно обновление</span>
      <span class="px-1.5 py-0.5 rounded-md bg-primary/15 text-primary border border-primary/30 text-[11px] font-bold tnum">
        v{$updateInfo.version}
      </span>
    </div>

    <div class="flex items-center gap-2 ml-1">
      {#if $updateStatus === 'ready'}
        <button
          type="button"
          class="px-3 py-1 rounded-xl bg-primary text-black font-semibold text-xs hover:brightness-110 active:scale-95 transition-all shadow-md flex items-center gap-1.5"
          on:click={handleUpdateClick}
        >
          <Check size={13} strokeWidth={2.6} />
          <span>Установить и перезапустить</span>
        </button>
      {:else if $updateStatus === 'downloading'}
        <div class="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-white/10 text-white text-xs font-medium">
          <Loader2 size={13} class="animate-spin text-primary" />
          <span>Загрузка {$downloadProgress.percent}%</span>
        </div>
      {:else}
        <button
          type="button"
          class="px-3 py-1 rounded-xl bg-primary text-black font-semibold text-xs hover:brightness-110 active:scale-95 transition-all shadow-md flex items-center gap-1.5"
          on:click={handleUpdateClick}
        >
          <Download size={13} strokeWidth={2.4} />
          <span>Обновить</span>
        </button>
      {/if}

      <button
        type="button"
        class="p-1 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
        aria-label="Закрыть уведомление"
        title="Закрыть"
        on:click={dismissTopNotification}
      >
        <X size={14} />
      </button>
    </div>
  </aside>
{/if}

<!-- 2. Стартовая плашка/модальное окно при запуске о наличии новой версии -->
{#if $showStartupUpdateModal && $updateInfo}
  <!-- svelte-ignore a11y-no-static-element-interactions -->
  <!-- svelte-ignore a11y-click-events-have-key-events -->
  <div
    class="fixed inset-0 z-[9995] flex items-center justify-center p-4 bg-black/65 backdrop-blur-md"
    transition:fade={{ duration: 180 }}
    on:click|self={dismissStartupModal}
  >
    <div
      class="w-full max-w-md rounded-2xl glass-panel bg-neutral-900/95 border border-white/12 shadow-2xl p-6 text-white relative flex flex-col gap-5"
      in:fly={{ y: 20, duration: 240, easing: cubicOut }}
      out:fly={{ y: 15, duration: 160, easing: cubicIn }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-dialog-title"
    >
      <!-- Шапка -->
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="w-8 h-8 rounded-xl bg-primary/15 border border-primary/30 flex items-center justify-center text-primary">
            <Sparkles size={16} />
          </div>
          <div>
            <span class="text-xs font-semibold text-white/80 block leading-tight">{APP_NAME}</span>
            <div class="flex items-center gap-1.5 mt-0.5">
              <span class="text-[11px] text-neutral-400">Текущая: v{APP_VERSION}</span>
              <span class="text-neutral-500 text-[10px]">→</span>
              <span class="text-[11px] font-bold text-primary tnum">Новая: v{$updateInfo.version}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          class="p-1.5 rounded-lg text-white/50 hover:text-white hover:bg-white/10 transition-colors"
          aria-label="Закрыть"
          title="Закрыть"
          on:click={dismissStartupModal}
        >
          <X size={16} />
        </button>
      </div>

      <!-- Заголовок и пояснение -->
      <div>
        <h2 id="update-dialog-title" class="text-lg font-bold text-white tracking-tight">
          Доступна новая версия v{$updateInfo.version}
        </h2>
        <p class="text-xs text-neutral-300 mt-1 leading-relaxed">
          {#if $updateInfo.releaseName && $updateInfo.releaseName !== `Релиз v${$updateInfo.version}`}
            {$updateInfo.releaseName}
          {:else}
            Вышло обновление приложения с новыми возможностями и исправлениями.
          {/if}
        </p>
      </div>

      <!-- Список изменений из релиза -->
      {#if $updateInfo.releaseNotes}
        <div class="max-h-40 overflow-y-auto rounded-xl bg-white/[0.04] border border-white/[0.06] p-3 text-xs text-neutral-300 leading-relaxed font-sans space-y-1.5 scrollbar-thin">
          <div class="flex items-center gap-1.5 text-neutral-400 font-medium mb-1">
            <FileText size={12} />
            <span>Что нового:</span>
          </div>
          <div class="whitespace-pre-wrap">{$updateInfo.releaseNotes}</div>
        </div>
      {/if}

      <!-- Статус загрузки -->
      {#if $updateStatus === 'downloading'}
        <div class="space-y-1.5">
          <div class="flex items-center justify-between text-xs text-neutral-300">
            <span class="flex items-center gap-1.5">
              <Loader2 size={13} class="animate-spin text-primary" />
              <span>Загрузка установщика...</span>
            </span>
            <span class="tnum font-medium text-white">
              {$downloadProgress.percent}% ({formatBytes($downloadProgress.downloaded)})
            </span>
          </div>
          <div class="w-full h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div
              class="h-full bg-primary transition-all duration-150 rounded-full"
              style="width: {$downloadProgress.percent}%"
            ></div>
          </div>
        </div>
      {:else if $updateStatus === 'ready'}
        <div class="flex items-center gap-2 p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs">
          <Check size={15} strokeWidth={2.6} />
          <span>Обновление загружено и готово к установке.</span>
        </div>
      {/if}

      <!-- Кнопки действий -->
      <div class="flex items-center justify-between pt-2 border-t border-white/[0.08] gap-3">
        <button
          type="button"
          class="px-4 py-2 rounded-xl text-xs font-medium text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors"
          on:click={dismissStartupModal}
        >
          Позже
        </button>

        {#if $updateStatus === 'ready'}
          <button
            type="button"
            class="px-5 py-2 rounded-xl bg-primary text-black font-semibold text-xs hover:brightness-110 active:scale-97 transition-all shadow-lg flex items-center gap-2"
            on:click={handleUpdateClick}
          >
            <Check size={14} strokeWidth={2.6} />
            <span>Установить и перезапустить</span>
          </button>
        {:else if $updateStatus === 'downloading'}
          <button
            type="button"
            disabled
            class="px-5 py-2 rounded-xl bg-primary/40 text-black/60 font-semibold text-xs flex items-center gap-2 cursor-not-allowed"
          >
            <Loader2 size={14} class="animate-spin" />
            <span>Загрузка ({$downloadProgress.percent}%)...</span>
          </button>
        {:else}
          <button
            type="button"
            class="px-5 py-2 rounded-xl bg-primary text-black font-semibold text-xs hover:brightness-110 active:scale-97 transition-all shadow-lg flex items-center gap-2"
            on:click={handleUpdateClick}
          >
            <Download size={14} strokeWidth={2.4} />
            <span>Обновить сейчас</span>
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
