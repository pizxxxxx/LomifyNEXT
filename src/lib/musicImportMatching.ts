export interface ImportMatchSeed {
  title: string;
  artists: string[];
  durationMs: number;
}

export function normalizeImportText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').normalize('NFC').toLocaleLowerCase('ru-RU')
    .replace(/\b(?:feat|ft)\.?\b/gu, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function similarity(left: string, right: string): number {
  const a = new Set(normalizeImportText(left).split(' ').filter(Boolean));
  const b = new Set(normalizeImportText(right).split(' ').filter(Boolean));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap++;
  return 2 * overlap / (a.size + b.size);
}

// Count markers as well as their kind: "Live Forever (Live)" differs from "Live Forever".
const EDITIONS = [
  /(?:^|\s)(?:remix|ремикс)(?=\s|$)/g,
  /(?:^|\s)(?:live|concert|концерт|концертная|концертныи)(?=\s|$)/g,
  /(?:^|\s)(?:acoustic|акустика|акустическая|акустическии|unplugged)(?=\s|$)/g,
  /(?:^|\s)(?:sped\s*up|speed\s*up|speedup|nightcore|ускоренная|ускоренныи)(?=\s|$)/g,
  /(?:^|\s)(?:slowed|slow\s*down|замедленная|замедленныи)(?=\s|$)/g,
  /(?:^|\s)(?:instrumental|инструментал|караоке|karaoke)(?=\s|$)/g,
  /(?:^|\s)(?:cover|кавер|tribute|parody|пародия)(?=\s|$)/g,
  /(?:^|\s)(?:ai|ии|suno|udio|неиро\p{L}*)(?=\s|$)/gu,
  /(?:^|\s)(?:clean|censored|цензурная)(?=\s|$)/g,
  /(?:^|\s)(?:explicit|uncensored|uncut|без\s+цензуры)(?=\s|$)/g,
  /(?:^|\s)(?:radio\s+edit|extended|club\s+mix)(?=\s|$)/g,
];

function editionCounts(title: string): number[] {
  const normalized = normalizeImportText(title);
  return EDITIONS.map(pattern => [...normalized.matchAll(pattern)].length);
}

export function scoreImportCandidate(seed: ImportMatchSeed, candidate: any): number {
  const title = normalizeImportText(seed.title);
  const candidateTitle = normalizeImportText(String(candidate?.title || ''));
  if (!title || !candidateTitle || candidate?.isBanned || candidate?.available === false) return 0;
  const expectedEditions = editionCounts(seed.title);
  if (editionCounts(candidateTitle).some((count, index) => count !== expectedEditions[index])) return 0;
  const expectedArtists = seed.artists.map(normalizeImportText).filter(Boolean);
  const rawArtists = Array.isArray(candidate?.artists) && candidate.artists.length
    ? candidate.artists : [candidate?.artist];
  const actualArtists = rawArtists.map((artist: unknown) => normalizeImportText(String(artist || ''))).filter(Boolean);
  // A cover or AI uploader is also evidence, unless that marker belongs to the expected artist.
  const expectedArtistMarks = editionCounts(seed.artists.join(' '));
  if (editionCounts(rawArtists.join(' ')).slice(6, 8)
    .some((count, index) => count > expectedArtistMarks[index + 6] && !expectedEditions[index + 6])) return 0;

  const duration = Number(candidate?.duration);
  const hasDuration = duration > 0 && seed.durationMs > 0;
  const difference = hasDuration ? Math.abs(duration - seed.durationMs) : Infinity;
  if (hasDuration && difference > Math.max(9000, seed.durationMs * 0.05)) return 0;

  let titleScore = title === candidateTitle ? 55 : similarity(title, candidateTitle) * 50;
  if (title.includes(candidateTitle) || candidateTitle.includes(title)) titleScore = Math.max(titleScore, 40);
  let artistScore = 0;
  for (const expected of expectedArtists) for (const actual of actualArtists) {
    artistScore = Math.max(artistScore, expected === actual ? 35
      : expected.includes(actual) || actual.includes(expected) ? 27 : similarity(expected, actual) * 30);
  }
  if (titleScore < 35 || artistScore < 20) return 0;
  if (!hasDuration && (title !== candidateTitle || artistScore < 27)) return 0;
  return titleScore + artistScore + (difference <= 3000 ? 15 : difference <= 9000 ? 8 : 0);
}

export function bestImportMatch(seed: ImportMatchSeed, candidates: any[]): any | null {
  let best: any = null;
  let score = 0;
  for (const candidate of candidates) {
    const next = scoreImportCandidate(seed, candidate);
    if (next > score) { best = candidate; score = next; }
  }
  return score >= 75 ? best : null;
}
