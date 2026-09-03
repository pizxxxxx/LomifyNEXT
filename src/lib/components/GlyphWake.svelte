<script lang="ts">
  import { onMount } from 'svelte';

  export let enabled = true;
  export let scrollOffset = 0;

  type Glyph = {
    x: number;
    y: number;
    vx: number;
    vy: number;
    age: number;
    lifetime: number;
    seed: number;
    symbol: string;
    green: boolean;
    scrollsWithContent: boolean;
  };

  const SYMBOLS = ['#', '/', '\\', '+', '−', '>', '_', '*', '|', '=', '[', ']'];
  const COLUMN_WIDTH = 17;
  const ROW_HEIGHT = 22;
  const MAX_PARTICLES = 180;
  const MAX_CANVAS_PIXELS = 1_500_000;
  const FRAME_INTERVAL_MS = 1000 / 30;
  const EMIT_SPACING = 34;
  const MAX_PUFFS_PER_EVENT = 7;
  const COLLISION_DISTANCE = 13;
  const COLLISION_DISTANCE_SQ = COLLISION_DISTANCE * COLLISION_DISTANCE;
  const EDGE_RESTITUTION = 0.32;
  const MIN_EDGE_REBOUND = 14;

  let canvas: HTMLCanvasElement;
  let context: CanvasRenderingContext2D | null = null;
  let particles: Glyph[] = [];
  let frame = 0;
  let lastFrameAt = 0;
  let lastPointer: { x: number; y: number; time: number } | null = null;
  let distanceCarry = 0;
  let lastScrollOffset = 0;
  let renderScale = 1;
  let mounted = false;
  let windowFocused = true;
  let reducedMotion = false;
  let finePointer = false;

  function canRun() {
    return mounted
      && enabled
      && windowFocused
      && !document.hidden
      && finePointer
      && !reducedMotion;
  }

  function clearCanvas() {
    if (!context || !canvas) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(renderScale, 0, 0, renderScale, 0, 0);
  }

  function stop() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastFrameAt = 0;
    lastPointer = null;
    distanceCarry = 0;
    particles = [];
    clearCanvas();
  }

  function resize() {
    if (!canvas) return;
    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const pixelRatio = Math.max(1, window.devicePixelRatio || 1);

    // Даже на 4K поле остаётся одним небольшим буфером. Мягким символам не нужна
    // нативная плотность всего экрана, поэтому верхний предел одновременно экономит
    // видеопамять и не даёт декоративному слою конкурировать с обложками.
    renderScale = Math.min(pixelRatio, Math.sqrt(MAX_CANVAS_PIXELS / (width * height)));
    canvas.width = Math.max(1, Math.round(width * renderScale));
    canvas.height = Math.max(1, Math.round(height * renderScale));
    context = canvas.getContext('2d', { alpha: true, desynchronized: true });
    context?.setTransform(renderScale, 0, 0, renderScale, 0, 0);
  }

  function snap(value: number, step: number) {
    return Math.round(value / step) * step;
  }

  /**
   * Один вход курсора создаёт не линию вдоль траектории, а маленький сгусток в одной
   * ячейке. Радиальные импульсы разворачивают его наружу; направление движения мыши лишь
   * едва сдувает облако назад, поэтому на быстрых жестах не появляются прежние «рельсы».
   */
  function spawnPuff(x: number, y: number, pointerVx: number, pointerVy: number) {
    const sourceX = snap(x, COLUMN_WIDTH);
    const sourceY = snap(y, ROW_HEIGHT);
    const pointerSpeed = Math.hypot(pointerVx, pointerVy);
    const inheritedX = Math.max(-125, Math.min(125, pointerVx * 0.13));
    const inheritedY = Math.max(-125, Math.min(125, pointerVy * 0.13));
    const count = pointerSpeed > 1400 ? 2 : 3;
    const phase = Math.random() * Math.PI * 2;
    const scrollsWithContent = Boolean(document.elementFromPoint(x, y)?.closest('main'));

    for (let index = 0; index < count; index += 1) {
      const angle = phase + (index / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.42;
      const burstSpeed = 23 + Math.random() * 25;
      const nudge = 0.7 + Math.random() * 1.8;
      particles.push({
        x: sourceX + Math.cos(angle) * nudge,
        y: sourceY + Math.sin(angle) * nudge,
        vx: Math.cos(angle) * burstSpeed + inheritedX,
        vy: Math.sin(angle) * burstSpeed + inheritedY - 5,
        age: 0,
        lifetime: 2600 + Math.random() * 900,
        seed: Math.random() * Math.PI * 2,
        symbol: SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)],
        green: Math.random() < 0.2,
        scrollsWithContent
      });
    }

    if (particles.length > MAX_PARTICLES) {
      particles.splice(0, particles.length - MAX_PARTICLES);
    }
  }

  /** Небольшой упругий контакт не даёт символам схлопываться в одну дорожку. */
  function resolveCollisions() {
    for (let a = 0; a < particles.length - 1; a += 1) {
      const first = particles[a];
      for (let b = a + 1; b < particles.length; b += 1) {
        const second = particles[b];
        if (first.scrollsWithContent !== second.scrollsWithContent) continue;
        let dx = second.x - first.x;
        let dy = second.y - first.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq >= COLLISION_DISTANCE_SQ) continue;

        if (distanceSq < 0.01) {
          dx = Math.cos(first.seed - second.seed);
          dy = Math.sin(first.seed - second.seed);
          distanceSq = 1;
        }

        const distance = Math.sqrt(distanceSq);
        const nx = dx / distance;
        const ny = dy / distance;
        const overlap = (COLLISION_DISTANCE - distance) * 0.5;
        first.x -= nx * overlap;
        first.y -= ny * overlap;
        second.x += nx * overlap;
        second.y += ny * overlap;

        const relativeVelocity = (second.vx - first.vx) * nx + (second.vy - first.vy) * ny;
        if (relativeVelocity >= 0) continue;
        const impulse = -relativeVelocity * 0.58;
        first.vx -= impulse * nx;
        first.vy -= impulse * ny;
        second.vx += impulse * nx;
        second.vy += impulse * ny;
      }
    }
  }

  function update(elapsedMs: number) {
    const dt = elapsedMs / 1000;
    const drag = Math.exp(-0.82 * dt);

    particles = particles.filter((particle) => {
      particle.age += elapsedMs;
      if (particle.age >= particle.lifetime) return false;

      // Медленный поперечный поток даёт водяной завиток, но не двигает источник за
      // курсором. Всё остаётся локальным и после отпускания мыши спокойно рассеивается.
      particle.vx += Math.sin(particle.seed + particle.age * 0.0026) * 19 * dt;
      particle.vy += (Math.cos(particle.seed + particle.age * 0.0022) * 7 - 6) * dt;
      particle.vx *= drag;
      particle.vy *= drag;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;

      const edgeX = COLUMN_WIDTH * 0.5;
      const edgeY = ROW_HEIGHT * 0.5;
      const maxX = window.innerWidth - edgeX;
      const maxY = window.innerHeight - edgeY;
      if (particle.x < edgeX) {
        particle.x = edgeX;
        particle.vx = Math.max(MIN_EDGE_REBOUND, Math.abs(particle.vx) * EDGE_RESTITUTION);
      } else if (particle.x > maxX) {
        particle.x = maxX;
        particle.vx = -Math.max(MIN_EDGE_REBOUND, Math.abs(particle.vx) * EDGE_RESTITUTION);
      }
      if (particle.y < edgeY) {
        particle.y = edgeY;
        particle.vy = Math.max(MIN_EDGE_REBOUND, Math.abs(particle.vy) * EDGE_RESTITUTION);
      } else if (particle.y > maxY) {
        particle.y = maxY;
        particle.vy = -Math.max(MIN_EDGE_REBOUND, Math.abs(particle.vy) * EDGE_RESTITUTION);
      }
      return true;
    });

    resolveCollisions();
  }

  function paint() {
    if (!context) return;
    clearCanvas();
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    // На сетке в один момент виден только один знак в ячейке. Сами частицы продолжают
    // сталкиваться в непрерывных координатах, а отрисовка остаётся терминально строгой.
    const occupiedCells = new Set<string>();
    for (let index = particles.length - 1; index >= 0; index -= 1) {
      const particle = particles[index];
      const cellX = snap(particle.x, COLUMN_WIDTH);
      const cellY = snap(particle.y, ROW_HEIGHT);
      const cellKey = `${cellX}:${cellY}`;
      if (occupiedCells.has(cellKey)) continue;
      occupiedCells.add(cellKey);

      const progress = particle.age / particle.lifetime;
      const fadeIn = Math.min(1, particle.age / 160);
      const fadeOut = progress < 0.58 ? 1 : Math.pow((1 - progress) / 0.42, 1.65);
      const scale = 0.72 + Math.min(1, particle.age / 360) * 0.28;

      context.globalAlpha = (particle.green ? 0.28 : 0.19) * fadeIn * fadeOut;
      context.fillStyle = particle.green ? '#b9f8cc' : '#f4fff7';
      context.font = '600 14px ui-monospace, SFMono-Regular, Consolas, monospace';
      context.save();
      context.translate(cellX, cellY);
      context.scale(scale, scale);
      context.fillText(particle.symbol, 0, 0);
      context.restore();
    }
    context.globalAlpha = 1;
  }

  function draw(now: number) {
    frame = 0;
    if (!canRun() || !context) {
      stop();
      return;
    }

    if (lastFrameAt && now - lastFrameAt < FRAME_INTERVAL_MS) {
      frame = requestAnimationFrame(draw);
      return;
    }

    const elapsedMs = lastFrameAt ? Math.min(50, now - lastFrameAt) : FRAME_INTERVAL_MS;
    lastFrameAt = now;
    update(elapsedMs);
    paint();

    if (particles.length) frame = requestAnimationFrame(draw);
    else lastFrameAt = 0;
  }

  function wake() {
    if (!frame && particles.length) frame = requestAnimationFrame(draw);
  }

  function processPointerSample(event: PointerEvent) {
    const point = { x: event.clientX, y: event.clientY, time: event.timeStamp };
    if (!lastPointer) {
      lastPointer = point;
      return;
    }

    const elapsed = point.time - lastPointer.time;
    const dx = point.x - lastPointer.x;
    const dy = point.y - lastPointer.y;
    if (elapsed > 240) {
      lastPointer = point;
      distanceCarry = 0;
      return;
    }

    const distance = Math.hypot(dx, dy);
    if (distance < 0.5) {
      lastPointer = point;
      return;
    }

    const requestedPuffs = Math.floor((distanceCarry + distance) / EMIT_SPACING);
    const puffCount = Math.min(MAX_PUFFS_PER_EVENT, requestedPuffs);
    const pointerVx = (dx / Math.max(1, elapsed)) * 1000;
    const pointerVy = (dy / Math.max(1, elapsed)) * 1000;

    for (let index = 0; index < puffCount; index += 1) {
      // При обычной скорости сохраняем постоянный шаг сетки. Если WebView склеил много
      // событий в один большой скачок, распределяем ограниченное число сгустков по всему
      // отрезку — след догоняет курсор, но не рождает сотни частиц за один кадр.
      const along = requestedPuffs > MAX_PUFFS_PER_EVENT
        ? (index + 1) / puffCount
        : (EMIT_SPACING - distanceCarry + index * EMIT_SPACING) / distance;
      spawnPuff(
        lastPointer.x + dx * along,
        lastPointer.y + dy * along,
        pointerVx,
        pointerVy
      );
    }

    distanceCarry = requestedPuffs > MAX_PUFFS_PER_EVENT
      ? 0
      : distanceCarry + distance - requestedPuffs * EMIT_SPACING;
    lastPointer = point;
    if (puffCount) wake();
  }

  function onPointerMove(event: PointerEvent) {
    if (!canRun() || event.pointerType === 'touch') return;
    const coalesced = event.getCoalescedEvents?.() || [];
    for (const sample of coalesced) processPointerSample(sample);

    // Some WebViews omit the current event from their coalesced batch.
    // A duplicate endpoint is ignored by the sub-pixel distance guard.
    processPointerSample(event);
  }

  function applyScrollOffset(nextOffset: number) {
    const delta = nextOffset - lastScrollOffset;
    lastScrollOffset = nextOffset;
    if (!delta || !particles.length) return;
    for (const particle of particles) {
      if (particle.scrollsWithContent) particle.y -= delta;
    }
    wake();
  }

  $: if (mounted && !enabled) stop();
  $: if (mounted) applyScrollOffset(scrollOffset);

  onMount(() => {
    lastScrollOffset = scrollOffset;
    mounted = true;
    windowFocused = document.hasFocus();
    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointerQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
    const syncQueries = () => {
      reducedMotion = reduceQuery.matches;
      finePointer = pointerQuery.matches;
      if (!canRun()) stop();
    };
    const onVisibility = () => {
      if (document.hidden) stop();
    };
    const onBlur = () => {
      windowFocused = false;
      stop();
    };
    const onFocus = () => {
      windowFocused = true;
      lastPointer = null;
    };

    resize();
    syncQueries();
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('resize', resize, { passive: true });
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    reduceQuery.addEventListener('change', syncQueries);
    pointerQuery.addEventListener('change', syncQueries);

    return () => {
      mounted = false;
      stop();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      reduceQuery.removeEventListener('change', syncQueries);
      pointerQuery.removeEventListener('change', syncQueries);
    };
  });
</script>

<canvas bind:this={canvas} class="glyph-wake" aria-hidden="true"></canvas>

<style>
  .glyph-wake {
    position: absolute;
    inset: 0;
    z-index: 3;
    width: 100%;
    height: 100%;
    pointer-events: none;
    contain: strict;
  }
</style>
