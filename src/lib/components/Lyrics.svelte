<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { currentTrack, isPlaying, progress } from '$lib/stores';
  import { getLyrics } from '$lib/api';
  import { Loader2 } from '@lucide/svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { listen } from '@tauri-apps/api/event';
  import type { UnlistenFn } from '@tauri-apps/api/event';
  import { settings } from '$lib/stores';

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
  let lineProgress = 0;
  let unlistenActiveLine: UnlistenFn;
  let rafId: number;

  function clamp01(v: number) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
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
          out.push({
            time: prev.time + 0.5,
            text: PAUSE_MARKER,
            pause: true,
            duration: gap - 0.6,
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

  $: if (displayLines.length > 0 && $settings.lyricsOffset !== undefined) {
    const offsetSecs = ($settings.lyricsOffset || 0) / 1000 - 0.4;
    invoke('audio_set_lyrics_timeline', {
      lines: displayLines.map(l => ({ timeSecs: Math.max(0, l.time + offsetSecs), text: l.text }))
    });
  }

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
    
    const text = await getLyrics($currentTrack.title, $currentTrack.artist);
    if (text) {
      lyrics = text;
      buildDisplayLines(text);
      await tick();
      setupRaf();
    } else {
      lyrics = 'Текст не найден';
      displayLines = [];
      invoke('audio_clear_lyrics_timeline');
    }
    isLoading = false;
  }

  function setLineState(i: number, state: string) {
    if (!lineRefs[i]) return;
    if (lineRefs[i].dataset.state === state) return;
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
      
      const offsetSecs = ($settings.lyricsOffset || 0) / 1000 - 0.4;
      const adjustedProgress = Math.max(0, $progress - offsetSecs);
      
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

  onMount(() => {
    (async () => {
      unlistenActiveLine = await listen('lyrics:active_line', (event) => {
      if (!containerRef || lineRefs.length === 0) return;

      const idx = typeof event.payload === 'number' ? event.payload : -1;
      if (idx === activeIndex) return;

      const prev = activeIndex;
      activeIndex = idx;
      lineProgress = 0;

      for (let i = 0; i < lineRefs.length; i++) {
        let state;
        if (i === idx) state = 'active';
        else if (i === idx - 1) state = 'past-near';
        else if (i === idx + 1) state = 'next-near';
        else if (idx >= 0 && i < idx) state = 'past';
        else state = 'next';
        setLineState(i, state);
      }

      if (idx >= 0 && idx < lineRefs.length && !manualScroll) {
        const el = lineRefs[idx];
        if (el) {
          const top = el.offsetTop - containerRef.clientHeight / 2 + el.clientHeight / 2;
          const now = performance.now();
          const behavior = now - lastScrollTs < 220 || prev === -1 || Math.abs(idx - prev) > 2 ? 'auto' : 'smooth';
          containerRef.scrollTo({ top, behavior });
          lastScrollTs = now;
        }
      }
    });
    })();

    const onVisibility = () => {
      if (document.visibilityState !== 'hidden' && !rafId) {
        setupRaf();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
    };
  });

  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
    if (unlistenActiveLine) unlistenActiveLine();
    invoke('audio_clear_lyrics_timeline');
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
      manualScroll = false;
      const offsetSecs = ($settings.lyricsOffset || 0) / 1000 - 0.4;
      invoke('audio_seek', { position: Math.max(0, time + offsetSecs) });
    }
  }

  function markManual() {
    manualScroll = true;
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
  {:else if displayLines.length > 0 && displayLines[0].time !== -1}
    <div class="flex flex-col gap-2">
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
          {@const cells = splitChars(line.text)}
          {@const groups = splitWordsForChars(cells)}
          <!-- svelte-ignore a11y-click-events-have-key-events -->
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <div 
            bind:this={lineRefs[i]}
            class="lyric-line" 
            on:click={() => handleSeek(line.time)}
          >
            <span class="lyric-fill">
              {#each groups as group, gi}
                {#if !group[0].animated}
                  <span>{group.map(c => c.ch).join('')}</span>
                {:else}
                  <span class="lyric-word">
                    {#each group as c, ci}
                      <span class="lyric-char" use:registerChar={{ lineIndex: i }}>{c.ch}</span>
                    {/each}
                  </span>
                {/if}
              {/each}
            </span>
          </div>
        {/if}
      {/each}
    </div>
  {:else if displayLines.length > 0}
    <div class="text-[22px] text-white/70 font-semibold whitespace-pre-wrap leading-loose tracking-tight">
      {lyrics}
    </div>
  {:else}
    <div class="h-full flex items-center justify-center text-white/50">
      {lyrics || 'Нет текста'}
    </div>
  {/if}
  <div class="h-[40vh]"></div>
</div>
