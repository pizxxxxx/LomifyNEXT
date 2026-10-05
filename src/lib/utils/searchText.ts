/** Shared ranking for catalog results and files, including incomplete words and typos. */
export function normalizeSearchText(value: unknown): string {
  return `${value ?? ''}`.toLocaleLowerCase('ru').normalize('NFKD')
    .replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

/** Adjacent transpositions count as one mistake. Inputs are bounded for interactive search. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length > 64 || b.length > 64) return 65;
  let before = Array.from({ length: b.length + 1 }, (_, i) => i);
  let previous = before;
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(row[j - 1] + 1, previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j], before[j - 2] + 1);
      }
    }
    before = previous;
    previous = row;
  }
  return previous[b.length];
}

function wordScore(word: string, query: string): number {
  if (word === query) return 1;
  if (query.length >= 2 && word.startsWith(query)) return 0.92;
  const allowance = query.length >= 8 ? 2 : query.length >= 4 ? 1 : 0;
  if (!allowance || Math.abs(word.length - query.length) > allowance) return 0;
  const distance = editDistance(word, query);
  return distance <= allowance ? 0.8 - distance * 0.12 : 0;
}

export function trackSearchScore(track: { title?: string; artist?: string }, query: string): number {
  const needle = normalizeSearchText(query);
  if (!needle) return 0;
  const title = normalizeSearchText(track.title);
  const artist = normalizeSearchText(track.artist);
  if (title === needle) return 1000;
  if (artist === needle) return 850;
  if (title.startsWith(needle)) return 720 + Math.max(0, 80 - (title.length - needle.length) * 2);
  if (artist.startsWith(needle)) return 650 + Math.max(0, 40 - (artist.length - needle.length) * 2);
  if (title.includes(needle)) return 580;
  if (artist.includes(needle)) return 520;
  const words = `${title} ${artist}`.split(' ').filter(Boolean);
  const scores = needle.split(' ').map(token => Math.max(0, ...words.map(word => wordScore(word, token))));
  if (scores.some(score => score === 0)) return 0;
  return 300 + scores.reduce((sum, score) => sum + score, 0) / scores.length * 180;
}

export function searchCorrections(query: string, phrases: string[]): string[] {
  const needle = normalizeSearchText(query);
  const tokens = needle.split(' ');
  const corrections = new Map<string, { query: string; distance: number }>();
  // A suggestion may complete the last word; it must not add an unrelated artist or genre.
  for (const phrase of phrases) {
    const normalized = normalizeSearchText(phrase);
    if (!normalized || normalized === needle || normalized.split(' ').length !== tokens.length) continue;
    const distance = editDistance(needle, normalized);
    const allowance = needle.length >= 8 ? 2 : needle.length >= 4 ? 1 : 0;
    if (allowance && (distance <= allowance || normalized.startsWith(needle))) {
      corrections.set(normalized, { query: phrase, distance });
    }
  }
  const vocabulary = new Set(phrases.flatMap(phrase => normalizeSearchText(phrase).split(' ')));
  const fixed = tokens.map(token => {
    if (vocabulary.has(token) || token.length < 4) return token;
    let best = token, bestScore = 0;
    for (const word of vocabulary) {
      const score = wordScore(word, token);
      if (score > bestScore) { best = word; bestScore = score; }
    }
    return bestScore >= 0.56 ? best : token;
  }).join(' ');
  if (fixed !== needle) corrections.set(fixed, { query: fixed, distance: editDistance(needle, fixed) });
  return [...corrections.values()].sort((a, b) => a.distance - b.distance).slice(0, 2).map(item => item.query);
}

export async function searchWithCorrections<T extends { id?: unknown; source?: string; title?: string; artist?: string }>(
  query: string,
  search: (query: string) => Promise<T[]>,
  suggest: (query: string) => Promise<string[]>,
  vocabulary: string[] = [],
  limit = 50
): Promise<{ tracks: T[]; correctedQuery?: string }> {
  const [initial, suggestions] = await Promise.allSettled([search(query), suggest(query)]);
  // A network failure is not an empty catalog and must stay visible to the caller.
  if (initial.status === 'rejected') throw initial.reason;
  const phrases = [...(suggestions.status === 'fulfilled' ? suggestions.value : []), ...vocabulary.slice(0, 4000)];
  const primary = initial.value;
  const normalizedQuery = normalizeSearchText(query);
  const exactMatch = primary.some(track => normalizeSearchText(track.title) === normalizedQuery
    || normalizeSearchText(track.artist) === normalizedQuery);
  const suggested = suggestions.status === 'fulfilled' ? suggestions.value : [];
  const completeQuery = !suggested.length || suggested.some(phrase => {
    const normalized = normalizeSearchText(phrase);
    return normalized === normalizedQuery || normalized.startsWith(`${normalizedQuery} `);
  });
  const variants = exactMatch && completeQuery ? [] : searchCorrections(query, phrases);
  // Unknown misspellings can still yield candidates by a stable prefix of the longest word.
  if (!variants.length && !primary.some(track => trackSearchScore(track, query) > 0)) {
    const tokens = normalizeSearchText(query).split(' ');
    const longest = tokens.reduce((best, token, i) => token.length > tokens[best].length ? i : best, 0);
    if (tokens[longest]?.length >= 6) {
      tokens[longest] = tokens[longest].slice(0, Math.max(4, Math.floor(tokens[longest].length * 0.6)));
      variants.push(tokens.join(' '));
    }
  }
  const extra = await Promise.allSettled(variants.map(variant => search(variant)));
  const merged = new Map<string, T>();
  for (const track of primary) merged.set(`${track.source}:${track.id ?? normalizeSearchText(`${track.title} ${track.artist}`)}`, track);
  let correctedQuery: string | undefined;
  extra.forEach((outcome, i) => {
    if (outcome.status !== 'fulfilled') return;
    for (const track of outcome.value) {
      if (!trackSearchScore(track, query)) continue;
      const key = `${track.source}:${track.id ?? normalizeSearchText(`${track.title} ${track.artist}`)}`;
      if (!merged.has(key)) { merged.set(key, track); correctedQuery ??= variants[i]; }
    }
  });
  return {
    tracks: [...merged.values()].map((track, order) => ({ track, order, score: trackSearchScore(track, query) }))
      .sort((a, b) => b.score - a.score || a.order - b.order).slice(0, limit).map(item => item.track),
    correctedQuery
  };
}
