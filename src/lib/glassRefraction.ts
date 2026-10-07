import { createRefractionProfile, lensVector } from './utils/glassRefraction';

type Quality = 'normal' | 'high' | 'off';
const NS = 'http://www.w3.org/2000/svg';
let nextId = 0;
const maps = new Map<string, { image: string; scale: number }>();

/** Only mounted glass surfaces own a filter. Text and controls stay sharp because
 * refraction is applied to their backdrop pseudo-element, never their content. */
export function glassRefraction(node: HTMLElement, initial: Quality) {
  let quality = initial;
  let svg: SVGSVGElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let size = '';
  const id = `lomify-lens-${++nextId}`;
  function clear() {
    svg?.remove(); svg = undefined;
    node.style.removeProperty('--lg-refraction');
    size = '';
  }
  function draw() {
    // Ordinary glass uses the compositor's blur plus static bezel highlights.
    // Only high quality pays for a live SVG backdrop displacement pass.
    if (quality !== 'high') { clear(); return; }
    const width = Math.round(node.clientWidth), height = Math.round(node.clientHeight);
    if (!width || !height) return;
    const radius = parseFloat(getComputedStyle(node).borderTopLeftRadius) || 24;
    const stamp = `${width}:${height}:${radius}:${quality}`;
    if (size === stamp) return;
    const key = `${width}:${height}:${radius}`;
    let map = maps.get(key);
    if (!map) {
      const canvas = document.createElement('canvas');
      const ratio = Math.min(1, 768 / width);
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(32, Math.round(height * ratio));
      const context = canvas.getContext('2d');
      if (!context) return;
      const pixels = context.createImageData(canvas.width, canvas.height);
      const bevel = Math.min(16, height / 3);
      const profile = createRefractionProfile(bevel, Math.min(36, height * .55));
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const [vx, vy] = lensVector((x + .5) * width / canvas.width, (y + .5) * height / canvas.height, width, height, radius, bevel, profile);
        const offset = (y * canvas.width + x) * 4;
        pixels.data[offset] = Math.round(127.5 + 127.5 * vx);
        pixels.data[offset + 1] = Math.round(127.5 + 127.5 * vy);
        pixels.data[offset + 2] = 128; pixels.data[offset + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      // SVG's channel range is [-.5, .5], hence twice the maximum ray offset.
      map = { image: canvas.toDataURL(), scale: 2 * profile.maximum };
      if (maps.size >= 6) maps.delete(maps.keys().next().value!);
      maps.set(key, map);
    }
    if (!svg) {
      svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = 'position:absolute;pointer-events:none';
      document.body.append(svg);
    }
    const filter = document.createElementNS(NS, 'filter');
    filter.id = id;
    for (const [key, value] of Object.entries({ x: '0', y: '0', width: `${width}`, height: `${height}`, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' })) filter.setAttribute(key, value);
    const primitive = (name: string, attributes: Record<string, string>) => {
      const child = document.createElementNS(NS, name);
      for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
      filter.append(child);
    };
    primitive('feImage', { href: map.image, x: '0', y: '0', width: `${width}`, height: `${height}`, preserveAspectRatio: 'none', result: 'lens' });
    primitive('feDisplacementMap', { in: 'SourceGraphic', in2: 'lens', scale: `${map.scale}`, xChannelSelector: 'R', yChannelSelector: 'G' });
    svg.replaceChildren(filter);
    node.style.setProperty('--lg-refraction', `url(#${id})`);
    size = stamp;
  }
  const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(draw, 100); });
  observer.observe(node); draw();
  return {
    update(next: Quality) { if (next !== quality) { quality = next; draw(); } },
    destroy() { clearTimeout(timer); observer.disconnect(); clear(); }
  };
}
