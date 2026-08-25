<script lang="ts">
  import { goToArtist } from '$lib/utils/navigation';
  import { splitArtists } from '$lib/utils/artists';

  export let artist: string;
  /**
   * Список исполнителей от самого источника. У Яндекса он приходит отдельным полем
   * (`artists` в `mapYandexTrack`), и это единственный надёжный способ узнать, сколько на
   * треке авторов: из склеенной подписи «A, B» это можно только угадывать. Где список есть —
   * передавайте его, разбор строки останется запасным вариантом для SoundCloud и файлов.
   */
  export let artists: string[] | null = null;
  /**
   * Не каждое имя автора — реальный аккаунт. Полка «Похожие авторы» подставляет
   * подпись-заглушку, и вести с неё на пустую страницу профиля хуже, чем не вести
   * никуда: клик выглядит рабочим, а результата нет. Такие места ставят linkable={false}.
   */
  export let linkable = true;
  /**
   * Хук для оверлеев: страница автора рисуется под модалкой, поэтому трейлер плейлиста
   * обязан сначала остановить превью и закрыться, иначе переход случится «за спиной» у
   * открытого окна. Обычным строкам трека колбэк не нужен — там его просто не передают.
   */
  export let onNavigate: (() => void) | null = null;

  // Каждое имя — своя ссылка. Пока подпись была одной кнопкой, второй автор фита никуда не
  // вёл: `goToArtist('A, B')` искал артиста с запятой в имени и не находил никого.
  $: names = splitArtists(artist, artists);

  const TEAM = ['klimentos', 'uniquebleed', 'bleed'];
  const DEV = ['pizxx'];
  // Плашка теперь проверяется по имени, а не по всей подписи: у фита «pizxx, кто-то» её
  // раньше не было вовсе, потому что склеенная строка не совпадала ни с одним значением.
  function badgeOf(name: string): 'team' | 'dev' | '' {
    const key = name.trim().toLowerCase();
    return TEAM.includes(key) ? 'team' : DEV.includes(key) ? 'dev' : '';
  }

  // Автор почти всегда лежит внутри кликабельной строки трека. Без stopPropagation
  // клик по имени сначала запустил бы трек, а потом ушёл на профиль.
  function open(e: MouseEvent, name: string) {
    e.preventDefault();
    e.stopPropagation();
    if (onNavigate) onNavigate();
    goToArtist(name);
  }
</script>

<!-- Корень — <span>: тег вставляют внутрь <span>/<p> (Library, Search), а <div>
     внутри строчного элемента браузер выкидывает наружу и ломает вёрстку. -->
<span class="artist-tag">
  {#each names as name, i (name)}
    {#if i > 0}<span class="artist-sep" aria-hidden="true">,</span>{/if}
    {#if linkable}
      <button type="button" class="artist-link" title={name} on:click={(e) => open(e, name)}>{name}</button>
    {:else}
      <span class="artist-link is-plain" title={name}>{name}</span>
    {/if}
    {#if badgeOf(name) === 'team'}
      <span class="artist-badge text-[9px] font-bold px-1.5 py-0.5 rounded bg-orange-500/20 text-orange-400 whitespace-nowrap shrink-0 border border-orange-500/30 leading-none shadow-[0_0_8px_rgba(249,115,22,0.2)]">
        Team Lomify
      </span>
    {:else if badgeOf(name) === 'dev'}
      <span class="artist-badge text-[9px] font-bold px-1.5 py-0.5 rounded bg-green-500/20 text-green-400 whitespace-nowrap shrink-0 border border-green-500/30 leading-none shadow-[0_0_8px_rgba(34,197,94,0.2)]">
        Developer
      </span>
    {/if}
  {/each}
</span>
