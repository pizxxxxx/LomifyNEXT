<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { currentTrack, isPlaying, progress, lyricsStatus } from '$lib/stores';
  import { getLyrics } from '$lib/api';
  import { Loader2, AlignLeft } from '@lucide/svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { settings } from '$lib/stores';

  /** Включена ли посимвольная караоке-подсветка. Тайминг строк работает в обоих режимах. */
  export let letterSync = true;

  interface LyricLine {
    time: number;
    text: string;
    pause?: boolean;
    duration?: number;
  }

  const PAUSE_MARKER = '♪♪♪';
  const PAUSE_GAP_THRESHOLD = 4.5;

  let lyrics = '';
  let isLoading = false;
  let displayLines: LyricLine[] = [];
  let containerRef: HTMLElement;
  let activeIndex = -1;
  let lineRefs: HTMLElement[] = [];
  let charRefs: HTMLElement[][] = [];
  let pauseBarsRef: HTMLElement[] = [];
  let manualScroll = false;
  let lastScrollTs = 0;
  /**
   * Сколько текст «не мешает» после того, как его прокрутили руками. Раньше `manualScroll`
   * снимался только кликом по строке (`handleSeek`), поэтому одно движение колесом
   * выключало слежение навсегда: спеть могло полтрека, а текст стоял там, где его
   * оставили, и вернуть его можно было лишь щелчком — то есть с перемоткой звука.
   * Пять секунд — это заметно дольше любого «пролистну посмотреть, что дальше», но
   * достаточно быстро, чтобы не успеть решить, будто слежение сломалось.
   */
  const FOLLOW_RESUME_MS = 5000;
  let followResumeTimer: ReturnType<typeof setTimeout> | null = null;
  let lineProgress = 0;
  let rafId: number;
  let previousLetterSync = letterSync;
  let reduceMotion = false;

  function clamp01(v: number) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // Roughly how long a line takes to sing: a short lead-in plus ~85ms per character
  // (≈12 chars/sec, which is a comfortable vocal pace). Never longer than the gap it
  // has to fit into, never so short that the fill snaps.
  function estimateSungDuration(text: string, gap: number) {
    const chars = text.replace(/\s+/g, ' ').trim().length;
    const est = 0.28 + chars * 0.085;
    const ceiling = Math.max(0.9, gap - 1.0);
    return Math.min(Math.max(est, 0.9), ceiling);
  }

  function buildDisplayLines(rawText: string) {
    const parsed: { time: number; text: string }[] = [];
    const lines = rawText.split('\n');
    for (const l of lines) {
      const match = l.match(/\[(\d+):(\d+\.\d+)\]\s*(.*)/);
      if (match) {
        const mins = parseInt(match[1]);
        const secs = parseFloat(match[2]);
        parsed.push({ time: mins * 60 + secs, text: match[3] || '♪' });
      } else if (l.trim() && !l.startsWith('[')) {
        parsed.push({ time: -1, text: l.trim() });
      }
    }

    // Only apply pause magic if we have synced lines
    if (parsed.length === 0 || parsed.some(p => p.time === -1)) {
      displayLines = parsed;
      return;
    }

    const out: LyricLine[] = [];
    for (let i = 0; i < parsed.length; i++) {
      const cur = parsed[i];
      const prev = parsed[i - 1];
      if (prev) {
        const gap = cur.time - prev.time;
        if (gap >= PAUSE_GAP_THRESHOLD) {
          // The pause marker becomes the `next` line for `prev`, and the karaoke fill
          // uses `next.time - cur.time` as the line's duration. Anchoring the marker
          // 0.5s after `prev` therefore told the animation to sing a whole line in half
          // a second, which is why the text raced right before the ♪♪♪ row. Estimate how
          // long the line is actually sung instead, and park the marker after it.
          const sung = estimateSungDuration(prev.text, gap);
          out.push({
            time: prev.time + sung,
            text: PAUSE_MARKER,
            pause: true,
            duration: Math.max(0.5, gap - sung - 0.1),
          });
        }
      } else if (cur.time >= PAUSE_GAP_THRESHOLD) {
        out.push({
          time: 0.05,
          text: PAUSE_MARKER,
          pause: true,
          duration: Math.max(0.5, cur.time - 0.1),
        });
      }
      out.push(cur);
    }
    displayLines = out;
  }

  $: hasTimedLyrics = displayLines.length > 0 && displayLines.every((line) => line.time >= 0);
  // В построчном режиме ручной оффсет выключен в интерфейсе, поэтому не оставляем скрытое
  // старое значение влиять на строки. Базовая компенсация задержки аудио остаётся общей.
  $: lyricsOffsetSecs = (letterSync ? ($settings.lyricsOffset || 0) / 1000 : 0) - 0.4;

  $: if ($currentTrack) {
    loadLyrics();
  }

  async function loadLyrics() {
    if (!$currentTrack) return;
    isLoading = true;
    lyrics = '';
    displayLines = [];
    charRefs = [];
    activeIndex = -1;
    
    const text = await getLyrics($currentTrack.title, $currentTrack.artist, $currentTrack);
    // Тот же ответ нужен кнопке «Показать текст» в полноэкранном режиме — иначе она
    // продолжала бы звать в пустую панель, которую человек только что закрыл.
    lyricsStatus.set(text ? 'found' : 'none');
    if (text) {
      lyrics = text;
      buildDisplayLines(text);
      isLoading = false;
      await tick();
      syncActiveLine(get(progress), true, 'auto');
      if (letterSync && hasTimedLyrics) setupRaf();
    } else {
      lyrics = 'Текста пока нет';
      displayLines = [];
      isLoading = false;
    }
  }

  function setLineState(i: number, state: string, force = false) {
    if (!lineRefs[i]) return;
    if (!force && lineRefs[i].dataset.state === state) return;
    lineRefs[i].dataset.state = state;

    const line = displayLines[i];
    const bar = pauseBarsRef[i];

    if (state === 'past' || state === 'past-near') {
      writeLineProgress(i, 1);
      if (bar && line.pause) bar.dataset.state = 'past';
    } else if (state === 'next' || state === 'next-near') {
      writeLineProgress(i, 0);
      if (bar && line.pause) bar.dataset.state = '';
    } else if (state === 'active') {
      if (bar && line.pause) bar.dataset.state = 'active';
    }
  }

  function applyLineStates(idx: number, force = false) {
    for (let i = 0; i < lineRefs.length; i++) {
      let state;
      if (i === idx) state = 'active';
      else if (i === idx - 1) state = 'past-near';
      else if (i === idx + 1) state = 'next-near';
      else if (idx >= 0 && i < idx) state = 'past';
      else state = 'next';
      setLineState(i, state, force);
    }
  }

  function activeLineAt(position: number): number {
    if (!hasTimedLyrics) return -1;
    const adjusted = Math.max(0, Number(position) || 0) - lyricsOffsetSecs;
    let low = 0;
    let high = displayLines.length - 1;
    let found = -1;

    while (low <= high) {
      const middle = (low + high) >> 1;
      if (displayLines[middle].time <= adjusted) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  }

  /**
   * Активная строка считается прямо из общего прогресса плеера. Раньше компонент ждал
   * отдельное событие Rust-таймлайна; после смены режима оно могло остаться на прежнем
   * индексе, и тогда строка зависала, хотя сам seek продолжал работать.
   */
  function syncActiveLine(position: number, force = false, behavior?: ScrollBehavior) {
    const idx = activeLineAt(position);
    const prev = activeIndex;
    if (!force && idx === prev) return;

    activeIndex = idx;
    lineProgress = 0;
    applyLineStates(idx, force);

    if (idx >= 0 && idx < lineRefs.length && !manualScroll) {
      const gap = performance.now() - lastScrollTs;
      scrollToActive(
        behavior ?? (gap < 220 || prev === -1 || Math.abs(idx - prev) > 2 ? 'auto' : 'smooth')
      );
    }
  }

  function writeLineProgress(i: number, p: number) {
    const el = lineRefs[i];
    if (!el) return;
    const value = clamp01(p);
    
    // Only update line progress if it changed significantly
    const prevValue = parseFloat(el.dataset.progress || '-1');
    if (Math.abs(prevValue - value) > 0.005 || value === 0 || value === 1) {
      el.dataset.progress = value.toString();
      el.style.setProperty('--lyric-progress', `${(value * 100).toFixed(2)}%`);
      el.style.setProperty('--lyric-progress-value', value.toFixed(4));
    }

    const chars = charRefs[i];
    if (chars && chars.length > 0) {
      const total = chars.length;
      const head = value * total;
      for (let c = 0; c < total; c++) {
        if (!chars[c]) continue;
        const local = clamp01((head - c + 0.6) / 1.4);
        const eased = local * local * (3 - 2 * local);
        const easedStr = eased.toFixed(3);
        
        // Cache to avoid unnecessary DOM writes
        if (chars[c].dataset.progress !== easedStr) {
          chars[c].dataset.progress = easedStr;
          chars[c].style.setProperty('--char-progress', easedStr);
        }
      }
    }

    const line = displayLines[i];
    const bar = pauseBarsRef[i];
    if (bar && line.pause) {
      if (bar.dataset.progress !== value.toString()) {
        bar.dataset.progress = value.toString();
        bar.style.width = `${(value * 100).toFixed(2)}%`;
      }
    }
  }

  function setupRaf() {
    if (rafId) cancelAnimationFrame(rafId);
    if (!letterSync || !hasTimedLyrics) {
      rafId = 0;
      return;
    }
    let lastTickTs = 0;
    const FRAME_BUDGET_MS = 33;

    const tickFrame = (ts: number) => {
      if (document.visibilityState === 'hidden') {
        rafId = 0;
        return;
      }
      rafId = requestAnimationFrame(tickFrame);
      if (ts - lastTickTs < FRAME_BUDGET_MS) return;
      lastTickTs = ts;

      const idx = activeIndex;
      if (idx < 0 || idx >= displayLines.length) return;
      const cur = displayLines[idx];
      const next = displayLines[idx + 1];
      
      const offsetSecs = lyricsOffsetSecs;
      // `get(progress)` instead of `$progress`: the auto-subscription invalidated this
      // component 10x/s (the backend tick rate) and forced a full flush + fragment
      // diff, even though the value is only ever read here inside the rAF loop. This
      // frame already runs at most every 33 ms and writes to the DOM directly.
      const adjustedProgress = Math.max(0, get(progress) - offsetSecs);
      
      const dur = Math.max(0.4, (next?.time ?? cur.time + 2.6) - cur.time);
      const target = clamp01((adjustedProgress - cur.time) / dur);

      const prev = lineProgress;
      const diff = target - prev;
      const smoothed = diff < 0 ? target : prev + diff * (diff > 0.18 || target > 0.92 ? 0.7 : 0.32);
      lineProgress = smoothed;
      writeLineProgress(idx, smoothed);
    };
    rafId = requestAnimationFrame(tickFrame);
  }

  async function handleLetterModeChange() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;

    // Внутренний keyed-блок пересоздаёт строки при смене режима. Ссылки очищаем до `tick`,
    // а после него сразу восстанавливаем активную строку из текущей позиции плеера.
    lineRefs = [];
    charRefs = [];
    pauseBarsRef = [];
    await tick();
    syncActiveLine(get(progress), true, 'auto');
    if (letterSync && hasTimedLyrics) setupRaf();
  }

  $: if (letterSync !== previousLetterSync) {
    previousLetterSync = letterSync;
    void handleLetterModeChange();
  }

  /**
   * Поставить активную строку в центр контейнера. Вынесено из обработчика
   * прогресса, потому что ровно это же нужно при возврате слежения: если просто
   * снять `manualScroll` и ждать следующей строки, на длинной строке текст «оживёт» лишь
   * через несколько секунд после таймера — и выглядеть это будет как случайный рывок, а не
   * как ответ на то, что человек перестал листать.
   */
  function scrollToActive(behavior: ScrollBehavior) {
    if (!containerRef) return;
    const el = lineRefs[activeIndex];
    if (!el) return;
    containerRef.scrollTo({
      top: el.offsetTop - containerRef.clientHeight / 2 + el.clientHeight / 2,
      behavior: reduceMotion ? 'auto' : behavior
    });
    lastScrollTs = performance.now();
  }

  onMount(() => {
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotionPreference = () => {
      reduceMotion = motionQuery.matches;
    };
    syncMotionPreference();
    motionQuery.addEventListener('change', syncMotionPreference);

    // Подписка вызывает callback сразу и затем на каждом `audio:tick`, поэтому после
    // переключения режима или seek строка восстанавливается без ожидания отдельного IPC.
    const unsubscribeProgress = progress.subscribe((position) => syncActiveLine(position));

    const onVisibility = () => {
      if (letterSync && hasTimedLyrics && document.visibilityState !== 'hidden' && !rafId) {
        setupRaf();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      unsubscribeProgress();
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery.removeEventListener('change', syncMotionPreference);
    };
  });

  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
    cancelFollowResume();
  });

  function splitChars(text: string) {
    return Array.from(text).map(ch => ({ ch, animated: !/^\s$/u.test(ch) }));
  }

  function splitWordsForChars(cells: {ch: string, animated: boolean}[]) {
    const groups = [];
    let cur: {ch: string, animated: boolean}[] = [];
    let curKind: boolean | null = null;
    for (const c of cells) {
      if (c.animated !== curKind) {
        if (cur.length) groups.push(cur);
        cur = [c];
        curKind = c.animated;
      } else {
        cur.push(c);
      }
    }
    if (cur.length) groups.push(cur);
    return groups;
  }

  let lastSeekTime = 0;
  function handleSeek(time: number) {
    if (time >= 0) {
      const now = performance.now();
      if (now - lastSeekTime < 300) return;
      lastSeekTime = now;
      cancelFollowResume();
      manualScroll = false;
      const targetPosition = Math.max(0, time + lyricsOffsetSecs);
      syncActiveLine(targetPosition, true, 'auto');
      invoke('audio_seek', { position: targetPosition }).catch(e => console.error(e));
    }
  }

  function cancelFollowResume() {
    if (followResumeTimer) clearTimeout(followResumeTimer);
    followResumeTimer = null;
  }

  // Каждое движение колеса отодвигает возврат: отсчёт идёт от последнего касания, а не от
  // первого, иначе слежение включилось бы посреди длинной прокрутки и выдернуло страницу
  // из-под руки.
  function markManual() {
    manualScroll = true;
    cancelFollowResume();
    followResumeTimer = setTimeout(() => {
      followResumeTimer = null;
      manualScroll = false;
      scrollToActive('smooth');
    }, FOLLOW_RESUME_MS);
  }

  function registerChar(node: HTMLElement, { lineIndex }: { lineIndex: number }) {
    if (!charRefs[lineIndex]) charRefs[lineIndex] = [];
    charRefs[lineIndex].push(node);
    return {
      destroy() {
        if (charRefs[lineIndex]) {
          charRefs[lineIndex] = charRefs[lineIndex].filter(n => n !== node);
        }
      }
    };
  }

  /**
   * Текст без синхронизации приходит одним блоком, и раньше его так и выводили —
   * `whitespace-pre-wrap` + `leading-loose`: строки растягивались во всю ширину панели,
   * а каждая пустая строка источника превращалась в дыру. Разбираем блок сами: строка
   * остаётся строкой, а любая пачка пустых строк сворачивается в один межстрофный
   * отступ. `displayLines` для этого не годится — там пустые строки уже потеряны.
   */
  function toPlainBlocks(text: string): { text: string; isBreak: boolean }[] {
    const blocks: { text: string; isBreak: boolean }[] = [];
    for (const raw of (text || '').split('\n')) {
      const line = raw.trim();
      if (line) blocks.push({ text: line, isBreak: false });
      else if (blocks.length && !blocks[blocks.length - 1].isBreak) blocks.push({ text: '', isBreak: true });
    }
    // Отступ в самом конце — такой же мусор, как лишняя пустая строка в источнике.
    if (blocks.length && blocks[blocks.length - 1].isBreak) blocks.pop();
    return blocks;
  }

  $: plainBlocks = toPlainBlocks(lyrics);
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div 
  class="h-full w-full flex-1 overflow-y-auto scrollbar-hide px-12 py-16 relative {!$isPlaying ? 'lyrics-paused' : ''}"
  bind:this={containerRef}
  style="mask-image: linear-gradient(transparent 0%, black 10%, black 90%, transparent 100%); -webkit-mask-image: linear-gradient(transparent 0%, black 10%, black 90%, transparent 100%);"
  on:wheel|passive={markManual}
  on:touchstart|passive={markManual}
  on:pointerdown={markManual}
>
  {#if isLoading}
    <div class="h-full flex items-center justify-center text-white/50">
      <Loader2 class="animate-spin w-8 h-8" />
    </div>
  {:else if hasTimedLyrics}
    {#key letterSync}
      <div class="selectable flex flex-col gap-2" class:lyrics-line-sync={!letterSync}>
        {#each displayLines as line, i}
          {#if line.pause}
            <div
              bind:this={lineRefs[i]}
              class="lyric-line lyric-pause"
              style="--pause-duration: {line.duration ?? 2}s"
            >
              <span class="note-gradient-text">{PAUSE_MARKER}</span>
              <div class="lyric-pause-track">
                <div class="lyric-pause-bar" bind:this={pauseBarsRef[i]}></div>
              </div>
            </div>
          {:else}
            <!-- svelte-ignore a11y-click-events-have-key-events -->
            <!-- svelte-ignore a11y-no-static-element-interactions -->
            <div
              bind:this={lineRefs[i]}
              class="lyric-line"
              on:click={() => handleSeek(line.time)}
            >
              {#if letterSync}
                {@const cells = splitChars(line.text)}
                {@const groups = splitWordsForChars(cells)}
                <span class="lyric-fill">
                  {#each groups as group}
                    {#if !group[0].animated}
                      <span>{group.map(c => c.ch).join('')}</span>
                    {:else}
                      <span class="lyric-word">
                        {#each group as c}
                          <span class="lyric-char" use:registerChar={{ lineIndex: i }}>{c.ch}</span>
                        {/each}
                      </span>
                    {/if}
                  {/each}
                </span>
              {:else}
                <span class="lyric-line-text">{line.text}</span>
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/key}
  {:else if displayLines.length > 0}
    <div class="selectable lyrics-plain">
      <!-- Плашка объясняет, почему ничего не подсвечивается: это не сломанное караоке,
           а текст, для которого просто нет тайминга. -->
      <div class="lyrics-plain-head">
        <AlignLeft size={11} />
        без синхронизации
      </div>
      {#each plainBlocks as block}
        {#if block.isBreak}
          <div class="lyrics-plain-break" aria-hidden="true"></div>
        {:else}
          <p class="lyrics-plain-line">{block.text}</p>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="h-full flex flex-col items-center justify-center gap-1.5">
      <div class="display-title">{lyrics || 'Текста нет'}</div>
      <div class="empty-hint !mt-0 text-center">Для этого трека никто ещё не выложил слова.</div>
    </div>
  {/if}
  <div class="h-[40vh]"></div>
</div>
