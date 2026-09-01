<script lang="ts">
  import { onMount } from 'svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import {
    authorizeSpotify,
    disconnectSpotify,
    getSpotifyProfile,
    hasSpotifySession,
    importSpotifyBackupFiles,
    importSpotifySources,
    listSpotifyImportSources,
    SPOTIFY_DASHBOARD_URL,
    SPOTIFY_PRIVACY_URL,
    SPOTIFY_REDIRECT_SETUP,
    type SpotifyImportProgress,
    type SpotifyImportResult,
    type SpotifyImportSource,
    type SpotifyProfile
  } from '$lib/spotify';
  import { notify, settings } from '$lib/stores';
  import {
    Check,
    CircleAlert,
    Copy,
    ExternalLink,
    FileJson,
    Heart,
    Link2,
    ListMusic,
    Loader2,
    RefreshCw,
    ShieldCheck,
    Upload,
    X
  } from 'lucide-svelte';
  import MusicServiceIcon from './MusicServiceIcon.svelte';

  let clientId = '';
  let authLoading = false;
  let sourcesLoading = false;
  let importerOpen = false;
  let sources: SpotifyImportSource[] = [];
  let selected = new Set<string>();
  let errorMessage = '';
  let progress: SpotifyImportProgress | null = null;
  let result: SpotifyImportResult | null = null;
  let abortController: AbortController | null = null;
  let backupOpen = false;
  let backupFiles: File[] = [];
  let backupProgress: SpotifyImportProgress | null = null;
  let backupResult: SpotifyImportResult | null = null;
  let backupError = '';
  let backupAbortController: AbortController | null = null;

  $: profile = ($settings.spotifyUser || null) as SpotifyProfile | null;
  $: connected = Boolean(profile && hasSpotifySession($settings.spotifyClientId));
  $: importableSources = sources.filter((source) => source.importable);
  $: selectableSources = importableSources.filter((source) => source.total > 0);
  $: selectedSources = importableSources.filter((source) => selected.has(source.id));
  $: progressRatio = progress?.total ? Math.min(1, progress.current / progress.total) : 0;
  $: isImporting = Boolean(progress && progress.phase !== 'done');
  $: backupProgressRatio = backupProgress?.total
    ? Math.min(1, backupProgress.current / backupProgress.total)
    : 0;
  $: isBackupImporting = Boolean(backupProgress && backupProgress.phase !== 'done');

  onMount(() => {
    clientId = $settings.spotifyClientId || '';
    if ($settings.spotifyClientId && hasSpotifySession($settings.spotifyClientId) && !profile) {
      void restoreProfile();
    }
  });

  async function openExternal(url: string) {
    try {
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) await openUrl(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.warn('[spotify-import] external link failed', error);
      notify('Не удалось открыть страницу Spotify. Попробуй ещё раз.', 'error');
    }
  }

  async function copyRedirect() {
    try {
      await navigator.clipboard.writeText(SPOTIFY_REDIRECT_SETUP);
      notify('Адрес перенаправления скопирован.', 'success');
    } catch {
      notify(`Не удалось скопировать автоматически. Скопируй адрес вручную: ${SPOTIFY_REDIRECT_SETUP}`, 'info');
    }
  }

  async function restoreProfile() {
    authLoading = true;
    errorMessage = '';
    try {
      const restored = await getSpotifyProfile($settings.spotifyClientId);
      $settings.spotifyUser = restored;
    } catch (error: any) {
      disconnectSpotify();
      $settings.spotifyUser = null;
      errorMessage = error?.message || 'Нужно заново подключить Spotify';
    } finally {
      authLoading = false;
    }
  }

  async function connect() {
    if (authLoading) return;
    authLoading = true;
    errorMessage = '';
    result = null;
    try {
      const cleanClientId = clientId.trim();
      const spotifyProfile = await authorizeSpotify(cleanClientId);
      $settings.spotifyClientId = cleanClientId;
      $settings.spotifyUser = spotifyProfile;
      notify(`Spotify подключён: ${spotifyProfile.displayName}.`, 'success');
      importerOpen = true;
      await loadSources();
    } catch (error: any) {
      errorMessage = error?.message || 'Не удалось подключить Spotify';
      notify(errorMessage, 'error');
    } finally {
      authLoading = false;
    }
  }

  function unlink() {
    if (!confirm('Отвязать Spotify? Уже импортированные треки и плейлисты останутся.')) return;
    disconnectSpotify();
    $settings.spotifyUser = null;
    sources = [];
    selected = new Set();
    importerOpen = false;
    progress = null;
    result = null;
    notify('Spotify отключён.', 'info');
  }

  async function toggleImporter() {
    importerOpen = !importerOpen;
    errorMessage = '';
    result = null;
    if (importerOpen && sources.length === 0) await loadSources();
  }

  async function loadSources() {
    if (!$settings.spotifyClientId || sourcesLoading) return;
    sourcesLoading = true;
    errorMessage = '';
    try {
      sources = await listSpotifyImportSources($settings.spotifyClientId, profile);
      selected = new Set(sources.filter((source) => source.importable && source.total > 0).map((source) => source.id));
      if (!sources.some((source) => source.total > 0)) {
        errorMessage = 'Spotify не вернул ни одного трека для импорта';
      }
    } catch (error: any) {
      errorMessage = error?.message || 'Не удалось получить медиатеку Spotify';
    } finally {
      sourcesLoading = false;
    }
  }

  function toggleSource(source: SpotifyImportSource) {
    if (!source.importable || isImporting) return;
    const next = new Set(selected);
    if (next.has(source.id)) next.delete(source.id);
    else next.add(source.id);
    selected = next;
  }

  function toggleAll() {
    selected = selectedSources.length === selectableSources.length
      ? new Set()
      : new Set(selectableSources.map((source) => source.id));
  }

  async function runImport() {
    if (!selectedSources.length || isImporting) return;
    errorMessage = '';
    result = null;
    abortController = new AbortController();
    progress = {
      phase: 'fetching',
      total: selectedSources.reduce((sum, source) => sum + source.total, 0),
      current: 0,
      matched: 0,
      skipped: 0,
      currentTrack: 'Подключаюсь к Spotify…'
    };
    try {
      result = await importSpotifySources(
        $settings.spotifyClientId,
        selectedSources,
        (next) => (progress = next),
        abortController.signal
      );
      notify(
        `Импорт завершён: найдено ${result.matched}, пропущено ${result.skipped}.`,
        result.matched ? 'success' : 'info'
      );
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        errorMessage = 'Импорт остановлен. Медиатека не изменена.';
      } else {
        errorMessage = error?.message || 'Не удалось завершить импорт из Spotify.';
        notify(errorMessage, 'error');
      }
      progress = null;
    } finally {
      abortController = null;
    }
  }

  function cancelImport() {
    abortController?.abort();
  }

  function chooseBackupFiles(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    backupFiles = Array.from(input.files || []);
    backupError = '';
    backupResult = null;
  }

  async function runBackupImport() {
    if (!backupFiles.length || isBackupImporting) return;
    backupError = '';
    backupResult = null;
    backupAbortController = new AbortController();
    backupProgress = {
      phase: 'fetching',
      total: backupFiles.length,
      current: 0,
      matched: 0,
      skipped: 0,
      currentTrack: 'Читаю архив Spotify…'
    };
    try {
      const files = await Promise.all(
        backupFiles.map(async (file) => ({ name: file.name, text: await file.text() }))
      );
      backupResult = await importSpotifyBackupFiles(
        files,
        (next) => (backupProgress = next),
        backupAbortController.signal
      );
      notify(
        `Архив Spotify импортирован: найдено ${backupResult.matched}, пропущено ${backupResult.skipped}.`,
        backupResult.matched ? 'success' : 'info'
      );
    } catch (error: any) {
      if (error?.name === 'AbortError') backupError = 'Импорт остановлен. Медиатека не изменена.';
      else {
        backupError = error?.message || 'Не удалось прочитать архив Spotify.';
        notify(backupError, 'error');
      }
      backupProgress = null;
    } finally {
      backupAbortController = null;
    }
  }

  function cancelBackupImport() {
    backupAbortController?.abort();
  }
</script>

<div class="spotify-import-card">
  <div class="spotify-import-head">
    <span class="spotify-import-mark" aria-hidden="true"><MusicServiceIcon service="spotify" size={25} /></span>
    <div>
      <span class="spotify-import-kicker">Перенос медиатеки</span>
      <h3>Импорт из Spotify</h3>
      <p>Заберу названия и найду playable-версии в Яндекс Музыке или SoundCloud.</p>
    </div>
    {#if connected}
      <span class="spotify-import-status"><Check size={14} aria-hidden="true" /> Подключён</span>
    {/if}
  </div>

  <div class="spotify-backup-import">
    <div class="spotify-backup-summary">
      <span class="spotify-backup-icon" aria-hidden="true"><ShieldCheck size={19} /></span>
      <div>
        <strong>Без Premium и Client ID</strong>
        <span>Импорт из официального архива Spotify. Файлы никуда не загружаются.</span>
      </div>
      <button type="button" class="spotify-backup-toggle" on:click={() => backupOpen = !backupOpen} disabled={isBackupImporting}>
        {backupOpen ? 'Скрыть' : 'Как импортировать'}
      </button>
    </div>

    {#if backupOpen}
      <div class="spotify-backup-body">
        <div class="spotify-backup-steps">
          <span><b>1</b><span>Открой страницу конфиденциальности Spotify и в разделе загрузки данных запроси пакет <strong>Account data</strong>.</span></span>
          <span><b>2</b><span>Дождись письма от Spotify, скачай ZIP и распакуй его обычным Проводником Windows.</span></span>
          <span><b>3</b><span>Ниже выбери <code>YourLibrary.json</code> и файлы <code>Playlist*.json</code>. Можно выбрать несколько сразу.</span></span>
          <span><b>4</b><span>Lomify возьмёт только названия и артистов, затем найдёт версии в Яндекс Музыке или SoundCloud.</span></span>
        </div>

        <div class="spotify-backup-actions">
          <button type="button" on:click={() => openExternal(SPOTIFY_PRIVACY_URL)}>
            Открыть данные Spotify <ExternalLink size={14} aria-hidden="true" />
          </button>
          <label class="spotify-backup-picker">
            <Upload size={15} aria-hidden="true" />
            <span>{backupFiles.length ? `Выбрано файлов: ${backupFiles.length}` : 'Выбрать JSON-файлы'}</span>
            <input type="file" accept=".json,application/json" multiple on:change={chooseBackupFiles} disabled={isBackupImporting} />
          </label>
        </div>

        {#if backupFiles.length}
          <div class="spotify-backup-files" aria-label="Выбранные файлы Spotify">
            {#each backupFiles as file}
              <span><FileJson size={13} aria-hidden="true" /> {file.name}</span>
            {/each}
          </div>
        {/if}

        {#if backupProgress}
          <div class="spotify-progress" aria-live="polite">
            <div class="spotify-progress-head">
              <strong>
                {backupProgress.phase === 'fetching' ? 'Читаю файлы' : backupProgress.phase === 'matching' ? 'Ищу совпадения' : backupProgress.phase === 'saving' ? 'Сохраняю' : 'Готово'}
              </strong>
              <span class="tnum">{backupProgress.current}/{backupProgress.total}</span>
            </div>
            <div class="spotify-progress-track" aria-hidden="true">
              <span style={`--spotify-progress: ${backupProgressRatio}`}></span>
            </div>
            <p title={backupProgress.currentTrack}>{backupProgress.currentTrack || 'Медиатека обновлена'}</p>
            <div class="spotify-progress-counts">
              <span><Check size={13} aria-hidden="true" /> Найдено {backupProgress.matched}</span>
              <span><X size={13} aria-hidden="true" /> Пропущено {backupProgress.skipped}</span>
            </div>
          </div>
        {/if}

        {#if backupResult}
          <div class="spotify-import-result" role="status">
            <Check size={18} aria-hidden="true" />
            <div>
              <strong>Архив импортирован</strong>
              <span>В любимые добавлено {backupResult.likedAdded}; плейлистов обновлено {backupResult.playlistsImported}.</span>
            </div>
          </div>
        {/if}

        {#if backupError}
          <div class="spotify-import-error" role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            <span>{backupError}</span>
          </div>
        {/if}

        <div class="spotify-backup-footer">
          <p>Premium нужен только Spotify Web API. Официальный архив доступен обычному аккаунту и обрабатывается локально.</p>
          {#if isBackupImporting}
            <button type="button" class="is-danger" on:click={cancelBackupImport}>Остановить</button>
          {:else}
            <button type="button" class="is-primary" on:click={runBackupImport} disabled={!backupFiles.length}>
              <Upload size={15} aria-hidden="true" /> Импортировать архив
            </button>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  {#if connected && profile}
    <div class="spotify-account-row">
      <div class="spotify-account-identity">
        <span class="spotify-account-avatar">
          {#if profile.avatarUrl}
            <img src={profile.avatarUrl} alt="" />
          {:else}
            <MusicServiceIcon service="spotify" size={21} />
          {/if}
        </span>
        <div>
          <strong>{profile.displayName}</strong>
          <span>Доступ только на чтение</span>
        </div>
      </div>
      <div class="spotify-account-actions">
        <button type="button" class="is-primary" on:click={toggleImporter} disabled={isImporting}>
          <ListMusic size={16} aria-hidden="true" />
          {importerOpen ? 'Скрыть выбор' : 'Выбрать музыку'}
        </button>
        <button type="button" on:click={unlink} disabled={isImporting}>Отвязать</button>
      </div>
    </div>

    {#if importerOpen}
      <div class="spotify-import-workspace">
        <div class="spotify-import-toolbar">
          <div>
            <strong>Что переносим</strong>
            <span>Чужие подписки отмечены отдельно: Spotify больше не отдаёт их содержимое.</span>
          </div>
          <button type="button" on:click={toggleAll} disabled={sourcesLoading || isImporting || !importableSources.length}>
            {selectedSources.length === selectableSources.length && selectableSources.length
              ? 'Снять выбор'
              : 'Выбрать всё'}
          </button>
        </div>

        {#if sourcesLoading}
          <div class="spotify-import-loading" role="status">
            <Loader2 size={20} class="animate-spin" aria-hidden="true" />
            Читаю медиатеку Spotify…
          </div>
        {:else if sources.length}
          <div class="spotify-source-list" aria-label="Разделы Spotify для импорта">
            {#each sources as source}
              <div class="spotify-source-row" class:disabled={!source.importable || source.total === 0} class:selected={selected.has(source.id)}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.has(source.id)}
                    disabled={!source.importable || source.total === 0 || isImporting}
                    on:change={() => toggleSource(source)}
                  />
                  <span class="spotify-source-icon" aria-hidden="true">
                    {#if source.kind === 'saved'}<Heart size={17} />{:else}<ListMusic size={17} />{/if}
                  </span>
                  <span class="spotify-source-copy">
                    <strong>{source.name}</strong>
                    <span>
                      {source.total} треков{source.kind === 'playlist' ? ` · ${source.owner}` : ''}
                    </span>
                    {#if source.unavailableReason}<small>{source.unavailableReason}</small>{/if}
                  </span>
                </label>
                {#if source.externalUrl}
                  <button
                    type="button"
                    aria-label={`Открыть ${source.name} в Spotify`}
                    title="Открыть в Spotify"
                    on:click={() => openExternal(source.externalUrl)}
                  >
                    <ExternalLink size={15} aria-hidden="true" />
                  </button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}

        {#if progress}
          <div class="spotify-progress" aria-live="polite">
            <div class="spotify-progress-head">
              <strong>
                {progress.phase === 'fetching' ? 'Читаю Spotify' : progress.phase === 'matching' ? 'Ищу совпадения' : progress.phase === 'saving' ? 'Сохраняю' : 'Готово'}
              </strong>
              <span class="tnum">{progress.current}/{progress.total}</span>
            </div>
            <div class="spotify-progress-track" aria-hidden="true">
              <span style={`--spotify-progress: ${progressRatio}`}></span>
            </div>
            <p title={progress.currentTrack}>{progress.currentTrack || 'Медиатека обновлена'}</p>
            <div class="spotify-progress-counts">
              <span><Check size={13} aria-hidden="true" /> Найдено {progress.matched}</span>
              <span><X size={13} aria-hidden="true" /> Пропущено {progress.skipped}</span>
            </div>
          </div>
        {/if}

        {#if result}
          <div class="spotify-import-result" role="status">
            <Check size={18} aria-hidden="true" />
            <div>
              <strong>Импорт завершён</strong>
              <span>В любимые добавлено {result.likedAdded}; плейлистов обновлено {result.playlistsImported}.</span>
            </div>
          </div>
        {/if}

        {#if errorMessage}
          <div class="spotify-import-error" role="alert">
            <CircleAlert size={18} aria-hidden="true" />
            <span>{errorMessage}</span>
            {#if !isImporting && connected}
              <button type="button" on:click={sources.length ? runImport : loadSources}>
                <RefreshCw size={14} aria-hidden="true" /> Повторить
              </button>
            {/if}
          </div>
        {/if}

        <div class="spotify-import-footer">
          <p>Spotify-аудио не скачивается: импортируются только метаданные, а звук ищется в подключённых источниках.</p>
          {#if isImporting}
            <button type="button" class="is-danger" on:click={cancelImport}>Остановить</button>
          {:else}
            <button type="button" class="is-primary" on:click={runImport} disabled={!selectedSources.length || sourcesLoading}>
              <Link2 size={16} aria-hidden="true" />
              Импортировать {selectedSources.length || ''}
            </button>
          {/if}
        </div>
      </div>
    {/if}
  {:else}
    <div class="spotify-setup">
      <div class="spotify-setup-steps">
        <span><b>1</b> Создай приложение с Web API в Spotify Dashboard.</span>
        <span><b>2</b> Добавь Redirect URI точно как показано:</span>
        <div class="spotify-redirect-copy">
          <code>{SPOTIFY_REDIRECT_SETUP}</code>
          <button type="button" on:click={copyRedirect} aria-label="Скопировать Redirect URI" title="Скопировать">
            <Copy size={15} aria-hidden="true" />
          </button>
        </div>
        <span><b>3</b> Вставь Client ID. Client Secret не нужен и нигде не хранится.</span>
      </div>

      <button type="button" class="spotify-dashboard-link" on:click={() => openExternal(SPOTIFY_DASHBOARD_URL)}>
        Открыть Spotify Dashboard <ExternalLink size={14} aria-hidden="true" />
      </button>

      <label for="spotify-client-id">Client ID</label>
      <div class="spotify-client-field">
        <Link2 size={17} aria-hidden="true" />
        <input
          id="spotify-client-id"
          type="text"
          bind:value={clientId}
          placeholder="32-символьный Client ID"
          autocomplete="off"
          spellcheck="false"
          disabled={authLoading}
        />
        <button type="button" class="is-primary" on:click={connect} disabled={authLoading || !clientId.trim()}>
          {#if authLoading}<Loader2 size={17} class="animate-spin" aria-hidden="true" />{:else}<Link2 size={17} aria-hidden="true" />{/if}
          {authLoading ? 'Жду вход…' : 'Подключить'}
        </button>
      </div>
      <p class="spotify-setup-note">
        С марта 2026 года Spotify требует Premium у владельца Development Mode-приложения
        и разрешает до пяти пользователей. Если Premium нет, используй импорт архива выше.
      </p>

      {#if errorMessage}
        <div class="spotify-import-error" role="alert">
          <CircleAlert size={18} aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      {/if}
    </div>
  {/if}
</div>
