export type WaveContentMode = 'all' | 'lyrics' | 'instrumental';

export const WAVE_LANGUAGES = [
  { id: '', label: 'Любой язык', hint: 'Не ограничивать язык песни' },
  { id: 'ru', label: 'Русский', hint: 'Песни преимущественно на русском' },
  { id: 'en', label: 'Английский', hint: 'Песни преимущественно на английском' },
  { id: 'other', label: 'Другой', hint: 'Остальные языки' }
] as const;

export const WAVE_GENRES = [
  { id: 'pop', label: 'Поп', hint: 'Поп-хиты и поп-музыка', aliases: ['pop', 'поп', 'ruspop', 'rus pop', 'russian pop', 'foreign pop', 'dance pop', 'synthpop', 'synth pop', 'electropop', 'k pop', 'j pop', 'estrada', 'эстрада'] },
  { id: 'rap', label: 'Рэп и хип-хоп', hint: 'Рэп, трэп, дрилл и хип-хоп', aliases: ['rap', 'рэп', 'rusrap', 'rus rap', 'russian rap', 'foreignrap', 'foreign rap', 'hiphop', 'hip hop', 'хип хоп', 'trap', 'трэп', 'drill', 'дрилл', 'grime', 'cloud rap', 'boom bap'] },
  { id: 'rock', label: 'Рок', hint: 'От классического до альтернативного', aliases: ['rock', 'рок', 'allrock', 'all rock', 'rusrock', 'rus rock', 'russian rock', 'foreignrock', 'foreign rock', 'alternative', 'альтернатива', 'grunge', 'hard rock', 'classic rock', 'progressive rock', 'post rock', 'folk rock', 'pop rock', 'rock n roll', 'britpop'] },
  { id: 'electronic', label: 'Электроника', hint: 'Хаус, техно, транс и EDM', aliases: ['electronic', 'electronics', 'electronica', 'электроника', 'dance', 'club', 'house', 'хаус', 'techno', 'техно', 'ambient', 'эмбиент', 'trance', 'edm', 'electro', 'idm', 'dubstep', 'drum and bass', 'drum bass', 'dnb', 'breakbeat', 'garage', 'hardstyle', 'future bass', 'synthwave'] },
  { id: 'indie', label: 'Инди', hint: 'Инди-поп и независимая сцена', aliases: ['indie', 'инди', 'indie pop', 'indiepop', 'indie rock', 'indierock', 'bedroom pop', 'dream pop', 'shoegaze'] },
  { id: 'metal', label: 'Метал', hint: 'Тяжёлая музыка и металкор', aliases: ['metal', 'метал', 'heavy metal', 'metalcore', 'deathcore', 'nu metal', 'death metal', 'black metal', 'doom metal', 'power metal', 'thrash metal', 'industrial metal'] },
  { id: 'punk', label: 'Панк', hint: 'Панк-рок, поп-панк и хардкор', aliases: ['punk', 'панк', 'punk rock', 'pop punk', 'post punk', 'postpunk', 'hardcore punk', 'skate punk'] },
  { id: 'phonk', label: 'Фонк', hint: 'Phonk, drift и мемфис-звук', aliases: ['phonk', 'фонк', 'drift phonk', 'memphis'] },
  { id: 'rnb', label: 'R&B и соул', hint: 'R&B, соул и нео-соул', aliases: ['rnb', 'r b', 'rus rnb', 'rhythm and blues', 'soul', 'соул', 'neo soul', 'neosoul', 'contemporary rnb'] },
  { id: 'lofi', label: 'Лоу-фай', hint: 'Спокойные биты и chillhop', aliases: ['lofi', 'lo fi', 'лоу фай', 'лоуфай', 'лофи', 'chillhop', 'chill out', 'chillout', 'downtempo', 'study beats'] },
  { id: 'jazz', label: 'Джаз', hint: 'Джаз и фьюжн', aliases: ['jazz', 'джаз', 'fusion', 'фьюжн', 'bebop', 'swing', 'smooth jazz', 'acid jazz'] },
  { id: 'classical', label: 'Классика', hint: 'Классика, опера и неоклассика', aliases: ['classical', 'classic', 'классика', 'neoclassical', 'неоклассика', 'opera', 'опера', 'chamber music', 'orchestral', 'symphonic'] },
  { id: 'soundtrack', label: 'Саундтреки', hint: 'Музыка из кино, игр и аниме', aliases: ['soundtrack', 'саундтрек', 'film music', 'музыка кино', 'game music', 'игровая музыка', 'score', 'ost', 'anime', 'аниме', 'musical'] }
] as const;

export interface WaveFilterState {
  waveContent?: string;
  waveGenre?: string;
  waveLanguage?: string;
}

function normalize(value: unknown): string {
  return `${value ?? ''}`
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/[^a-zа-яё0-9]+/gi, ' ')
    .replace(/\s+/g, ' ');
}

function genreStringsMatch(actual: string, alias: string): boolean {
  if (actual === alias) return true;
  const compactActual = actual.replace(/\s/g, '');
  const compactAlias = alias.replace(/\s/g, '');
  if (compactActual === compactAlias) return true;

  // Яндекс смешивает обычные названия (`foreign rock`) и идентификаторы (`foreignrock`).
  // Включение нужно для таких пар и поджанров (`synthpop` -> `pop`), но только начиная с
  // трёх символов, чтобы короткая служебная метка не совпала почти со всем списком.
  const shorter = Math.min(compactActual.length, compactAlias.length);
  return shorter >= 3 && (
    actual.includes(alias) ||
    compactActual.includes(compactAlias)
  );
}

function appendGenreValues(target: string[], value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) appendGenreValues(target, item);
    return;
  }
  if (typeof value === 'string' || typeof value === 'number') target.push(`${value}`);
}

function trackGenreValues(track: any): string[] {
  const raw: string[] = [];
  appendGenreValues(raw, track?.genre);
  appendGenreValues(raw, track?.genres);
  appendGenreValues(raw, track?.album?.genre);
  appendGenreValues(raw, track?.album?.genres);
  appendGenreValues(raw, track?.tags);

  for (const album of Array.isArray(track?.albums) ? track.albums : []) {
    appendGenreValues(raw, album?.genre);
    appendGenreValues(raw, album?.genres);
  }
  for (const artist of Array.isArray(track?.artists) ? track.artists : []) {
    if (typeof artist !== 'object' || artist === null) continue;
    appendGenreValues(raw, artist.genre);
    appendGenreValues(raw, artist.genres);
  }

  return Array.from(new Set(raw.map(normalize).filter(Boolean)));
}

export function hasWaveFilters(state: WaveFilterState): boolean {
  return state.waveContent === 'lyrics' ||
    state.waveContent === 'instrumental' ||
    Boolean(normalize(state.waveGenre)) ||
    Boolean(normalize(state.waveLanguage));
}

export function waveLanguageLabel(id: string | null | undefined): string {
  return WAVE_LANGUAGES.find((language) => language.id === (id ?? ''))?.label ?? 'Любой язык';
}

export function waveGenreLabel(id: string | null | undefined): string {
  return WAVE_GENRES.find((genre) => genre.id === id)?.label ?? '';
}

export function describeWaveFilters(state: WaveFilterState): string {
  const parts: string[] = [];
  if (state.waveContent === 'lyrics') parts.push('только с текстом');
  if (state.waveContent === 'instrumental') parts.push('без слов');
  const language = WAVE_LANGUAGES.find((item) => item.id === state.waveLanguage);
  if (language?.id) parts.push(language.label.toLocaleLowerCase('ru-RU'));
  const genre = waveGenreLabel(state.waveGenre);
  if (genre) parts.push(genre.toLocaleLowerCase('ru-RU'));
  return parts.join(', ');
}

export function trackMatchesWaveGenre(track: any, state: WaveFilterState): boolean {
  const wanted = normalize(state.waveGenre);
  if (!wanted) return true;

  const definition = WAVE_GENRES.find((genre) => genre.id === wanted);
  const aliases = definition?.aliases ?? [wanted];
  const normalizedAliases = aliases.map(normalize).filter(Boolean);
  const actualGenres = trackGenreValues(track);
  if (normalizedAliases.some((alias) =>
    actualGenres.some((actual) => genreStringsMatch(actual, alias))
  )) return true;

  // У SoundCloud и части старых сохранённых треков жанр отсутствует. В этом случае лучше
  // использовать явный жанровый тег в названии/исполнителе, чем отбрасывать кандидата
  // без единой попытки. При наличии нормальных метаданных этот запасной путь не включается.
  if (actualGenres.length > 0) return false;
  const fallbackText = normalize([track?.title, track?.artist].filter(Boolean).join(' '));
  if (normalizedAliases.some((alias) => genreStringsMatch(fallbackText, alias))) return true;

  // Rotor иногда присылает трек без жанров альбома. Неизвестное значение не является
  // несовпадением: отбрасывать такие карточки означало получать пустую волну при живой
  // станции. Явно присланный чужой жанр по-прежнему отсеивается строкой выше.
  return track?.source === 'yandex';
}

function normalizedTrackLanguage(track: any): string {
  const raw = normalize(track?.lyricsLanguage ?? track?.language);
  if (raw === 'ru' || raw.startsWith('rus') || raw.startsWith('рус')) return 'ru';
  if (raw === 'en' || raw.startsWith('eng') || raw.startsWith('англ')) return 'en';
  if (raw) return 'other';

  // Запасной сигнал только при отсутствии метаданных: название не гарантирует язык слов,
  // но для кириллических и латинских релизов это лучше, чем отбрасывать всю порцию вслепую.
  const label = `${track?.title ?? ''} ${track?.artist ?? ''}`;
  if (/[а-яё]/i.test(label)) return 'ru';
  if (/[a-z]/i.test(label)) return 'en';
  return '';
}

function trackMatchesWaveLanguage(track: any, state: WaveFilterState): boolean {
  const wanted = normalize(state.waveLanguage);
  if (!wanted || state.waveContent === 'instrumental') return true;
  const actual = normalizedTrackLanguage(track);
  if (!actual) return track?.source === 'yandex';
  return wanted === 'other' ? actual !== 'ru' && actual !== 'en' : actual === wanted;
}

export function trackMatchesWaveFilters(track: any, state: WaveFilterState): boolean {
  // `undefined` у Rotor означает, что конкретная порция не прислала lyricsInfo, а не то,
  // что текста точно нет. Отбрасываем только явное `false`, иначе строгий фильтр съедал
  // большую часть живой станции из-за неполных метаданных.
  if (state.waveContent === 'lyrics' && track?.lyricsAvailable === false) return false;
  if (state.waveContent === 'instrumental') {
    if (track?.lyricsAvailable === true) return false;
    if (track?.lyricsAvailable !== false) {
      const label = normalize(`${track?.title ?? ''} ${track?.version ?? ''}`);
      if (!/(^| )(instrumental|инструментал|karaoke|караоке|minus|минус)( |$)/.test(label)) return false;
    }
  }
  return trackMatchesWaveLanguage(track, state) && trackMatchesWaveGenre(track, state);
}
