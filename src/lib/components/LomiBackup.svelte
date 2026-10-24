<script lang="ts">
  import { Download, Upload, FileCheck, Loader2 } from 'lucide-svelte';
  import { captureLomiBackup, saveLomiBackup, restoreLomiBackup } from '$lib/lomiBackup';
  import { parseLomiBackup, LOMI_MAX_BYTES, type LomiBackup } from '$lib/lomiBackupCore';
  import { currentView, notify } from '$lib/stores';
  let preview = $state.raw<LomiBackup | null>(null);
  let busy = $state(false);
  let message = $state('');
  let error = $state('');
  let replaceConfirmed = $state(false);
  async function exportBackup() {
    busy = true; error = ''; message = 'Собираем медиатеку и статистику…';
    try { const saved = await saveLomiBackup(await captureLomiBackup()); message = saved ? 'Копия .lomi сохранена.' : 'Сохранение отменено.'; }
    catch (cause) { error = cause instanceof Error ? cause.message : 'Не удалось сохранить копию. Повтори действие.'; message = ''; }
    finally { busy = false; }
  }
  async function selectFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    if (!file) return;
    preview = null; replaceConfirmed = false; error = ''; message = ''; busy = true;
    try {
      if (!file.name.toLowerCase().endsWith('.lomi')) throw new Error('Выбери резервную копию с расширением .lomi.');
      if (file.size > LOMI_MAX_BYTES) throw new Error('Файл больше 64 МБ.');
      preview = parseLomiBackup(await file.text());
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Не удалось прочитать файл.'; }
    finally { busy = false; }
  }
  async function restore() {
    if (!preview || !replaceConfirmed || busy) return;
    busy = true; error = ''; message = 'Сначала сохраняем текущие данные отдельной копией…';
    try {
      if (!await saveLomiBackup(await captureLomiBackup(), true)) { message = 'Восстановление отменено. Данные не изменены.'; return; }
      message = 'Восстанавливаем данные. Дожидаемся завершения текущей синхронизации…';
      await restoreLomiBackup(preview);
      preview = null; replaceConfirmed = false;
      message = 'Данные восстановлены. Автосинхронизация лайков и плейлистов приостановлена; её можно включить в Подключениях.';
      notify(message, 'success');
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Не удалось восстановить копию.'; message = ''; }
    finally { busy = false; }
  }
</script>
<article class="plate backup-card" aria-labelledby="lomi-backup-title" aria-busy={busy}>
  <header><span class="backup-icon"><FileCheck size={21} aria-hidden="true" /></span><div><h3 id="lomi-backup-title" class="section-title">Резервная копия .lomi</h3><p>Вся твоя медиатека, часы, достижения, оформление и профили звука в одном файле.</p></div></header>
  <p class="backup-note">Сохрани копию на компьютер, флешку или в своё облако. Для переноса открой здесь Выбрать .lomi на другом компьютере. Подключения сервисов и сами аудиофайлы в копию не входят. Для локальной музыки сохраняются только названия и пути к файлам.</p>
  <div class="backup-actions"><button type="button" class="glass-button" onclick={exportBackup} disabled={busy}>{#if busy}<Loader2 size={15} class="animate-spin" />{:else}<Download size={15} />{/if}Сохранить .lomi</button><label class="backup-file"><Upload size={15} aria-hidden="true" /><span>Выбрать .lomi</span><input type="file" accept=".lomi" aria-label="Выбрать резервную копию .lomi" disabled={busy} onchange={selectFile} /></label></div>
  {#if preview}
    <section class="backup-preview" aria-label="Содержимое резервной копии">
      <strong>Копия от {new Date(preview.createdAt).toLocaleString('ru-RU')}</strong><p>Lomify {preview.appVersion}</p>
      <dl><div><dt>Любимых треков</dt><dd>{preview.data.likes.length}</dd></div><div><dt>Плейлистов</dt><dd>{preview.data.playlists.length}</dd></div><div><dt>Музыка играла</dt><dd>{Math.floor(preview.data.stats.listenSeconds / 3600)} ч {Math.floor(preview.data.stats.listenSeconds % 3600 / 60)} мин</dd></div><div><dt>Открытых достижений</dt><dd>{Object.keys(preview.data.achievements).length}</dd></div><div><dt>Локальных записей</dt><dd>{preview.data.localTracks.length}</dd></div></dl>
      <p class="backup-note">Текущие лайки, плейлисты, история, достижения и настройки оформления будут заменены этой копией. Сначала предложим сохранить текущие данные в отдельный .lomi. Локальные песни на другом компьютере могут потребовать повторного добавления.</p>
      <label class="backup-confirm"><input type="checkbox" bind:checked={replaceConfirmed} disabled={busy} />Заменить текущие данные выбранной копией</label>
      <div class="backup-actions"><button type="button" class="glass-button" disabled={busy || !replaceConfirmed} onclick={restore}>Восстановить копию</button><button type="button" class="glass-button" disabled={busy} onclick={() => { preview = null; replaceConfirmed = false; }}>Отмена</button></div>
    </section>
  {/if}
  {#if error}<p class="backup-error" role="alert">{error}</p>{/if}
  {#if message}<p class="backup-note" role="status">{message}</p>{/if}
  {#if message.startsWith('Данные восстановлены')}<button type="button" class="glass-button" onclick={() => currentView.set('profile')}>Открыть профиль и достижения</button>{/if}
</article>
<style>
  .backup-card { padding:24px; }
  header { display:flex; align-items:flex-start; gap:12px; } header > div { min-width:0; }
  .backup-icon { width:40px; height:40px; display:grid; place-items:center; flex-shrink:0; border-radius:12px; background:#ffffff08; color:var(--color-primary); }
  header p, .backup-note { font-size:12px; line-height:1.65; color:#b5afbd; margin-top:8px; overflow-wrap:anywhere; }
  .backup-actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:16px; }
  button, .backup-file { display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:10px 14px; font-size:12px; border-radius:10px; }
  .backup-file { position:relative; overflow:hidden; background:#ffffff08; border:1px solid #ffffff24; cursor:pointer; }
  .backup-file:has(input:disabled) { opacity:.4; cursor:default; }
  .backup-file:has(input:focus-visible) { outline:2px solid var(--color-primary); outline-offset:3px; }
  .backup-file input { position:absolute; inset:0; opacity:0; cursor:inherit; width:100%; height:100%; }
  .backup-preview { border:1px solid #ffffff24; border-radius:12px; padding:16px; margin-top:18px; }
  .backup-preview > strong { font-size:13px; } .backup-preview > p { font-size:12px; color:#b5afbd; }
  dl { display:grid; gap:7px; font-size:12px; margin-block:14px; } dl div { display:flex; gap:12px; justify-content:space-between; } dd { font-variant-numeric:tabular-nums; }
  .backup-confirm { display:flex; align-items:flex-start; gap:9px; font-size:12px; margin-top:16px; line-height:1.5; } .backup-confirm input { margin-top:3px; accent-color:var(--color-primary); }
  .backup-error { color:#ffb0b8; font-size:12px; line-height:1.6; margin-top:14px; }
</style>
