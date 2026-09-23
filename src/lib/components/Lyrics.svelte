<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { get } from 'svelte/store';
  import { currentTrack, isPlaying, progress, lyricsStatus, lyricsReloadTrigger } from '$lib/stores';
  import { getLyrics } from '$lib/api';
  import { Loader2, AlignLeft } from '@lucide/svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { settings } from '$lib/stores';

  /** Включена ли посимвольная караоке-подсветка. Тайминг строк работает в обоих режимах. */
  export let letterSync = true;

  interface AdlibItem {
    text: string;
    isPrefix: boolean;
    order: number;
  }

  interface LyricLine {
    time: number;
    text: string;
    mainText?: string;
    adlibs?: AdlibItem[];
    pause?: boolean;
    duration?: number;
  }

  function extractAdlibs(text: string): { mainText: string; adlibs: AdlibItem[] } {
    if (!text || text === PAUSE_MARKER) return { mainText: text, adlibs: [] };
    const adlibs: AdlibItem[] = [];
    const regex = /\(([^)]+)\)/gu;
    let match: RegExpExecArray | null;
    let order = 0;

    while ((match = regex.exec(text)) !== null) {
      const content = match[1].trim();
      if (content) {
        const isPrefix = match.index === 0 || text.slice(0, match.index).trim().length === 0;
        adlibs.push({
          text: content,
          isPrefix,
          order: order++
        });
      }
    }

    if (adlibs.length === 0) {
      return { mainText: text, adlibs: [] };
    }

    let cleaned = text.replace(/\(([^)]+)\)/gu, ' ');
    cleaned = cleaned.replace(/\s+([,.:!?…])/gu, '$1').replace(/\s+/gu, ' ').trim();
    return {
      mainText: cleaned,
      adlibs
    };
  }

  const PAUSE_MARKER = '♪♪♪';
  const PAUSE_GAP_THRESHOLD = 3.0;

  const VOWELS = new Set([
    'а', 'е', 'ё', 'и', 'о', 'у', 'ы', 'э', 'ю', 'я',
    'a', 'e', 'i', 'o', 'u', 'y',
    'А', 'Е', 'Ё', 'И', 'О', 'У', 'Ы', 'Э', 'Ю', 'Я',
    'A', 'E', 'I', 'O', 'U', 'Y'
  ]);
  const MAJOR_PAUSE_CHARS = new Set(['.', '!', '?', '…']);
  const MEDIUM_PAUSE_CHARS = new Set([',', ';', ':']);
  const HYPHEN_CHARS = new Set(['-', '—', '–']);

  interface CharWindow {
    start: number;
    end: number;
  }

  const lineWindowsCache = new Map<number, CharWindow[]>();

  let lyrics = '';
  let isLoading = false;
  let displayLines: LyricLine[] = [];
  let containerRef: HTMLElement;
  let activeIndex = -1;
  let lineRefs: HTMLElement[] = [];
  let charRefs: HTMLElement[][] = [];
  let adlibRefs: HTMLElement[][] = [];
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

  let lastProgressVal = 0;
  let lastProgressTs = 0;

  function clamp01(v: number) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  /**
   * Естественный расчет вокальной длительности строки.
   * Учитывает темп песни (размер интервала gap), количество слогов (гласных)
   * и число слов/дефисных токенов. Не сжимает короткие фразы («хоп-хоп-хоп»)
   * в 1 секунду посреди 4-секундного такта, распределяя их размеренно по такту с паузами.
   */
  function calculateSungDuration(text: string, gap: number): number {
    const clean = text.replace(/\[.*?\]/g, '').trim();
    if (!clean) return Math.min(gap, 1.0);

    const allChars = Array.from(clean);
    let vowelCount = 0;
    for (const ch of allChars) {
      if (VOWELS.has(ch)) vowelCount++;
    }
    const words = clean.split(/[\s\-—–]+/).filter(Boolean).length;
    const syllables = Math.max(1, vowelCount);

    // Пауза на вдох в конце строки перед следующим вступлением:
    const breathPause = gap > 2.5
      ? Math.min(0.8, Math.max(0.3, gap * 0.18))
      : Math.min(0.3, Math.max(0.1, gap * 0.12));
    const maxSungDur = Math.max(0.4, gap - breathPause);

    // Базовый темп: слог тянется 180-260 мс, токены 160 мс
    const naturalPace = syllables * 0.22 + words * 0.16 + 0.25;

    // В музыке короткая фраза в длинном такте звучит не быстрее 75% доступного такта:
    const minMusicalDur = maxSungDur * 0.75;
    const planned = Math.max(naturalPace, minMusicalDur);

    return Math.min(maxSungDur, Math.max(0.5, planned));
  }

  function getLineThresholdWindows(lineIndex: number, lineText: string, animatedCount: number): CharWindow[] {
    const cached = lineWindowsCache.get(lineIndex);
    if (cached && cached.length === animatedCount) return cached;

    if (animatedCount <= 0) return [];
    const allChars = Array.from(lineText);

    const anim: { ch: string; origIdx: number }[] = [];
    for (let i = 0; i < allChars.length; i++) {
      const ch = allChars[i];
      if (!/^\s$/u.test(ch)) {
        anim.push({ ch, origIdx: i });
      }
    }

    const count = anim.length;
    if (count === 0) return [];

    const weights: number[] = [];
    const pauses: number[] = [];

    for (let c = 0; c < count; c++) {
      const ch = anim[c].ch;

      let w = 0.85;
      if (VOWELS.has(ch)) {
        w = 1.35;
      } else if (HYPHEN_CHARS.has(ch) || MAJOR_PAUSE_CHARS.has(ch) || MEDIUM_PAUSE_CHARS.has(ch) || /['"«»()[\]{}…♪]/u.test(ch)) {
        w = 0.3; // Знаки препинания и дефисы не пропеваются, они быстро подсвечиваются
      }
      weights.push(w);

      if (c === count - 1) {
        pauses.push(0.0);
      } else {
        const nextCh = anim[c + 1].ch;
        const between = allChars.slice(anim[c].origIdx + 1, anim[c + 1].origIdx).join('');

        let pause = 0.0;
        // 1. Дефис между ритмическими частями (как в «хоп-хоп-хоп», «ай-ай-ай»)
        if (HYPHEN_CHARS.has(ch) || HYPHEN_CHARS.has(nextCh) || /[-—–]/u.test(between)) {
          pause = 2.4; // Заметное плато удержания между повторяющимися словами
        }
        // 2. Крупные знаки препинания (конец предложения)
        else if (MAJOR_PAUSE_CHARS.has(ch) || /[.!?…]/u.test(between)) {
          pause = 3.8;
        }
        // 3. Запятые, двоеточия, точки с запятой
        else if (MEDIUM_PAUSE_CHARS.has(ch) || /[,;:]/u.test(between)) {
          pause = 2.4;
        }
        // 4. Пробел между словами
        else if (/^\s+$/u.test(between) || between.length > 0) {
          pause = 1.4; // Естественная микропауза на вдох между словами
        }
        // 5. Внутри одного слова (между буквами)
        else {
          pause = 0.0;
        }

        pauses.push(pause);
      }
    }

    const totalWeight = weights.reduce((s, v) => s + v, 0) + pauses.reduce((s, v) => s + v, 0);
    const safeTotal = totalWeight > 0 ? totalWeight : 1;

    const windows: CharWindow[] = [];
    let current = 0;

    for (let c = 0; c < count; c++) {
      const start = current / safeTotal;
      current += weights[c];
      const end = current / safeTotal;
      windows.push({ start, end });
      current += pauses[c];
    }

    lineWindowsCache.set(lineIndex, windows);
    return windows;
  }

  $: adlibsEnabled = $settings.lyricsAdlibs !== false;
  $: adlibStyle = $settings.lyricsAdlibStyle || 'overlay';
  let previousAdlibsEnabled = adlibsEnabled;
  let previousAdlibStyle = adlibStyle;
  $: if (adlibsEnabled !== previousAdlibsEnabled || adlibStyle !== previousAdlibStyle) {
    previousAdlibsEnabled = adlibsEnabled;
    previousAdlibStyle = adlibStyle;
    void handleLetterModeChange();
  }

  function getEffectiveLineText(line: LyricLine | undefined): string {
    if (!line) return '';
    if (adlibsEnabled && line.mainText !== undefined) {
      return line.mainText;
    }
    return line.text;
  }

  function getLineAdlibs(line: LyricLine | undefined): AdlibItem[] {
    if (!line || !adlibsEnabled || !line.adlibs) return [];
    return line.adlibs;
  }

  function buildDisplayLines(rawText: string) {
    const parsed: LyricLine[] = [];
    const lines = rawText.split('\n');
    for (const l of lines) {
      const match = l.match(/\[(\d+):(\d+\.\d+)\]\s*(.*)/);
      if (match) {
        const mins = parseInt(match[1]);
        const secs = parseFloat(match[2]);
        const raw = match[3] || '♪';
        const { mainText, adlibs } = extractAdlibs(raw);
        parsed.push({
          time: mins * 60 + secs,
          text: raw,
          mainText,
          adlibs
        });
      } else if (l.trim() && !l.startsWith('[')) {
        const raw = l.trim();
        const { mainText, adlibs } = extractAdlibs(raw);
        parsed.push({
          time: -1,
          text: raw,
          mainText,
          adlibs
        });
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
          const sung = calculateSungDuration(getEffectiveLineText(prev), gap);
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
  // Базовое физическое опережение (80 мс): компенсирует буфер вывода звуковой карты и рендер
  // CSS-перехода. Пользовательский оффсет lyricsOffset накладывается поверх.
  const BASELINE_AUDIO_LATENCY_SECS = 0.08;
  $: lyricsOffsetSecs = (letterSync ? ($settings.lyricsOffset || 0) / 1000 : 0) - BASELINE_AUDIO_LATENCY_SECS;

  $: if ($currentTrack || $lyricsReloadTrigger) {
    loadLyrics();
  }

  async function loadLyrics() {
    if (!$currentTrack) return;
    isLoading = true;
    lyrics = '';
    displayLines = [];
    charRefs = [];
    adlibRefs = [];
    lineWindowsCache.clear();
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
      if (hasTimedLyrics) setupRaf();
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
    if (Math.abs(prevValue - value) > 0.004 || value === 0 || value === 1) {
      el.dataset.progress = value.toString();
      el.style.setProperty('--lyric-progress', `${(value * 100).toFixed(2)}%`);
      el.style.setProperty('--lyric-progress-value', value.toFixed(4));
    }

    const line = displayLines[i];
    const lineText = getEffectiveLineText(line);

    // Dynamic adlib timing and velocity-dependent appearance
    const adlibs = getLineAdlibs(line);
    if (adlibs.length > 0 && adlibRefs[i]) {
      const nextLine = displayLines[i + 1];
      const dur = Math.max(0.4, (nextLine?.time ?? line.time + 2.6) - line.time);
      const singingDur = line.pause
        ? (line.duration ?? dur)
        : Math.min(dur, Math.max(0.5, calculateSungDuration(lineText, dur)));
      const charCount = Math.max(1, lineText.replace(/\s+/gu, '').length);
      const speed = charCount / Math.max(0.4, singingDur);
      const appearSpeedMs = Math.round(Math.min(650, Math.max(90, 2200 / Math.max(3.0, Math.min(25.0, speed)))));
      const lifecycleMs = Math.round(Math.min(5200, Math.max(2800, appearSpeedMs * 14)));

      for (let a = 0; a < adlibs.length; a++) {
        const node = adlibRefs[i][a];
        if (!node) continue;
        const adlib = adlibs[a];
        // Если эдлиб в самом начале строки (до слов) — зажигаем сразу (0.0).
        const triggerThreshold = adlib.isPrefix ? 0.0 : Math.min(1.0, 0.94 + adlib.order * 0.03);
        const isLineActive = (i === activeIndex);
        const isTriggered = isLineActive ? (value >= triggerThreshold) : (i < activeIndex && node.dataset.triggered === 'true');
        const trigStr = isTriggered ? 'true' : 'false';
        if (node.dataset.triggered !== trigStr) {
          node.dataset.triggered = trigStr;
          node.style.setProperty('--adlib-speed', `${appearSpeedMs}ms`);
          node.style.setProperty('--adlib-lifecycle', `${lifecycleMs}ms`);
        }
      }
    }

    const chars = charRefs[i];
    if (chars && chars.length > 0) {
      const total = chars.length;
      const windows = getLineThresholdWindows(i, lineText, total);

      for (let c = 0; c < total; c++) {
        if (!chars[c]) continue;
        const win = windows[c] || { start: 0, end: 1 };
        const span = Math.max(0.0001, win.end - win.start);

        let local = 0;
        if (value >= win.end) {
          local = 1;
        } else if (value > win.start) {
          local = (value - win.start) / span;
        }

        const eased = local * local * (3 - 2 * local);
        const easedStr = eased.toFixed(3);

        if (chars[c].dataset.progress !== easedStr) {
          chars[c].dataset.progress = easedStr;
          chars[c].style.setProperty('--char-progress', easedStr);
        }
      }
    }

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
    if (!hasTimedLyrics) {
      rafId = 0;
      return;
    }
    let lastFrameTs = 0;

    const tickFrame = (ts: number) => {
      if (document.visibilityState === 'hidden') {
        rafId = 0;
        return;
      }
      rafId = requestAnimationFrame(tickFrame);
      const frameMs = lastFrameTs === 0 ? 1000 / 60 : Math.min(100, Math.max(1, ts - lastFrameTs));
      lastFrameTs = ts;
      if (!get(isPlaying)) {
        lastProgressTs = ts;
        return;
      }

      const idx = activeIndex;
      if (idx < 0 || idx >= displayLines.length) return;
      const cur = displayLines[idx];
      const next = displayLines[idx + 1];

      // Субпиксельная экстраполяция текущего времени трека между 100-мс тиками бэкенда:
      let currentAudioPos = lastProgressVal;
      if (lastProgressTs > 0) {
        const deltaSec = (ts - lastProgressTs) / 1000;
        // Ограничиваем экстраполяцию до 150 мс, чтобы при остановке плеер не забегал вперёд
        currentAudioPos = lastProgressVal + Math.min(0.15, Math.max(0, deltaSec));
      }

      const offsetSecs = lyricsOffsetSecs;
      const adjustedProgress = Math.max(0, currentAudioPos - offsetSecs);
      
      const dur = Math.max(0.4, (next?.time ?? cur.time + 2.6) - cur.time);
      const lineText = getEffectiveLineText(cur);
      const singingDur = cur.pause
        ? (cur.duration ?? dur)
        : Math.min(dur, Math.max(0.5, calculateSungDuration(lineText, dur)));
      const target = clamp01((adjustedProgress - cur.time) / singingDur);

      const prev = lineProgress;
      const diff = target - prev;

      // Отзывчивое следование:
      // При смене строки или перемотке (diff < 0 или diff > 0.35) мгновенно фиксируем позицию
      // При непрерывном пении плавно следуем без задержки
      const smoothed = (diff < 0 || diff > 0.35)
        ? target
        : prev + diff * Math.min(1, frameMs / 35);

      lineProgress = smoothed;
      writeLineProgress(idx, smoothed);
    };
    rafId = requestAnimationFrame(tickFrame);
  }

  async function handleLetterModeChange() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;

    lineRefs = [];
    charRefs = [];
    adlibRefs = [];
    pauseBarsRef = [];
    lineWindowsCache.clear();
    await tick();
    syncActiveLine(get(progress), true, 'auto');
    if (hasTimedLyrics) setupRaf();
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
    const unsubscribeProgress = progress.subscribe((position) => {
      lastProgressVal = Number(position) || 0;
      lastProgressTs = performance.now();
      syncActiveLine(lastProgressVal);
    });

    const onVisibility = () => {
      if (hasTimedLyrics && document.visibilityState !== 'hidden' && !rafId) {
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
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      // Если предыдущий символ был дефисом, закрываем текущую группу, чтобы следующее слово
      // («хоп-хоп-хоп») было отдельным токеном .lyric-word и могло при необходимости переноситься
      const prevWasHyphen = i > 0 && HYPHEN_CHARS.has(cells[i - 1].ch);
      if (c.animated !== curKind || (c.animated && prevWasHyphen)) {
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
      const targetPosition = Math.max(0, time);
      lastProgressVal = targetPosition;
      lastProgressTs = now;
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

  function registerAdlib(node: HTMLElement, { lineIndex, adlibIndex }: { lineIndex: number; adlibIndex: number }) {
    if (!adlibRefs[lineIndex]) adlibRefs[lineIndex] = [];
    adlibRefs[lineIndex][adlibIndex] = node;
    return {
      destroy() {
        if (adlibRefs[lineIndex]) {
          delete adlibRefs[lineIndex][adlibIndex];
        }
      }
    };
  }

  interface PlainLineBlock {
    text: string;
    isBreak: boolean;
    adlibs?: AdlibItem[];
  }

  /**
   * Текст без синхронизации приходит одним блоком, и раньше его так и выводили —
   * `whitespace-pre-wrap` + `leading-loose`: строки растягивались во всю ширину панели,
   * а каждая пустая строка источника превращалась в дыру. Разбираем блок сами: строка
   * остаётся строкой, а любая пачка пустых строк сворачивается в один межстрофный
   * отступ. `displayLines` для этого не годится — там пустые строки уже потеряны.
   */
  function toPlainBlocks(text: string, withAdlibs: boolean): PlainLineBlock[] {
    const blocks: PlainLineBlock[] = [];
    for (const raw of (text || '').split('\n')) {
      const line = raw.trim();
      if (line) {
        if (withAdlibs) {
          const { mainText, adlibs } = extractAdlibs(line);
          blocks.push({
            text: mainText || (adlibs.length > 0 ? '\u00A0' : line),
            isBreak: false,
            adlibs
          });
        } else {
          blocks.push({ text: line, isBreak: false, adlibs: [] });
        }
      } else if (blocks.length && !blocks[blocks.length - 1].isBreak) {
        blocks.push({ text: '', isBreak: true });
      }
    }
    // Отступ в самом конце — такой же мусор, как лишняя пустая строка в источнике.
    if (blocks.length && blocks[blocks.length - 1].isBreak) blocks.pop();
    return blocks;
  }

  $: plainBlocks = toPlainBlocks(lyrics, adlibsEnabled);
</script>

<!-- svelte-ignore a11y-no-static-element-interactions -->
<div 
  class="h-full w-full flex-1 overflow-y-auto overflow-x-hidden scrollbar-hide px-12 py-16 relative {!$isPlaying ? 'lyrics-paused' : ''}"
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
      <div
        class="selectable flex flex-col gap-2"
        class:lyrics-line-sync={!letterSync}
        class:lyrics-letter-sync={letterSync}
      >
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
              class:has-adlibs={getLineAdlibs(line).length > 0}
              on:click={() => handleSeek(line.time)}
            >
              {#if getLineAdlibs(line).length > 0}
                <div
                  class="lyric-adlib-overlay"
                  class:is-backdrop={adlibStyle === 'backdrop'}
                  class:is-overlay={adlibStyle !== 'backdrop'}
                  aria-label="Ad-libs"
                >
                  {#each getLineAdlibs(line) as adlib, adlibIdx}
                    <span
                      class="lyric-adlib-callout"
                      class:is-backdrop={adlibStyle === 'backdrop'}
                      class:is-overlay={adlibStyle !== 'backdrop'}
                      class:is-long={adlib.text.length > 14}
                      use:registerAdlib={{ lineIndex: i, adlibIndex: adlibIdx }}
                      data-triggered="false"
                    >
                      <span class="lyric-adlib-halo" aria-hidden="true"></span>
                      <span class="lyric-adlib-text">{adlib.text}</span>
                    </span>
                  {/each}
                </div>
              {/if}

              <!-- Keep this condition inline: Svelte then tracks `activeIndex` as a template
                   dependency and swaps the three character-based lines at the exact line
                   change. Hiding that dependency inside a helper can leave the fragment
                   static in legacy reactivity mode. -->
              {#if letterSync && activeIndex >= 0 && Math.abs(i - activeIndex) <= 1}
                {@const effText = getEffectiveLineText(line)}
                {#if effText}
                  {@const cells = splitChars(effText)}
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
                  <span class="lyric-fill lyric-empty">&nbsp;</span>
                {/if}
              {:else}
                <span class="lyric-line-text" class:lyric-line-static={letterSync}>
                  {getEffectiveLineText(line) || '\u00A0'}
                </span>
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
          <div class="lyrics-plain-row">
            {#if block.adlibs && block.adlibs.length > 0}
              <div
                class="lyric-adlib-overlay"
                class:is-backdrop={adlibStyle === 'backdrop'}
                class:is-overlay={adlibStyle !== 'backdrop'}
                aria-label="Ad-libs"
              >
                {#each block.adlibs as adlib}
                  <span
                    class="lyric-adlib-callout"
                    class:is-backdrop={adlibStyle === 'backdrop'}
                    class:is-overlay={adlibStyle !== 'backdrop'}
                    class:is-long={adlib.text.length > 14}
                    data-triggered="true"
                  >
                    <span class="lyric-adlib-halo" aria-hidden="true"></span>
                    <span class="lyric-adlib-text">{adlib.text}</span>
                  </span>
                {/each}
              </div>
            {/if}
            <p class="lyrics-plain-line">{block.text}</p>
          </div>
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
