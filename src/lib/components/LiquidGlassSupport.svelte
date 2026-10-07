<script lang="ts">
  import { Heart, Star, GitBranch, ArrowUpRight, Wallet } from 'lucide-svelte';
  import { openUrl } from '@tauri-apps/plugin-opener';
  import { settings, effectivePerformanceMode, notify } from '$lib/stores';
  import { glassRefraction } from '$lib/glassRefraction';
  import { YOOMONEY_BUTTON_URL, YOOMONEY_WALLET_URL, GITHUB_PROJECT_URL } from '$lib/supportLinks';

  async function openLink(event: MouseEvent, url: string) {
    if (!('__TAURI_INTERNALS__' in window)) return;
    event.preventDefault();
    try { await openUrl(url); }
    catch { notify('Не удалось открыть ссылку. Попробуй ещё раз.', 'error'); }
  }
</script>

<div class="lg-support-body">
  <div class="lg-support-intro">
    <span class="lg-support-symbol" aria-hidden="true"><Heart size={25} /></span>
    <h3>Помоги LomifyNEXT<br/>стать лучше</h3>
    <p>Поддержи развитие приложения или расскажи о нём другим.</p>
  </div>
  <section class="lg-support-card lg-optical" use:glassRefraction={$effectivePerformanceMode ? 'off' : $settings.glassQuality || 'normal'} aria-labelledby="lg-support-money">
    <Wallet size={21} aria-hidden="true"/>
    <h3 id="lg-support-money">Поддержать на ЮMoney</h3>
    <p>Оплата откроется в твоём браузере.</p>
    <a class="lg-support-primary" href={YOOMONEY_BUTTON_URL} target="_blank" rel="noopener noreferrer" onclick={event => openLink(event, YOOMONEY_BUTTON_URL)}>Поддержать <ArrowUpRight size={15}/></a>
    <a class="lg-support-wallet" href={YOOMONEY_WALLET_URL} target="_blank" rel="noopener noreferrer" onclick={event => openLink(event, YOOMONEY_WALLET_URL)}>Выбрать свою сумму <ArrowUpRight size={12}/></a>
  </section>
  <section class="lg-support-github" aria-labelledby="lg-support-star">
    <GitBranch size={21} aria-hidden="true"/>
    <h3 id="lg-support-star">Поставь звезду на GitHub</h3>
    <p>Открой репозиторий и нажми Star. Если потребуется, войди в GitHub.</p>
    <a href={GITHUB_PROJECT_URL} target="_blank" rel="noopener noreferrer" onclick={event => openLink(event, GITHUB_PROJECT_URL)}><Star size={15}/>Поставить звезду <ArrowUpRight size={14}/></a>
  </section>
  <p class="lg-support-note">Поддержка добровольная. Все функции приложения остаются доступны без оплаты.</p>
</div>
