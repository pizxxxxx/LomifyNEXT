<script lang="ts">
  import { onDestroy } from 'svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { Check, ExternalLink, Loader2, Music, Upload } from 'lucide-svelte';
  import { loadAppleMusicPlaylist } from '$lib/appleMusicImport';
  import { APPLE_MUSIC_MAX_FILE_BYTES, APPLE_MUSIC_WEB_URL, parseAppleMusicXml } from '$lib/appleMusicImportCore';
  import { importMusicCollections, type MusicImportCollection, type MusicImportProgress, type MusicImportResult } from '$lib/musicImport';
  import { activeLibraryTab, currentView, notify } from '$lib/stores';

  let playlistUrl = $state('');
  let collections = $state.raw<MusicImportCollection[]>([]);
  let selected = $state<Record<string, boolean>>({});
  let working = $state(false);
  let progress = $state.raw<MusicImportProgress | null>(null);
  let result = $state.raw<MusicImportResult | null>(null);
  let message = $state('');
  let controller: AbortController | null = null;
  let alive = true;
  const key = (collection: MusicImportCollection) => `${collection.kind}:${collection.id}`;
  const chosen = $derived(collections.filter(collection => selected[key(collection)]));
  const chosenCount = $derived(chosen.reduce((sum, collection) => sum + collection.tracks.length, 0));
  const saving = $derived(progress?.phase === 'saving');
  const phase = $derived(progress?.phase === 'matching' ? 'Ищу совпадения'
    : saving ? 'Сохраняю на этом компьютере' : progress?.phase === 'done' ? 'Готово' : 'Читаю плейлист');

  onDestroy(() => { alive = false; if (!saving) controller?.abort(); });

  function resetPreview() {
    collections = []; selected = {}; result = null; progress = null; message = '';
  }

  function stage(next: MusicImportCollection[]) {
    collections = next;
    selected = Object.fromEntries(next.map(collection => [key(collection), true]));
    if (!next.some(collection => collection.tracks.length)) message = 'В плейлисте нет доступных треков. Выбери другой плейлист.';
  }

  async function readLink(event: SubmitEvent) {
    event.preventDefault();
    if (working) return;
    resetPreview(); working = true;
    controller = new AbortController();
    try {
      const collection = await loadAppleMusicPlaylist(playlistUrl, controller.signal);
      if (alive) stage([collection]);
    } catch (error) {
      if (alive) message = error instanceof DOMException && error.name === 'AbortError' ? 'Чтение остановлено.'
        : error instanceof Error ? error.message : 'Не получилось прочитать плейлист. Повтори попытку или выбери XML-файл.';
    } finally { if (alive) working = false; controller = null; }
  }

  async function readFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || working) return;
    resetPreview(); working = true;
    controller = new AbortController();
    try {
      if (file.size > APPLE_MUSIC_MAX_FILE_BYTES) throw new Error('Выбери XML-файл размером до 20 МБ.');
      const content = await file.text();
      if (controller.signal.aborted) throw new DOMException('Чтение остановлено', 'AbortError');
      if (alive) stage(parseAppleMusicXml(content, file.name));
    } catch (error) {
      if (alive) message = error instanceof Error ? error.message : 'Не получилось прочитать файл. Повтори экспорт плейлиста.';
    } finally { if (alive) working = false; controller = null; input.value = ''; }
  }

  async function runImport() {
    if (working || !chosenCount) return;
    working = true; message = ''; result = null;
    controller = new AbortController();
    try {
      const imported = await importMusicCollections(chosen, value => { if (alive) progress = value; }, controller.signal);
      if (alive) {
        result = imported;
        notify(`Apple Music: найдено ${imported.matched} из ${imported.total}, не найдено ${imported.skipped}.`, imported.matched ? 'success' : 'info');
      }
    } catch (error) {
      if (alive) {
        message = error instanceof DOMException && error.name === 'AbortError'
          ? 'Импорт остановлен до сохранения. Медиатека не изменена.'
          : 'Не удалось завершить импорт. Проверь соединение и свободное место, затем повтори попытку.';
        progress = null;
      }
    } finally { if (alive) working = false; controller = null; }
  }

  async function openAppleMusic() {
    const url = collections.find(collection => collection.originUrl)?.originUrl || APPLE_MUSIC_WEB_URL;
    try {
      if ('__TAURI_INTERNALS__' in window) await openUrl(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    } catch { message = 'Не получилось открыть браузер. Открой music.apple.com вручную.'; }
  }

  async function copyUnmatched() {
    if (!result?.unmatched.length) return;
    try {
      await navigator.clipboard.writeText(result.unmatched.map(track => `${track.artists.join(', ')} - ${track.title}`).join('\n'));
      notify('Список ненайденных треков скопирован.', 'success');
    } catch { message = 'Не получилось скопировать список. Выдели названия в списке ниже и скопируй их вручную.'; }
  }

  function openLibrary() {
    activeLibraryTab.set(result?.playlistsImported ? 'playlists' : 'liked');
    currentView.set('library');
  }
</script>

<section class="provider-import-card apple-import" aria-labelledby="apple-import-title">
  <div class="provider-import-head">
    <span class="provider-import-mark" aria-hidden="true"><Music size={25} /></span>
    <div>
      <span class="provider-import-kicker">Без аккаунта разработчика</span>
      <h3 id="apple-import-title">Apple Music</h3>
      <p>Перенеси плейлисты в Lomify или слушай Apple Music в браузере с обычной подпиской.</p>
    </div>
  </div>
  <div class="provider-import-body">
    <form onsubmit={readLink}>
      <label for="apple-playlist-url">Ссылка на публичный плейлист Apple Music</label>
      <div class="provider-import-field">
        <ExternalLink size={16} aria-hidden="true" />
        <input id="apple-playlist-url" type="url" bind:value={playlistUrl} placeholder="https://music.apple.com/ru/playlist/…/pl.…"
          autocomplete="off" spellcheck="false" disabled={working} oninput={resetPreview} aria-describedby="apple-link-help" required />
        <button type="submit" class="is-secondary" disabled={working || !playlistUrl.trim()}>
          {#if working && !progress}<Loader2 size={15} aria-hidden="true" />{/if}
          Прочитать плейлист
        </button>
      </div>
      <p id="apple-link-help" class="provider-import-note">В Apple Music открой плейлист, нажми Поделиться, затем Скопировать ссылку. Вставь её выше и нажми Прочитать плейлист.</p>
    </form>

    <details class="apple-file">
      <summary>Импорт из XML-файла</summary>
      <ol>
        <li>В Music на Mac или iTunes на ПК выбери плейлист.</li>
        <li>Открой Файл, затем Медиатека и Экспортировать плейлист. В поле Формат выбери XML и сохрани файл.</li>
        <li>Выбери этот файл ниже. Lomify покажет списки перед переносом.</li>
      </ol>
      <label for="apple-playlist-file">XML-файл плейлиста или медиатеки, до 20 МБ</label>
      <input id="apple-playlist-file" type="file" accept=".xml,.plist,application/xml,text/xml" disabled={working} onchange={readFile} />
      <p class="provider-import-note">Файл обрабатывается на этом компьютере. Для поиска совпадений в Яндекс Музыку или SoundCloud отправляются только названия и артисты.</p>
    </details>

    {#if collections.length}
      <fieldset class="apple-selection" disabled={working}>
        <legend>Что перенести</legend>
        {#each collections as collection (key(collection))}
          <label class="apple-choice">
            <input type="checkbox" bind:checked={selected[key(collection)]} />
            <span>{collection.name}<small>{collection.kind === 'liked' ? 'В любимые' : 'Плейлист'} · Треков: {collection.tracks.length}{#if collection.sourceSkipped} · Не прочитаны из файла: {collection.sourceSkipped}{/if}</small></span>
          </label>
        {/each}
      </fieldset>
      <p class="provider-import-note">В Lomify будут играть найденные версии из Яндекс Музыки или SoundCloud. Треки, которым не найдётся подходящей версии, попадут в отдельный список.</p>
      <div class="provider-account-actions">
        <button type="button" class="is-primary" onclick={runImport} disabled={working || !chosenCount}>
          <Upload size={15} aria-hidden="true" /> Перенести в Lomify{chosenCount ? ` (${chosenCount})` : ''}
        </button>
        {#if working && !saving}<button type="button" class="is-danger" onclick={() => controller?.abort()}>Остановить</button>{/if}
      </div>
    {:else if working}
      <div class="provider-account-actions"><button type="button" class="is-danger" onclick={() => controller?.abort()}>Остановить</button></div>
    {/if}

    {#if progress}
      <div class="apple-progress" role="status" aria-live="polite">
        <span>{phase}</span>
        <progress max={progress.total || 1} value={progress.current} aria-label={phase}></progress>
        <span class="tnum">{progress.current}/{progress.total} · Найдено: {progress.matched} · Не найдено: {progress.skipped}</span>
        {#if progress.currentTrack}<small>{progress.currentTrack}</small>{/if}
      </div>
    {/if}
    {#if result}
      <div class="apple-result" role="status">
        <strong>{#if result.matched}<Check size={16} aria-hidden="true" /> Перенос завершён{:else}Подходящих совпадений пока нет{/if}</strong>
        <span>Плейлистов создано или обновлено: {result.playlistsImported}. В любимые добавлено: {result.likedAdded}.</span>
        {#if result.matched}<div class="provider-account-actions"><button type="button" class="is-secondary" onclick={openLibrary}>Открыть медиатеку</button></div>{/if}
      </div>
      {#if result.unmatched.length}
        <details class="apple-unmatched">
          <summary>Не найдены: {result.unmatched.length}</summary>
          <div class="provider-account-actions"><button type="button" class="is-secondary" onclick={copyUnmatched}>Скопировать весь список</button></div>
          <ul>{#each result.unmatched.slice(0, 30) as track, index (`${track.id}:${index}`)}<li>{track.artists.join(', ')} - {track.title}</li>{/each}</ul>
          {#if result.unmatched.length > 30}<p class="provider-import-note">Показаны первые 30. Кнопка копирования сохраняет весь список.</p>{/if}
        </details>
      {/if}
    {/if}
    {#if message}<p class="apple-message" role="alert">{message}</p>{/if}

    <div class="apple-web">
      <strong>Слушать непосредственно в Apple Music</strong>
      <p class="provider-import-note">Нажми Открыть Apple Music, войди в браузере в аккаунт с подпиской, выбери трек и нажми воспроизведение. Музыкой в этом режиме управляет веб-плеер Apple, отдельно от плеера Lomify.</p>
      <div class="provider-account-actions"><button type="button" class="is-secondary" onclick={openAppleMusic}>Открыть Apple Music <ExternalLink size={14} aria-hidden="true" /></button></div>
    </div>
  </div>
</section>

<style>
  form > label, .apple-file > label { display: block; margin-bottom: 8px; font-size: 13px; }
  .apple-file, .apple-unmatched, .apple-selection, .apple-web { margin-top: 20px; }
  summary { width: fit-content; cursor: pointer; font-size: 13px; }
  ol, ul { padding-left: 20px; font-size: 13px; line-height: 1.6; margin: 12px 0; }
  ol { list-style: decimal; }
  ul { list-style: disc; }
  li { overflow-wrap: anywhere; }
  input[type='file'] { max-width: 100%; font-size: 12px; }
  .apple-selection { border: 0; padding: 0; min-width: 0; }
  legend { font-size: 13px; font-weight: 600; margin-bottom: 10px; }
  .apple-choice { display: flex; align-items: center; gap: 10px; margin: 10px 0; cursor: pointer; }
  .apple-choice input { flex: 0 0 auto; accent-color: var(--color-primary); }
  .apple-choice span { min-width: 0; overflow-wrap: anywhere; font-size: 13px; }
  .apple-choice small { display: block; color: var(--color-text-muted, #aaa); font-size: 12px; margin-top: 3px; }
  .apple-progress, .apple-result { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; font-size: 13px; }
  .apple-progress progress { width: 100%; height: 8px; accent-color: var(--color-primary); }
  .apple-progress small { overflow-wrap: anywhere; }
  .apple-result strong { display: flex; align-items: center; gap: 8px; }
  .apple-message { margin-top: 14px; font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
  .apple-web { padding-top: 18px; border-top: 1px solid rgb(255 255 255 / .08); }
  .apple-web > strong { font-size: 13px; }
  .provider-account-actions { margin-top: 12px; }
</style>
