/** Rounded bezel geometry in CSS pixels. The flat interior stays neutral. */
export function roundedDistance(x: number, y: number, width: number, height: number, radius: number): number {
  const r = Math.min(radius, width / 2, height / 2);
  const dx = Math.abs(x - width / 2) - width / 2 + r;
  const dy = Math.abs(y - height / 2) - height / 2 + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}

export interface RefractionProfile {
  samples: Float32Array;
  maximum: number;
}

/** One air-to-glass refraction through a convex squircle cross-section. Ray slopes
 * are calculated once for the bezel, rather than per pixel or animation frame. */
export function createRefractionProfile(bevel = 16, thickness = 24, index = 1.5): RefractionProfile {
  const samples = new Float32Array(128);
  let maximum = 0;
  if (bevel <= 0 || thickness <= 0 || index <= 1) return { samples, maximum };
  const eta = 1 / index;
  for (let i = 1; i < samples.length - 1; i++) {
    const t = i / (samples.length - 1);
    const base = 1 - (1 - t) ** 4;
    const height = thickness * base ** .25;
    const slope = thickness / bevel * (1 - t) ** 3 / base ** .75;
    const normalZ = 1 / Math.hypot(slope, 1);
    const normalX = slope * normalZ;
    const transmitted = Math.sqrt(1 - eta * eta * (1 - normalZ * normalZ));
    const bend = transmitted - eta * normalZ;
    const distance = height * bend * normalX / (eta + bend * normalZ);
    samples[i] = distance;
    maximum = Math.max(maximum, distance);
  }
  return { samples, maximum };
}

const defaultProfile = createRefractionProfile();

export function lensVector(x: number, y: number, width: number, height: number, radius: number, bevel = 16, profile = defaultProfile): [number, number] {
  const d = roundedDistance(x, y, width, height, radius);
  if (d >= 0 || -d >= bevel || !profile.maximum) return [0, 0];
  const dx = roundedDistance(x + .5, y, width, height, radius) - roundedDistance(x - .5, y, width, height, radius);
  const dy = roundedDistance(x, y + .5, width, height, radius) - roundedDistance(x, y - .5, width, height, radius);
  const norm = Math.hypot(dx, dy) || 1;
  const position = -d / bevel * (profile.samples.length - 1);
  const first = Math.floor(position);
  const fraction = position - first;
  const bend = (profile.samples[first] * (1 - fraction) + profile.samples[first + 1] * fraction) / profile.maximum;
  // SVG samples P + scale * (channel - .5). A convex lens samples toward its
  // interior, so the field points opposite to the outward border normal.
  return [-dx / norm * bend, -dy / norm * bend];
}
