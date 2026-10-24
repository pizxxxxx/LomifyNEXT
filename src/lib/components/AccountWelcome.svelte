<script lang="ts">
  import { TreePine, ArrowRight, Cloud, X } from 'lucide-svelte';
  import { accountWelcome, finishAccountWelcome, openAccountWelcome } from '$lib/accountWelcome';
  import { cloudProfile, cancelPendingCloudSignIn } from '$lib/cloudProfile';
  import CloudAccount from './CloudAccount.svelte';
  import { isChangelogModalOpen } from '$lib/changelog';
  let dialog: HTMLDialogElement;
  function skip() { cancelPendingCloudSignIn(); finishAccountWelcome($cloudProfile.email ? 'account' : 'offline'); }
  function mountDialog(node: HTMLDialogElement) {
    const previous = document.activeElement as HTMLElement | null;
    node.showModal();
    return { destroy: () => { node.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); } };
  }
</script>
{#if $accountWelcome.open}
  <dialog bind:this={dialog} use:mountDialog class="account-welcome" aria-labelledby="welcome-title" oncancel={event => { event.preventDefault(); skip(); }}>
    <img class="welcome-watermark" src="/app-icon.png?v=2" alt="" aria-hidden="true" />
    <div class="welcome-art" aria-hidden="true"><img class="welcome-logo" src="/app-icon.png?v=2" alt="" width="62" height="62" /><span class="welcome-word">LOMIFY<span>NEXT</span></span></div>
    <main><span class="welcome-kicker">Твоя музыка. Твой ритм.</span><h1 id="welcome-title">{$accountWelcome.kind === 'new' ? 'Устраивайся поудобнее' : 'Твоя музыка может быть с тобой'}</h1>
      <p class="welcome-intro">{$accountWelcome.kind === 'new' ? 'Создай аккаунт, чтобы сохранить свой музыкальный мир. Или начни без регистрации.' : 'Твои плейлисты, часы и настройки уже на этом компьютере. Подключи аккаунт, чтобы сохранить копию и перенести её на другой.'}</p>
      <CloudAccount welcome />
    </main>
    <footer class="welcome-footer">
      <button class="forest-button" type="button" onclick={skip}>{#if $cloudProfile.email}<span>Продолжить в Lomify</span><ArrowRight size={18} />{:else}<TreePine size={19} /><span>Жить в лесу</span><ArrowRight size={18} />{/if}</button>
      <p class="forest-note">{$cloudProfile.email ? 'Вход выполнен. Локальные данные сохранятся, пока ты сам не выберешь загрузку другой копии.' : 'Без аккаунта Lomify. Медиатека и достижения сохраняются на компьютере, резервные копии - в .lomi. Войти можно позже в Подключениях.'}</p>
    </footer>
  </dialog>
{:else if $accountWelcome.nudge && !$isChangelogModalOpen}
  <aside class="account-upgrade" aria-label="Облачная копия Lomify"><Cloud size={21} aria-hidden="true" /><div><strong>Сохрани свой музыкальный мир</strong><p>Плейлисты, часы и достижения можно перенести в аккаунт. Текущие данные остаются на компьютере.</p><button type="button" onclick={openAccountWelcome}>Подключить аккаунт <ArrowRight size={14} /></button></div><button type="button" class="nudge-close" aria-label="Предложить вход позже" onclick={() => finishAccountWelcome('later')}><X size={16} /></button></aside>
{/if}
<style>
  .welcome-watermark{position:absolute;top:-45px;right:-55px;width:310px;height:310px;object-fit:contain;opacity:.085;pointer-events:none;user-select:none;filter:grayscale(1);mask-image:linear-gradient(#0008,transparent 90%)}.welcome-logo{display:block;width:62px;height:62px;object-fit:contain;flex-shrink:0;background:transparent}.welcome-art{z-index:1}
  :global(body[data-perf="light"]) .account-welcome,:global(body[data-glass-material="matte"][data-matte-blur="off"]) .account-welcome{background:#18181af5;-webkit-backdrop-filter:none;backdrop-filter:none}
  :global(body[data-perf="light"]) .account-welcome::backdrop{backdrop-filter:none}

  .account-welcome{position:fixed;inset:0;width:min(490px,calc(100vw - 32px));max-height:calc(100dvh - 40px);margin:auto;padding:0;border:1px solid #ffffff35;border-radius:22px;background:rgb(22 22 24 / 76%);-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);color:#f8f5fb;box-shadow:0 30px 100px #0008;overflow:hidden;outline:none}.account-welcome[open]{display:grid;grid-template-rows:auto minmax(0,1fr) auto}.account-welcome::backdrop{background:rgb(0 0 0 / 30%);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px)}
  .welcome-art{position:relative;overflow:hidden;min-height:92px;background:transparent;display:flex;justify-content:flex-start;align-items:center;padding:24px 32px 0;gap:12px}.welcome-word{position:relative;font-size:17px;letter-spacing:.1em;font-weight:700}.welcome-word span{display:block;margin-top:4px;font-size:8px;text-align:left;letter-spacing:.45em;font-weight:450;color:#ddd2e2}
  main{position:relative;z-index:1;min-width:0;min-height:0;overflow:auto;padding:20px 32px 22px}.welcome-footer{position:relative;z-index:1;padding:0 32px 22px}.welcome-kicker{font-size:10px;letter-spacing:.13em;text-transform:uppercase;color:var(--color-primary)}h1{font-size:clamp(25px,3vw,30px);font-weight:650;letter-spacing:-.035em;line-height:1.15;margin:10px 0 12px}.welcome-intro,.forest-note{font-size:12px;line-height:1.65;color:#bcb5c5}.welcome-intro{margin-bottom:22px}.account-welcome :global(.cloud-card){padding:0!important;background:transparent!important;border:0!important;box-shadow:none!important}.account-welcome :global(.cloud-card > header){display:none}.account-welcome :global(.cloud-card .note){font-size:11px}.forest-button{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;margin-top:0;padding:13px 18px;border:1px solid #ffffff32;border-radius:12px;background:#ffffff09;font-size:13px;font-weight:550;color:#e7e0ee}.forest-button:hover{background:#ffffff13}.forest-button:focus-visible{outline:2px solid var(--color-primary);outline-offset:4px}.forest-note{font-size:10px;margin-top:10px}
  .account-upgrade{position:fixed;right:24px;bottom:112px;z-index:850;display:flex;gap:12px;width:min(390px,calc(100vw - 32px));padding:18px;border:1px solid #ffffff35;border-radius:17px;background:rgb(24 24 26 / 94%);box-shadow:0 15px 50px #0005;color:#ede6f2}.account-upgrade>:global(svg){color:var(--color-primary);flex-shrink:0}.account-upgrade strong{font-size:13px}.account-upgrade p{font-size:11px;line-height:1.6;color:#bcb5c5;margin-top:6px}.account-upgrade button{display:inline-flex;gap:6px;align-items:center;font-size:12px;color:var(--color-primary);margin-top:10px}.account-upgrade .nudge-close{margin:0;align-self:flex-start;color:#bcb5c5}.account-upgrade button:focus-visible{outline:2px solid var(--color-primary);outline-offset:3px}
  @media(max-width:700px){.account-welcome[open]{grid-template-columns:1fr}.welcome-art{min-height:105px;padding:18px;flex-direction:row;gap:16px}.welcome-word{font-size:21px}.welcome-word span{text-align:left}main{padding:24px}.account-upgrade{right:16px}}
  @media(prefers-reduced-transparency:reduce){.account-welcome{background:#18181a;-webkit-backdrop-filter:none;backdrop-filter:none}.account-welcome::backdrop{backdrop-filter:none;background:#07070be8}}
</style>
