/**
 * Разбор подписи автора на отдельные имена.
 *
 * У совместной вещи в `track.artist` лежит склеенная строка: `mapYandexTrack` собирает её
 * как `artists.join(', ')`. Вся разметка показывала эту строку одной ссылкой, поэтому клик
 * по любому из имён вёл на страницу ПЕРВОГО — второго автора в приложении как будто не
 * существовало, хотя у Яндекса он приходит отдельной записью.
 *
 * Порядок доверия здесь важнее самого разбора:
 *   1. список от источника (`track.artists`) — это факт, его никогда не угадываем;
 *   2. и только если списка нет (SoundCloud, файлы с диска) — режем строку, и режем
 *      осторожно: лишнее деление хуже недостающего. Ложная ссылка выглядит рабочей и ведёт
 *      на пустую страницу, а склеенное имя хотя бы честно открывает того, кто там указан.
 */

/**
 * Разделители, которые не встречаются внутри имени: запятая, точка с запятой и пометки
 * участия. `&`, ` x `, `+` намеренно НЕ здесь — это части настоящих названий («Simon &
 * Garfunkel», «Florence + the Machine»), а у SoundCloud в поле автора стоит имя аккаунта:
 * разрезав его, мы получим два имени, под которыми на сервисе нет никого.
 */
const SEPARATORS = /\s*[,;]\s*|\s+(?:feat|ft|featuring)\.?\s+|\s+при\s+участии\s+/i;

/**
 * Слова, с которых начинается продолжение имени, а не следующий автор: «Tyler, The
 * Creator» — один человек. Дешёвая проверка, которая закрывает почти все настоящие имена с
 * запятой внутри.
 */
const CONTINUATION = /^(?:the|and|или|и)\b/i;

function dedupe(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

export function splitArtists(
  artist: string | null | undefined,
  list?: string[] | null
): string[] {
  const fromSource = (list ?? []).map((n) => `${n ?? ''}`.trim()).filter(Boolean);
  if (fromSource.length > 0) return dedupe(fromSource);

  const whole = `${artist ?? ''}`.trim();
  if (!whole) return [];

  const parts = whole.split(SEPARATORS).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return [whole];
  // Одна подозрительная часть отменяет всё деление, а не выбрасывается: «Tyler, The
  // Creator» — это либо два автора, либо ни одного, серединного верного разбора тут нет.
  if (parts.some((p) => p.length < 2 || CONTINUATION.test(p))) return [whole];

  return dedupe(parts);
}
