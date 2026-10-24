<script lang="ts">
  import { tick } from 'svelte';
  import { Cloud, Download, Upload, RefreshCw, LogOut, Loader2, Mail } from 'lucide-svelte';
  import GoogleMark from './GoogleMark.svelte';
  import { cloudProfile, cloudConfigured, cloudGoogleConfigured, cloudGoogleReady, cloudDesktopAvailable, cloudSignInGoogle, cloudSignIn, cloudResetPassword, cloudSignOut, cloudCheck, cloudPreview, cloudUpload, cloudRestore, cloudSetAuto } from '$lib/cloudProfile';
  let email = $state(''), password = $state(''), register = $state(false);
  let { welcome = false }: { welcome?: boolean } = $props();
  let emailVisible = $state(false);
  let emailInput = $state<HTMLInputElement>();
  let replaceCloud = $state(false), replaceLocal = $state(false);
  $effect(() => { $cloudProfile.head?.revision; replaceCloud = false; replaceLocal = false; });
  async function revealEmail(create = false) { register = create; emailVisible = true; await tick(); emailInput?.focus(); }
  async function submit(event: SubmitEvent) {
    event.preventDefault(); const supplied = password; password = '';
    await cloudSignIn(email, supplied, register);
  }
</script>
<article class="plate cloud-card" class:welcome-auth={welcome} aria-labelledby="cloud-title" aria-busy={$cloudProfile.busy}>
  <header><span class="cloud-icon"><Cloud size={22} aria-hidden="true" /></span><div><h3 id="cloud-title" class="section-title">Аккаунт Lomify</h3><p>Лайки, плейлисты, часы, достижения и оформление на другом компьютере.</p></div></header>
  {#if !cloudConfigured}
    <p class="note">Облако ещё не подключено. Файлы .lomi уже можно сохранять и переносить между компьютерами.</p>
  {:else if !$cloudProfile.ready}
    <p class="note" role="status">Проверяем сохранённый вход…</p>
  {:else if !$cloudProfile.email}
    <div class="actions google-action"><button type="button" class="google-button" disabled={$cloudProfile.busy || !cloudGoogleConfigured || !$cloudGoogleReady} onclick={cloudSignInGoogle}><GoogleMark />Войти через Google</button></div>
    {#if welcome && emailVisible}<div class="auth-divider"><span>или по почте</span></div>{/if}
    {#if !welcome || emailVisible}
    <form onsubmit={submit}>
      <div class="fields"><label>Почта<input type="email" bind:this={emailInput} bind:value={email} autocomplete="email" placeholder="name@example.com" required disabled={$cloudProfile.busy} /></label><label>Пароль<input type="password" bind:value={password} autocomplete={register ? 'new-password' : 'current-password'} minlength={register ? 6 : undefined} required disabled={$cloudProfile.busy} /></label></div>
      <div class="actions"><button type="submit" class="glass-button" disabled={$cloudProfile.busy}>{#if $cloudProfile.busy}<Loader2 size={15} class="animate-spin" />{/if}{register ? 'Создать аккаунт' : 'Войти'}</button><button type="button" class="glass-button" disabled={$cloudProfile.busy} onclick={() => { register = !register; password = ''; }}>{register ? 'Уже есть аккаунт' : 'Создать аккаунт'}</button><button type="button" class="text-button" disabled={$cloudProfile.busy || !email.trim()} onclick={() => cloudResetPassword(email)}>Восстановить пароль</button></div>
    </form>
    {:else}
      <div class="email-choices"><button type="button" class="glass-button email-entry" onclick={() => revealEmail(false)}><Mail size={17} aria-hidden="true" />Войти по почте</button><button type="button" class="glass-button email-entry" onclick={() => revealEmail(true)}>Создать аккаунт</button></div>
    {/if}
    {#if !cloudDesktopAvailable()}<p class="note">Вход через Google доступен в установленном приложении Lomify.</p>{:else if !cloudGoogleConfigured || !$cloudGoogleReady}<p class="note">Вход через Google появится после завершения подключения проекта.</p>{/if}
    <p class="note">Используй отдельный пароль для Lomify. Аудиофайлы и подключения музыкальных сервисов в облако не передаются.{#if !cloudDesktopAvailable()}{' '}В браузерном предпросмотре вход действует до закрытия страницы.{/if}</p>
  {:else}
    <div class="account"><strong>{$cloudProfile.email}</strong><button type="button" class="text-button" disabled={$cloudProfile.busy} onclick={cloudSignOut}><LogOut size={14} />Выйти</button></div>
    {#if $cloudProfile.head}<p class="note">Копия от {new Date($cloudProfile.head.createdAt).toLocaleString('ru-RU')} · {Math.ceil($cloudProfile.head.bytes / 1024)} КБ</p>{/if}
    <div class="actions"><button type="button" class="glass-button" disabled={$cloudProfile.busy} onclick={cloudCheck}><RefreshCw size={15} />Проверить облако</button>{#if $cloudProfile.head}<button type="button" class="glass-button" disabled={$cloudProfile.busy} onclick={cloudPreview}><Download size={15} />Посмотреть копию</button>{/if}</div>
    {#if $cloudProfile.head && !$cloudProfile.accepted}<label class="confirm"><input type="checkbox" bind:checked={replaceCloud} disabled={$cloudProfile.busy} />Заменить копию в аккаунте данными с этого компьютера</label>{/if}
    <div class="actions"><button type="button" class="glass-button" disabled={$cloudProfile.busy || ($cloudProfile.head !== null && !$cloudProfile.accepted && !replaceCloud)} onclick={() => cloudUpload(replaceCloud)}><Upload size={15} />Сохранить в облако</button></div>
    {#if $cloudProfile.preview}
      {@const data = $cloudProfile.preview.data}
      <section class="preview" aria-label="Содержимое облачной копии"><strong>Что сохранено в аккаунте</strong><dl><div><dt>Любимых песен</dt><dd>{data.likes.length}</dd></div><div><dt>Плейлистов</dt><dd>{data.playlists.length}</dd></div><div><dt>Музыка играла</dt><dd>{Math.floor(data.stats.listenSeconds / 3600)} ч {Math.floor(data.stats.listenSeconds % 3600 / 60)} мин</dd></div><div><dt>Достижений</dt><dd>{Object.keys(data.achievements).length}</dd></div></dl>
        <p class="note">Загрузка заменит текущие данные. Сначала предложим сохранить их отдельным файлом .lomi. Пути к локальной музыке на этом компьютере сохранятся.</p>
        <label class="confirm"><input type="checkbox" bind:checked={replaceLocal} disabled={$cloudProfile.busy} />Заменить данные на компьютере облачной копией</label>
        <div class="actions"><button type="button" class="glass-button" disabled={$cloudProfile.busy || !replaceLocal} onclick={cloudRestore}>Загрузить на компьютер</button></div>
      </section>
    {/if}
    <label class="confirm"><input type="checkbox" checked={$cloudProfile.auto} disabled={$cloudProfile.busy || !$cloudProfile.accepted || $cloudProfile.conflict} onchange={event => cloudSetAuto(event.currentTarget.checked)} />Автосохранение раз в 5 минут, когда есть изменения</label>
    <p class="note">Сначала сохрани свою копию в аккаунт или загрузи существующую. Лимит копии - 4 МБ. Если два компьютера изменят данные одновременно, автосохранение остановится и предложит выбрать копию. Музыкальные файлы хранятся отдельно.</p>
  {/if}
  {#if $cloudProfile.error}<p class="error" role="alert">{$cloudProfile.error}</p>{/if}
  {#if $cloudProfile.message}<p class="note" role="status">{$cloudProfile.message}</p>{/if}
</article>
<style>
  .email-choices{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px}.email-choices .email-entry{margin-top:0;padding-inline:9px}@media(max-width:420px){.email-choices{grid-template-columns:1fr}}
  .email-entry{width:100%;border-radius:999px;margin-top:10px;min-height:42px;background:#ffffff08;border:1px solid #ffffff32;color:#edeaf0}.email-entry:hover{background:#ffffff13}
  .google-button{background:#fff;color:#242424;border:1px solid #e0e0e0;font-weight:550;min-height:42px;padding:10px 16px}.google-button:hover:not(:disabled){background:#f0f3f8}.google-button:disabled{opacity:.62}.auth-divider{display:flex;align-items:center;gap:12px;margin:22px 0 0;color:#9ca1aa;font-size:10px}.auth-divider::before,.auth-divider::after{content:'';height:1px;flex:1;background:#ffffff16}.welcome-auth .google-action{margin-top:0}.welcome-auth .google-button{width:100%;border-radius:999px}.welcome-auth .fields{grid-template-columns:1fr;gap:14px;margin-top:18px}.welcome-auth .fields input{border-radius:12px;background:#0002;padding:12px 14px}.welcome-auth form .actions{display:grid;grid-template-columns:1fr auto;align-items:center}.welcome-auth form button[type=submit]{background:var(--color-primary);color:var(--color-dark);border:0;border-radius:999px;font-weight:650;min-height:40px}.welcome-auth form button[type=button]:not(.text-button){border-radius:999px}.welcome-auth .text-button{grid-column:1/-1;justify-self:center;padding:5px 8px}
  .cloud-card{padding:24px}header{display:flex;gap:12px;align-items:flex-start}.cloud-icon{width:40px;height:40px;display:grid;place-items:center;flex-shrink:0;background:#ffffff08;border-radius:12px;color:var(--color-primary)}
  header p,.note{font-size:12px;line-height:1.65;color:#b5afbd;margin-top:8px;overflow-wrap:anywhere}.fields{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px}.fields label{display:grid;gap:7px;font-size:12px;color:#ddd8e4}.fields input{width:100%;min-width:0;background:#0003;border:1px solid #ffffff26;border-radius:9px;padding:11px 12px;color:#fff}.fields input:focus-visible{outline:2px solid var(--color-primary);outline-offset:2px}
  .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}button{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:10px 13px;border-radius:9px;font-size:12px}.text-button{background:transparent;color:#d3ccd9}.text-button:focus-visible,button:focus-visible{outline:2px solid var(--color-primary);outline-offset:3px}button:disabled{opacity:.45}.account{display:flex;gap:12px;align-items:center;justify-content:space-between;margin-top:15px}.account strong{font-size:13px;overflow-wrap:anywhere}.confirm{display:flex;align-items:flex-start;gap:9px;margin-top:18px;font-size:12px;line-height:1.6}.confirm input{accent-color:var(--color-primary);margin-top:3px}.preview{border:1px solid #ffffff24;border-radius:12px;padding:16px;margin-top:20px}.preview strong{font-size:13px}dl{display:grid;gap:7px;font-size:12px;margin-top:12px}dl div{display:flex;justify-content:space-between;gap:12px}dd{font-variant-numeric:tabular-nums}.error{color:#ffb0b8;font-size:12px;line-height:1.65;margin-top:14px}@media(max-width:640px){.fields{grid-template-columns:1fr}}
</style>
