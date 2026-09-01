import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { get } from 'svelte/store';
import { settings, notify } from './stores';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  searchYandex,
  getYandexSimilar,
  getYandexStreamUrl,
  yandexArtistProfile,
  yandexArtistTracks,
  yandexArtistAlbums,
  yandexAlbumTracks,
  getYandexLyrics
} from './yandex';
import {
  getCachedLastFmDiscoveryArtists,
  getCachedLastFmKnownTracks,
  getCachedLastFmTasteArtists
} from './lastfm';

export async function safeFetch(url: string, options?: any) {
  try {
    if (window && '__TAURI_INTERNALS__' in window) {
      return await tauriFetch(url, options);
    }
  } catch (err) {
    console.warn("Tauri fetch unavailable or failed, falling back to window.fetch", err);
  }
  
  try {
    const res = await window.fetch(url, options);
    if (!res.ok) throw new Error("Fetch failed");
    return res;
  } catch (e) {
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(url)}`;
    return window.fetch(proxyUrl, options);
  }
}

let soundcloudClientId: string | null = null;

export async function getSoundCloudClientId() {
  if (soundcloudClientId) return soundcloudClientId;
  try {
    const res = await safeFetch('https://soundcloud.com');
    const text = await res.text();
    const scriptUrls = [...text.matchAll(/src="(https:\/\/[^"]+\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1]);
    
    for (const url of scriptUrls.reverse()) { 
      const scriptRes = await safeFetch(url);
      const scriptText = await scriptRes.text();
      const match = scriptText.match(/client_id[\s:=]+["']([a-zA-Z0-9_-]{32})["']/i) || scriptText.match(/client_id=([a-zA-Z0-9_-]{32})/i);
      if (match) {
        soundcloudClientId = match[1];
        return soundcloudClientId;
      }
    }
  } catch (err) {
    console.error("Failed to get SC client ID:", err);
  }
  return 'a3e059563d7fd3372b49b37f00a00bcf'; // final fallback
}

/**
 * Порядок, в котором стоит пробовать transcoding'и SoundCloud.
 *
 * Ключевой факт, из которого всё следует: SoundCloud перечисляет transcoding'и в своём
 * порядке, и progressive стоит в нём ПОСЛЕДНИМ. Живая выдача для обычного трека выглядит
 * так: `aac_160k/hls`, `aac_96k/hls`, `abr_sq/hls`, `mp3_1_0/hls`, и только затем
 * `mp3_1_0/progressive`. Кто берёт «первую ссылку», тот всегда получает HLS-плейлист.
 *
 * Ранжируем по хвосту адреса, а не по полю `format.protocol`, потому что в сохранённых
 * треках (лайки, база, кэш ленты) от transcoding'а осталась только строка URL — протокол
 * при маппинге терялся. Хвост же в ней сохранился: `/stream/progressive`, `/stream/hls`,
 * `/stream/cbc-encrypted-hls`.
 *
 * Зашифрованные варианты не берём вовсе: ключ к ним выдаёт лицензионный сервер Apple
 * FairPlay, расшифровать нечем, а по факту такая ссылка отдаёт манифест, который дальше
 * притворяется битым аудио.
 */
const PROTOCOL_RANK: Array<[marker: string, rank: number]> = [
  ['encrypted-hls', -1],  // DRM — не пробуем совсем
  ['/progressive', 0],    // один файл: играет сразу, без сборки сегментов
  ['/hls', 1],            // плейлист: собирается в Rust (shared/hls.rs)
];

function streamUrlRank(url: string): number {
  const path = (url.split('?')[0] || '').toLowerCase();
  let rank = 1.5; // незнакомый хвост — пробуем, но после понятных
  for (const [marker, value] of PROTOCOL_RANK) {
    if (path.includes(marker)) {
      rank = value;
      break;
    }
  }
  if (rank < 0) return rank;
  // У треков с `policy: SNIP` доступен только 30-секундный отрывок, и его transcoding'и
  // помечены `/preview/`. Полноценной замены им нет, поэтому оставляем в самом конце: лучше
  // отрывок, чем молчание, но только когда ничего другого нет.
  return isPreviewUrl(url) ? rank + 10 : rank;
}

function isPreviewUrl(url: string): boolean {
  return (url.split('?')[0] || '').toLowerCase().includes('/preview');
}

/**
 * Отбирает и упорядочивает адреса потоков. `dropped` — сколько отброшено как защищённые:
 * по нему вызывающая сторона отличает «ничего не нашлось» от «всё, что есть, под DRM».
 */
export function rankStreamUrls(urls: string[]): { ranked: string[]; dropped: number } {
  const unique: string[] = [];
  for (const url of urls) {
    const clean = url?.split('?')[0];
    if (clean && !unique.includes(clean)) unique.push(clean);
  }

  const usable = unique.filter((u) => streamUrlRank(u) >= 0);
  usable.sort((a, b) => streamUrlRank(a) - streamUrlRank(b));
  return { ranked: usable, dropped: unique.length - usable.length };
}

export function findBestTranscoding(media: any) {
  if (!media || !media.transcodings) return null;
  const transcodings = media.transcodings;

  // Preset preferences: progressive first (mp3, aac, opus)
  const progressive = transcodings.filter((t: any) => t.format?.protocol === 'progressive');
  if (progressive.length > 0) {
    const presetOrder = ['mp3_1_0', 'aac_160k', 'opus_0_0'];
    for (const preset of presetOrder) {
      const match = progressive.find((t: any) => t.preset === preset || t.preset?.includes(preset));
      if (match) return match.url;
    }
    return progressive[0].url;
  }

  // Progressive-варианта нет — берём лучший из оставшихся тем же порядком, что и плеер.
  // Раньше здесь стояло `transcodings[0].url`, то есть в `audioUrl` попадал в том числе
  // зашифрованный поток, который не сыграет ни при каких условиях.
  const { ranked } = rankStreamUrls(transcodings.map((t: any) => t.url).filter(Boolean));
  return ranked[0] || null;
}

export async function searchSoundCloud(query: string, limit: number = 15, strict = false) {
  try {
    const clientId = await getSoundCloudClientId();
    const url = `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=${limit}`;
    
    const response = await safeFetch(url, { method: 'GET' });
    if (!response.ok) throw new Error('Network response was not ok: ' + response.status);
    
    const data = await response.json();
      return data.collection.filter((t: any) => t && t.id).map((t: any) => {
        const cover = t.artwork_url ? t.artwork_url.replace('large', 't500x500') : '';
        const avatar = t.user?.avatar_url ? t.user.avatar_url.replace('large', 't500x500') : '';
        return {
          id: t.id,
          title: t.title,
          artist: t.user?.username || 'Unknown',
          coverUrl: cover,
          artistAvatarUrl: avatar,
          permalinkUrl: t.permalink_url || '',
          albumTitle: t.publisher_metadata?.album_title || '',
          genre: t.genre || '',
          playbackCount: t.playback_count || 0,
          likesCount: t.likes_count || 0,
          releaseDate: t.release_date || t.created_at || t.display_date || '',
          duration: t.duration || 0,
          audioUrl: findBestTranscoding(t.media),
          transcodings: t.media?.transcodings?.map((tr: any) => `${tr.url}?client_id=${clientId}`) || [],
          source: 'soundcloud',
          isBanned: t.policy === 'BLOCK' || t.policy === 'SNIP' || t.access === 'blocked' || !(t.media?.transcodings?.length > 0)
        };
      }).filter((t: any) => t.title);
  } catch (err) {
    console.error("SoundCloud search error:", err);
    if (strict) throw err;
    return [];
  }
}

/**
 * "What plays next" when the queue runs dry. SoundCloud's own related graph first; if the
 * track has none (local file, fresh upload), fall back to the personalised feed — which
 * needs the library passed in, otherwise autoplay drops you into cold-start picks that
 * have nothing to do with what you were just listening to.
 */
export async function getRelatedTracks(track: any, likedTracks: any[] = [], listenStats: any = null, playlists: any[] = []) {
  // Яндексовый трек нельзя продолжать фидом SoundCloud: автоплей уводил бы человека в
  // другой источник посреди прослушивания. Похожие спрашиваем там же, где играет трек.
  if (track.source === 'yandex' && track.id) {
    const current = get(settings);
    if (current.yandexToken) {
      try {
        const similar = await getYandexSimilar(current.yandexToken, track.id, 15);
        if (similar.length > 0) return similar;
      } catch (e) {
        console.error('[yandex] похожие треки не пришли', e);
      }
    }
  }
  if (track.source === 'soundcloud' && track.id) {
    const related = await fetchRelatedTracks(track.id, 15);
    if (related.length > 0) return related;
  }
  return await getTrendingTracks(likedTracks, listenStats, [], playlists);
}

/**
 * SoundCloud's own "related tracks" for one track id. Split out of `getRelatedTracks`
 * so the recommendation builder can call it without the trending-tracks fallback —
 * that fallback calls `getTrendingTracks`, which would recurse straight back here.
 */
async function fetchRelatedTracks(trackId: string | number, limit = 15) {
  try {
    const clientId = await getSoundCloudClientId();
    const url = `https://api-v2.soundcloud.com/tracks/${trackId}/related?client_id=${clientId}&limit=${limit}`;
    const res = await safeFetch(url, { method: 'GET' });
    const data = await res.json();
    if (!data.collection) return [];

    return data.collection.filter((t: any) => t && t.id).map((t: any) => {
      const cover = t.artwork_url ? t.artwork_url.replace('large', 't500x500') : '';
      const avatar = t.user?.avatar_url ? t.user.avatar_url.replace('large', 't500x500') : '';
      return {
        id: t.id,
        title: t.title,
        artist: t.user?.username || 'Unknown',
        coverUrl: cover,
        artistAvatarUrl: avatar,
        permalinkUrl: t.permalink_url || '',
        genre: t.genre || '',
        playbackCount: t.playback_count || 0,
        likesCount: t.likes_count || 0,
        releaseDate: t.release_date || t.created_at || t.display_date || '',
        duration: t.duration || 0,
        audioUrl: findBestTranscoding(t.media),
        transcodings: t.media?.transcodings?.map((tr: any) => `${tr.url}?client_id=${clientId}`) || [],
        source: 'soundcloud',
        isBanned: t.policy === 'BLOCK' || t.policy === 'SNIP' || t.access === 'blocked' || !(t.media?.transcodings?.length > 0)
      };
    }).filter((t: any) => t.title);
  } catch (e) {
    console.error("Failed to fetch related SC tracks:", e);
    return [];
  }
}

export async function getTrackInfo(trackId: string | number) {
  try {
    const clientId = await getSoundCloudClientId();
    const url = `https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${clientId}`;
    const res = await safeFetch(url, { method: 'GET' });
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    console.error("Failed to fetch track info:", e);
  }
  return null;
}

export async function getSoundCloudPlaylists(query: string = 'phonk', limit: number = 3, strict = false) {
  try {
    const clientId = await getSoundCloudClientId();
    const url = `https://api-v2.soundcloud.com/search/playlists_without_albums?q=${encodeURIComponent(query)}&client_id=${clientId}&limit=${limit}&representation=full`;
    const res = await safeFetch(url, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const playlists = [];
      for (const p of data.collection) {
        let tracksToUse = p.tracks || [];
        const missingIds = tracksToUse.filter((t: any) => !t.title).map((t: any) => t.id);
        
        if (missingIds.length > 0) {
          const chunkSize = 50;
          let fetchedTracks: any[] = [];
          for (let i = 0; i < missingIds.length; i += chunkSize) {
            const chunk = missingIds.slice(i, i + chunkSize);
            const tracksUrl = `https://api-v2.soundcloud.com/tracks?ids=${chunk.join(',')}&client_id=${clientId}`;
            const tracksRes = await safeFetch(tracksUrl, { method: 'GET' });
            if (tracksRes.ok) {
              const chunkData = await tracksRes.json();
              fetchedTracks = fetchedTracks.concat(chunkData);
            }
          }
          tracksToUse = tracksToUse.map((t: any) => {
            const fullTrack = fetchedTracks.find((ft: any) => ft.id === t.id);
            return fullTrack ? fullTrack : t;
          });
        }
        
        const validTracks = tracksToUse.map((t: any) => {
          const cover = t.artwork_url ? t.artwork_url.replace('large', 't500x500') : (p.artwork_url ? p.artwork_url.replace('large', 't500x500') : '');
          const avatar = t.user?.avatar_url ? t.user.avatar_url.replace('large', 't500x500') : '';
          return {
            id: t.id,
            title: t.title,
            artist: t.user?.username || 'Unknown',
            coverUrl: cover,
            artistAvatarUrl: avatar,
            permalinkUrl: t.permalink_url || '',
            genre: t.genre || '',
            playbackCount: t.playback_count || 0,
            likesCount: t.likes_count || 0,
            releaseDate: t.release_date || t.created_at || t.display_date || '',
            duration: t.duration || 0,
            audioUrl: findBestTranscoding(t.media),
            transcodings: t.media?.transcodings?.map((tr: any) => `${tr.url}?client_id=${clientId}`) || [],
            source: 'soundcloud'
          };
        }).filter((t: any) => t.title && (t.audioUrl || t.transcodings?.length > 0));

        if (validTracks.length > 0) {
          playlists.push({
            id: `sc_playlist_${p.id}`,
            title: p.title,
            tracks: validTracks
          });
        }
      }
      return playlists;
    }
  } catch (e) {
    console.error("Failed to fetch SC playlists:", e);
    if (strict) throw e;
  }
  return [];
}

/**
 * Curated cold-start pool. Used only when there is nothing to personalise on yet —
 * no likes, no history, no playlists. Once you have listened to anything at all, the
 * feed is built from that instead.
 */
const CURATED_ARTIST_POOL = [
    'Morgenshtern', 'Toxi$', 'Big Baby Tape', 'Kizaru', 'Aarne', 'Friendly Thug 52 Ngg', 'Alblak 52', 'Bushido Zho', 'Scally Milano', 'Uglystephan', 'Heronwater', 'Yeei', 'Platina', 'OG Buda', 'MAYOT', 'SEEMEE', '163ONMYNECK', 'Pinq', 'Voskr8', 'Xcho', 'CUPSIZE', 'тёмный принц', 'Паранойя', 'sexyswag.', 'greyrock', 'tewiq', 'Рэйчи', 'Юпи', 'Villian', 'Katastrofa.', 'Kai Angel', '9mice', 'Viperr', 'Lovesomemama', 'Rocket', 'LIL VAN', 'Lovesleep', 'Bnz', 'Fresco', 'Kid Sole', 'Sqwore', 'skurt', 'g0ner', '17 SEVENTEEN', 'rizza', 'LXNER', 'quiizzzmeow', 'Midix', 'treepside', '3TERNITY', 'LOLIWZ', 'lil 17th', 'HOROSHIYAGNI', 'liberum', 'pyatno', 'WENARO', 'хочуспать', 'JojoHF', 'КАКАЯ РАЗНИЦА', 'Rory in early 20s', 'shadowraze', 'zxcursed', 'hikikomori kai', 'mu護', 'shinra', 'Kaito Shoma', 'DVRST', 'PlayaPhonk', 'ghostface playa', 'Lida', 'CMH', 'findmyname', 'glwzbll', 'GSPD', 'Dead Blonde', 'Ssshhhiiittt!', 'Пошлая Молли', 'DK', 'BOOKER', 'Pepel Nahudi', 'FORTUNA 812', 'Baby Melo', 'NEWLIGHTCHILD', 'xxxmanera', 'Macan', 'Jakone', 'A.V.G', 'Misha Xramovi', 'Niletto', 'PHARAOH', 'Boulevard Depo', 'i61', 'Jeembo', 'Tveth', 'Saluki', 'Lizer', 'Flesh', 'Thrill Pill', 'Face', 'Yanix', 'Markul', 'Obladaet', 'Thomas Mraz', 'LSP', 'Oxxxymiron', 'Feduk', 'Allj', 'T-Fest', 'Scriptonite', '10age', 'Sqwoz Bab', 'Slava Marlow', 'Soda Luv', 'Blago White', 'GONE.Fludd', 'IOCK', 'CAKEBOY', 'Flipper Floyd', 'Clonnex', 'Shiki', 'unki', 'Glocki52', 'SaintWorld', 'Icegergert', 'Noize MC', 'Anacondaz', 'Pyrokinesis', 'mzlff', 'Слава КПСС', 'Замай', 'Хаски', 'Масло черного тмина', 'Loc-Dog', 'Johnyboy', 'Schokk', 'Czar', 'ST', 'REPAC', 'Егор Крид', 'Мот', "L'One", 'Тимати', 'Джиган', 'Natan', 'Pacha TQ', 'Guf', 'Slimus', 'Птаха', 'Баста', 'Смоки Мо', 'Рем Дигга', 'Типси Тип', 'MiyaGi', 'Andy Panda', 'TumaniYO', 'H loyalty', 'Mav-d', 'Ollane', 'Krec', 'Ассаи', 'Каста', 'Влади', 'Шым', 'Хамиль', 'Змей', 'Триада', 'Нигатив', 'Многоточие', 'Руставели', 'Ю.Г.', 'D.O.B. Community', 'Лигалайз', 'Децл', 'Bad Balance', 'Шеff', 'Михей', 'Кровосток', '25/17', 'Грот', 'Миша Маваши', 'Ярмак', 'Стольный Град', 'Брутто', 'ВесЪ', 'Зануда', 'Гио Пика', 'Честный', 'Нурминский', 'Ганвест', 'homie', 'Леша Свик', 'Зомб', 'Jah Khalib', 'HammAli', 'Navai', "Ramil'", 'Jony', 'Elman', 'Andro', 'Gafur', 'The Limba', 'Idris & Leos', 'Bahh Tee', 'Kavabanga Depo Kolibri', '10iz', 'Truwer', '104', 'Niman', 'Benz', 'Kali', 'Murovei', 'VibeTGK', 'Jahmal TGK', 'Триагрутрика', 'ОУ74', 'Пастор Напас', 'Manky Monk', 'Казян', 'Сын Окопа', 'КУОК', 'БУЕРАК', 'Перемотка', 'Черная Речка', 'Источник', 'Пасош', 'автоспорт', 'Валентин Дядька', 'Кис-Кис', 'найтивыход', 'эхопрокуренныхподъездов', 'вы соглашаетесь', 'вожатый', 'увула', 'созвездие отрезок', 'Синекдоха Монток', 'Сироткин', 'Антоха МС', 'Cream Soda', 'Грязь', 'Монеточка', 'Kedr Livanskiy', 'IC3PEAK', 'Pussy Riot', 'Coldcloud', 'Why, Berry', 'Offmi', 'Marco9', 'Lil Krystalll', 'Shaitan', 'YNGLY', 'LOV66', 'Malenkiyyy', 'ooes', 'zoloto', 'петля пристрастия', 'Валентин Стрикало', 'Нервы', 'Женя Мильковский', 'Гречка', 'Алена Швец', 'Дайте Танк (!)', 'Краснознаменная Дивизия Имени Моей Бабушки', 'Комсомольск', 'Хадн Дадн', 'Shortparis', 'СБПЧ', 'Глюкоза', 'Линда', 'Дельфин', 'Дубовый Гаайъ', 'Мальчишник', 'Сектор Газа', 'Красная Плесень', 'Кирпичи', 'Аигел', '2H Company'
];

const COLD_START_GENRES = ['Популярные хиты 2024', 'русские хиты', 'русский рэп', 'mylancore', 'madk1d', 'tiktok remix', 'hyperpop', 'русская попса', 'russian pop', 'russian rap', 'phonk', 'lofi'];

/** Normalised key for "same artist" / "same track" comparisons. */
function normKey(v: string | undefined | null) {
  return (v || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function pickRandom<T>(arr: T[], n: number): T[] {
  // Fisher–Yates. `sort(() => 0.5 - Math.random())` is not a uniform shuffle — it leans
  // towards keeping the original order, which is why the feed used to look almost the
  // same after a refresh.
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, Math.max(0, n));
}

interface TasteProfile {
  /** normalised artist -> weight, roughly "how much you play them" */
  artists: Map<string, number>;
  /** normalised genre -> weight */
  genres: Map<string, number>;
  /** original casing for artist names, for building search queries */
  displayNames: Map<string, string>;
  /** liked SoundCloud track ids — seeds for SoundCloud's own /related graph */
  seedIds: (string | number)[];
  /** то же для Яндекса: у графа похожих треков в каждом сервисе свои идентификаторы */
  yandexSeedIds: (string | number)[];
  /** how much signal we have at all; decides whether the cold-start pool kicks in */
  strength: number;
}

/**
 * Turns the user's library into weights. A like is the most explicit statement of taste,
 * repeat plays are weaker but broader, hand-made playlists sit in between.
 */
function buildTasteProfile(likedTracks: any[], listenStats: any, playlists: any[]): TasteProfile {
  const artists = new Map<string, number>();
  const genres = new Map<string, number>();
  const displayNames = new Map<string, string>();
  const seedIds: (string | number)[] = [];
  const yandexSeedIds: (string | number)[] = [];

  const bump = (map: Map<string, number>, raw: string | undefined, by: number) => {
    const key = normKey(raw);
    if (!key) return;
    map.set(key, (map.get(key) || 0) + by);
    if (map === artists && raw && !displayNames.has(key)) displayNames.set(key, raw);
  };

  // Идентификатор трека имеет смысл только внутри своего сервиса: спросить SoundCloud про
  // похожие на яндексовый id — это гарантированный 404, а не «просто пустой ответ».
  // Поэтому затравки собираются в два списка, и берётся тот, который соответствует
  // выбранному источнику.
  const seed = (t: any) => {
    if (!t?.id) return;
    if (t.source === 'soundcloud') seedIds.push(t.id);
    else if (t.source === 'yandex') yandexSeedIds.push(t.id);
  };

  for (const t of likedTracks || []) {
    // Лайк — самый явный сигнал: он должен перевешивать случайный единичный запуск и
    // присутствие трека в большой подборке.
    bump(artists, t?.artist, 5);
    bump(genres, t?.genre, 2.5);
    seed(t);
  }

  const history = listenStats?.history ? (Object.values(listenStats.history) as any[]) : [];
  for (const h of history) {
    // Логарифм отличает «послушал один раз» от «возвращаюсь постоянно», но сотое
    // прослушивание не способно навсегда запереть ленту на одном исполнителе.
    const repeats = Math.max(1, Number(h?.count) || 1);
    bump(artists, h?.artist, Math.min(5, 1 + Math.log2(repeats + 1) * 1.25));
    bump(genres, h?.genre, Math.min(2, Math.log2(repeats + 1) * 0.45));
  }

  // Last.fm уже объединяет прослушивания из разных плееров. Берём только сохранённый
  // месячный топ: сеть здесь не трогаем, а его вес держим ниже явного лайка в Lomify.
  // Так связь полезна для главной, но не может перетянуть рекомендации на себя.
  const lastFmArtists = getCachedLastFmTasteArtists();
  for (const [index, artist] of lastFmArtists.entries()) {
    const recencyWeight = Math.max(1.4, 3.2 - index * 0.38);
    const repeatWeight = Math.min(1.2, Math.log2(Math.max(1, artist.playcount) + 1) * 0.18);
    bump(artists, artist.name, recencyWeight + repeatWeight);
  }
  const lastFmDiscovery = getCachedLastFmDiscoveryArtists();
  for (const artist of lastFmDiscovery) {
    // Похожесть — исследовательский сигнал: он помогает открыть нового автора, но не
    // должен конкурировать с лайком или реально прослушанным исполнителем.
    bump(artists, artist.name, 0.55 + artist.match * 0.7);
  }

  let playlistTrackCount = 0;
  for (const pl of playlists || []) {
    for (const t of pl?.tracks || []) {
      playlistTrackCount += 1;
      bump(artists, t?.artist, 0.85);
      bump(genres, t?.genre, 0.4);
      seed(t);
    }
  }

  return {
    artists,
    genres,
    displayNames,
    seedIds,
    yandexSeedIds,
    // Плейлист тоже выводит из cold start, но его размер учитывается с сильным насыщением:
    // подборка на 500 треков не должна затоптать лайки и историю.
    strength: (likedTracks?.length || 0) * 2
      + history.length
      + Math.min(12, playlistTrackCount * 0.25)
      + Math.min(8, lastFmArtists.length * 1.25)
      + Math.min(3, lastFmDiscovery.length * 0.25),
  };
}

function topKeys(map: Map<string, number>, n: number) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(e => e[0]);
}

/**
 * Home-page recommendations.
 *
 * The old version padded its query list up to six entries from the ~300-name curated
 * pool, so on any normal library most of what you saw had nothing to do with you. And
 * ranking was `playbackCount * random()`, which means the most popular track of an
 * unrelated query always beat a perfect match from your own taste.
 *
 * Now the seeds come from what you actually listen to — the host service's own "related
 * tracks" for your likes first (that is a real similarity graph, not a keyword guess),
 * then your favourite artists and the genres your own tracks carry. The curated pool is
 * a cold-start fallback only. Ranking scores taste first and treats popularity as a
 * small log-scaled tiebreak.
 *
 * Хост берётся из настроек — тот же, что у поиска и «моей волны». Раньше лента была
 * прибита к SoundCloud, поэтому при выбранной Яндекс.Музыке главная выдавала треки не из
 * того сервиса, которым человек пользуется.
 */
export async function getTrendingTracks(likedTracks: any[] = [], listenStats: any = null, searchHistory: string[] = [], playlists: any[] = []) {
  const taste = buildTasteProfile(likedTracks, listenStats, playlists);
  const favArtists = topKeys(taste.artists, 12);
  const favGenres = topKeys(taste.genres, 6);
  const recentSearches = (searchHistory || [])
    .map(normKey)
    .filter(Boolean)
    .slice(0, 3);
  const lastFmDiscovery = getCachedLastFmDiscoveryArtists();

  const current = get(settings);
  const yandexToken = current.yandexToken;
  const yandexIsHost = current.searchSource === 'yandex' && Boolean(yandexToken);

  // --- Seeds ---------------------------------------------------------------------
  const seedsFor = (host: 'yandex' | 'soundcloud') => {
    const pool = host === 'yandex' ? taste.yandexSeedIds : taste.seedIds;
    return pickRandom([...new Set(pool)].slice(0, 60), taste.strength > 10 ? 4 : 3);
  };
  const primaryHost: 'yandex' | 'soundcloud' = yandexIsHost ? 'yandex' : 'soundcloud';
  const primarySeeds = seedsFor(primaryHost);

  const queries = new Set<string>();
  // Два главных исполнителя присутствуют всегда — раньше чистый random мог выкинуть обоих
  // и «персональная» выдача после обновления внезапно меняла жанр. Ещё два слота остаются
  // исследовательскими, чтобы лента не превращалась в повтор одной библиотеки.
  [...favArtists.slice(0, 2), ...pickRandom(favArtists.slice(2), 2)]
    .forEach(a => queries.add(taste.displayNames.get(a) || a));
  [...favGenres.slice(0, 1), ...pickRandom(favGenres.slice(1), 1)].forEach(g => queries.add(g));
  pickRandom(lastFmDiscovery, 2).forEach((artist) => queries.add(artist.name));
  if (searchHistory?.[0]?.trim()) queries.add(searchHistory[0].trim());

  // Cold start: nothing to personalise on, so show something good rather than nothing.
  if (primarySeeds.length === 0 && queries.size < 3) {
    pickRandom(CURATED_ARTIST_POOL, 4 - queries.size).forEach(a => queries.add(a));
    pickRandom(COLD_START_GENRES, 2).forEach(g => queries.add(g));
  }

  /**
   * Одна попытка собрать ленту в конкретном сервисе. `ok` — удался ли хоть один запрос:
   * по нему отличается «сервис ответил, но у него для нас ничего нет» от «сервис вообще
   * не ответил» (протухший токен, сеть). Пустой ответ отдаём как есть — молча подменять
   * источник нельзя, — а вот полный отказ разумно закрыть падением на SoundCloud.
   */
  const gather = async (host: 'yandex' | 'soundcloud', seeds: (string | number)[]) => {
    const [relatedResults, searchResults] = await Promise.all([
      Promise.allSettled(seeds.map(id => host === 'yandex'
        ? getYandexSimilar(yandexToken as string, id as string, 20)
        : fetchRelatedTracks(id, 20))),
      Promise.allSettled([...queries].map(q => host === 'yandex'
        ? searchYandex(yandexToken as string, q, 30)
        : searchSoundCloud(q, 30))),
    ]);

    // Anything /related handed back gets a standing bonus in the ranking below.
    const fromRelated = new Set<string | number>();
    const tracks: any[] = [];
    let ok = false;
    for (const res of relatedResults) {
      if (res.status !== 'fulfilled') continue;
      ok = true;
      for (const t of res.value || []) { fromRelated.add(t.id); tracks.push(t); }
    }
    for (const res of searchResults) {
      if (res.status !== 'fulfilled') continue;
      ok = true;
      if (res.value && res.value.length > 0) tracks.push(...res.value);
    }
    return { tracks, fromRelated, ok };
  };

  let gathered = await gather(primaryHost, primarySeeds);
  if (yandexIsHost && !gathered.ok) gathered = await gather('soundcloud', seedsFor('soundcloud'));

  const fromRelated = gathered.fromRelated;
  let sc: any[] = gathered.tracks;

  // Remove exact duplicates from multiple searches. У одного и того же трека может быть
  // разный id в двух ответах/обёртках, поэтому одной проверки id недостаточно.
  const uniqueSc = new Map<string, any>();
  for (const track of sc) {
    const signature = track?.title && track?.artist
      ? `${normKey(track.title)}\u0000${normKey(track.artist)}`
      : `${track?.source || primaryHost}:${track?.id || ''}`;
    if (!uniqueSc.has(signature)) uniqueSc.set(signature, track);
  }
  sc = Array.from(uniqueSc.values());
  if (sc.length === 0) return [];

  // Filter out compilations/mixes > 5 minutes (300000 ms)
  let filtered = sc.filter((t: any) => t.duration > 0 && t.duration <= 300000);

  // Unplayable tracks are worse than boring ones — but only drop them while we still
  // have a feed left afterwards.
  const playable = filtered.filter((t: any) => !t.isBanned);
  if (playable.length >= 20) filtered = playable;

  // Filter out known tracks (liked, listened, in playlists)
  const knownSignatures = new Set<string>();
  const addKnown = (t: any) => {
    if (t?.title && t?.artist) knownSignatures.add(`${normKey(t.title)}-${normKey(t.artist)}`);
  };
  (likedTracks || []).forEach(addKnown);
  if (listenStats?.history) Object.values(listenStats.history).forEach(addKnown);
  (playlists || []).forEach(pl => (pl?.tracks || []).forEach(addKnown));
  getCachedLastFmKnownTracks().forEach(addKnown);

  filtered = filtered.filter((t: any) => !knownSignatures.has(`${normKey(t.title)}-${normKey(t.artist)}`));
  // Не возвращаем исходный пул как запасной вариант: в нём как раз лежат уже известные
  // треки, включая содержимое собственных плейлистов. Пустая честная выдача лучше, чем
  // снова показать то, что пользователь попросил убрать с главной.
  if (filtered.length === 0) return [];

  // --- Ranking -------------------------------------------------------------------
  // Taste first, popularity as a gentle tiebreak: `log10` stops a 20M-play track from
  // outranking a 50k-play one by six orders of magnitude. The difference between
  // "popular" and "very popular" should not decide what a personal feed looks like.
  const maxArtistWeight = Math.max(1, ...taste.artists.values());
  const genreAffinity = new Set<string>();
  for (const genre of favGenres) {
    genreAffinity.add(genre);
    genre.split(/[\s,;/|&()+_-]+/).filter((part) => part.length > 2).forEach((part) => genreAffinity.add(part));
  }

  const scoreOf = (t: any) => {
    let s = 0;
    const aw = taste.artists.get(normKey(t.artist));
    if (aw) s += 2.8 + 2.4 * (aw / maxArtistWeight);      // your own artist: strongest signal
    const gk = normKey(t.genre);
    if (gk && taste.genres.has(gk)) {
      s += 1.5;
    } else if (gk) {
      const parts = gk.split(/[\s,;/|&()+_-]+/).filter((part) => part.length > 2);
      if (parts.some((part) => genreAffinity.has(part))) s += 0.8;
    }
    if (fromRelated.has(t.id)) s += 2.2;                  // host service says it's similar

    // Недавний точный поиск — полезный, но краткосрочный сигнал. Он слабее лайка/повторов,
    // зато поднимает конкретно найденный звук, а не случайную популярность по тому же слову.
    const text = `${normKey(t.artist)} ${normKey(t.title)}`;
    const searchIndex = recentSearches.findIndex((q) => q.length > 2 && text.includes(q));
    if (searchIndex >= 0) s += 1.1 / (searchIndex + 1);

    s += Math.log10((t.playbackCount || 0) + 10) / 8;     // ≈0.13 … 0.95
    s += Math.random() * 0.35;                            // keeps «обновить» meaningful
    return s;
  };

  const ranked = filtered
    .map((t: any) => ({ t, s: scoreOf(t) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 180)
    .map(x => x.t);

  // Не больше четырёх треков одного автора за выдачу. Прежнее правило лишь раздвигало их,
  // поэтому запрос по любимому артисту мог незаметно занять половину всей главной.
  const FEED_LIMIT = 72;
  const MAX_PER_ARTIST = 4;
  const spaced: any[] = [];
  const perArtist = new Map<string, number>();
  const remaining = [...ranked];
  while (remaining.length > 0 && spaced.length < FEED_LIMIT) {
    const lastArtist = normKey(spaced[spaced.length - 1]?.artist);
    let index = remaining.findIndex((track) => {
      const artist = normKey(track.artist);
      return artist !== lastArtist && (perArtist.get(artist) || 0) < MAX_PER_ARTIST;
    });
    if (index < 0) {
      index = remaining.findIndex((track) => (perArtist.get(normKey(track.artist)) || 0) < MAX_PER_ARTIST);
    }
    if (index < 0) break;
    const [track] = remaining.splice(index, 1);
    const artist = normKey(track.artist);
    perArtist.set(artist, (perArtist.get(artist) || 0) + 1);
    spaced.push(track);
  }

  return spaced;
}

/**
 * Единственная точка входа поиска для всего интерфейса, поэтому переключение источника
 * живёт здесь: иначе про `searchSource` пришлось бы помнить каждому вызывающему.
 *
 * Пустой ответ Яндекса возвращаем как есть — молча подменять источник, когда человек
 * выбрал его руками, значит врать про то, что играет. А вот сорвавшийся запрос (истёк
 * токен, нет сети) — не повод оставлять человека вообще без результатов.
 */
export interface SearchResponse {
  tracks: any[];
  /** Фактический источник результата: при недоступном Яндексе им может стать SoundCloud. */
  source: 'soundcloud' | 'yandex';
  fallbackUsed: boolean;
}

/**
 * Версия поиска со статусом источника для экрана выдачи. Старый `performSearch` ниже
 * оставлен как компактный API для мест, которым нужны только треки.
 */
export async function performSearchDetailed(query: string): Promise<SearchResponse> {
  const current = get(settings);
  if (current.searchSource === 'yandex' && current.yandexToken) {
    try {
      return {
        tracks: await searchYandex(current.yandexToken, query, 50),
        source: 'yandex',
        fallbackUsed: false
      };
    } catch (e) {
      console.error('[yandex] поиск не удался, отдаём SoundCloud', e);
      return {
        tracks: await searchSoundCloud(query, 50, true),
        source: 'soundcloud',
        fallbackUsed: true
      };
    }
  }
  return {
    tracks: await searchSoundCloud(query, 50, true),
    source: 'soundcloud',
    fallbackUsed: false
  };
}

export async function performSearch(query: string) {
  return (await performSearchDetailed(query)).tracks;
}

/**
 * Соответствия «трек, найденный в SoundCloud → id того же трека в Яндекс Музыке».
 *
 * Нужны, потому что искать двойника приходится по названию: общего идентификатора у двух
 * сервисов нет и быть не может. Один поиск — это лишние сотни миллисекунд перед началом
 * звука, и платить их при каждом повторном запуске одного и того же трека незачем.
 *
 * На диск попадают только НАЙДЕННЫЕ соответствия. «Не нашлось» живёт до перезапуска: каталог
 * Музыки пополняется, и запомненный навсегда отказ означал бы, что трек не заиграет из
 * Яндекса даже через год после появления там. В пределах сеанса отказ помнить обязательно —
 * иначе каждый запуск трека, которого в Музыке нет, снова стоил бы поиска.
 */
const yandexTwins = new Map<string, string | null>();
const YANDEX_TWINS_KEY = 'lomifynext_yandex_twins';

if (typeof window !== 'undefined' && window.localStorage) {
  try {
    const saved = localStorage.getItem(YANDEX_TWINS_KEY);
    if (saved) {
      for (const [key, id] of Object.entries(JSON.parse(saved) as Record<string, string>)) {
        if (id) yandexTwins.set(key, `${id}`);
      }
    }
  } catch (e) {
    console.warn('[yandex] карта соответствий не прочиталась', e);
  }
}

function saveYandexTwins() {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const positive: Record<string, string> = {};
  for (const [key, id] of yandexTwins) {
    if (id) positive[key] = id;
  }
  try {
    localStorage.setItem(YANDEX_TWINS_KEY, JSON.stringify(positive));
  } catch (e) {
    console.warn('[yandex] карта соответствий не сохранилась', e);
  }
}

/**
 * Приводит название к виду, в котором его можно сравнивать между сервисами.
 *
 * Отдельно от `lyricsNorm` сознательно: тот готовит строку для базы текстов и вычищает в том
 * числе `remix`, `slowed`, `sped`, `reverb` — для текста песни это правда шум, слова те же.
 * Здесь так нельзя: замедленная версия и оригинал — разное аудио, и склеив их одним ключом,
 * плеер под названием оригинала заиграл бы ремикс. Убираем только то, что к самой музыке
 * отношения не имеет: обёртки скобок (внутренность остаётся), пометки заливки и слова
 * авторства — их два сервиса пишут по-разному.
 */
const MATCH_NOISE = /\b(official|audio|video|lyric|lyrics|hd|hq|free|dl|download|premiere|out now|prod|feat|ft|by)\b/g;

function matchNorm(v: string): string {
  return (v || '')
    .toLowerCase()
    .replace(/[[\](){}]/g, ' ')
    .replace(MATCH_NOISE, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Совпадают ли названия с точностью до шума. `strict` — только полное равенство.
 *
 * Нестрогая проверка нужна, потому что хвосты вроде «(prod. X)» или «[Free DL]» есть только
 * у одной стороны, а состав исполнителей два сервиса пишут по-разному («Kizaru» против
 * «Kizaru, Big Baby Tape»). Поэтому короткая строка ищется в длинной — но по ГРАНИЦАМ СЛОВ и
 * с запасом: «Up» лежит внутри «Wake Up», не будучи тем же названием, поэтому одиночное
 * короткое слово вложенностью не считается.
 */
function namesMatch(a: string, b: string, strict: boolean): boolean {
  const x = matchNorm(a);
  const y = matchNorm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  if (strict) return false;

  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.split(' ').length < 2 && short.length < 4) return false;
  return ` ${long} `.includes(` ${short} `);
}

/**
 * Ищет тот же трек в Яндекс Музыке. Три исхода, и они разные:
 * строка — id двойника, `null` — в Музыке трека точно нет (поиск прошёл, совпадений не
 * нашлось), `undefined` — не выясняли или не смогли. Различать обязательно: на `null`
 * плеер имеет право сказать человеку «в Музыке этого трека нет», а на оборванном запросе
 * такая фраза была бы просто ложью про каталог.
 *
 * Три проверки совпадения, и все обязательны. Название и исполнитель — потому что поиск
 * отвечает похожим, а не точным: по запросу с названием трека Музыка охотно вернёт кавер,
 * другой трек того же артиста или трек с тем же названием у другого. Длительность —
 * последняя защита от подмены версии: ремикс, radio edit и «extended» отличаются от
 * оригинала заметно больше, чем на допуск. Мы обещаем человеку тот трек, на который он нажал.
 */
async function findYandexTwin(
  track: any,
  token: string,
  allowSearch: boolean
): Promise<string | null | undefined> {
  const artistKey = matchNorm(track?.artist || '');
  const titleKey = matchNorm(track?.title || '');
  // Совпадение проверяется по двум полям сразу, поэтому без любого из них искать нечего:
  // поиск бы состоялся, а принять его результат мы всё равно не смогли бы.
  if (!artistKey || !titleKey) return undefined;
  const key = `${artistKey}|${titleKey}`;

  const cached = yandexTwins.get(key);
  if (cached !== undefined) return cached;
  if (!allowSearch) return undefined;

  let found: any[] = [];
  try {
    found = await searchYandex(token, `${track.artist} ${track.title}`, 10);
  } catch (e) {
    // Сеть или токен — не факт о каталоге: не запоминаем и не утверждаем ничего.
    console.warn('[yandex] поиск двойника не удался', e);
    return undefined;
  }

  const want = Number(track.duration) || 0;
  const pick = (strict: boolean) =>
    found.find((c: any) => {
      if (!c?.id || c.isBanned) return false;
      if (!namesMatch(track.title, c.title, strict)) return false;
      if (!namesMatch(track.artist, c.artist, strict)) return false;
      const other = Number(c.duration) || 0;
      // Длительности нет — не повод отбрасывать: остаются название и исполнитель. Допуск в
      // 7 секунд закрывает разницу в тишине на концах и в сведении, но не версию трека.
      return !want || !other || Math.abs(want - other) <= 7000;
    });

  // Сначала точное совпадение и только потом приблизительное: иначе среди «Blinding Lights» и
  // «Blinding Lights (Instrumental)» победил бы тот, кто выше в выдаче, а не тот, кто назван
  // так же. Длительность у версий часто одинаковая, и на неё тут надежды нет.
  const twin = pick(true) || pick(false);

  const id = twin ? `${twin.id}` : null;
  yandexTwins.set(key, id);
  if (id) saveYandexTwins();
  return id;
}

/**
 * Ссылка на поток для запуска трека.
 *
 * `silent` — для превью по наведению и трейлеров плейлиста: там вызов происходит от движения
 * мыши, и уведомление про 30-секундный отрывок превратилось бы в поток всплывашек. Само
 * ограничение при этом никуда не денется — про него скажут при обычном запуске.
 */
export async function getAudioUrl(track: any, opts: { silent?: boolean } = {}) {
  if (!track) return null;
  if (track.isLocal || track.source === 'local' || track.source === 'Локальный') {
    return convertFileSrc(track.audioUrl);
  }

  const current = get(settings);

  /**
   * Яндекс Музыка как хост потока.
   *
   * Источник в настройках выбирает не только то, где искать: выбрав Яндекс, человек выбрал,
   * ОТКУДА слушать. А `source` у трека — это лишь то, где его когда-то нашли, и в полках,
   * лайках и ленте лежат треки SoundCloud, которые в Музыке есть целиком. Раньше решение
   * принималось по `source`, поэтому при выбранном Яндексе плеер шёл в SoundCloud, там
   * получал 30-секундный отрывок (`policy: SNIP`) или защищённый DRM поток — и сообщал про
   * ограничения SoundCloud, которого человек вообще не выбирал.
   *
   * Двойник ищется только при обычном запуске. У превью по наведению вызов идёт от движения
   * мыши, и поиск в Музыке на каждое наведение — это десятки запросов ни за чем; там берём
   * уже известное соответствие, если оно есть, и не ищем новое. Отрывок для наведения и так
   * достаточен, он затем и нужен.
   */
  const yandexIsHost = current.searchSource === 'yandex' && Boolean(current.yandexToken);
  let yandexMissedTrack = false;
  if (yandexIsHost && track.source !== 'yandex') {
    const twinId = await findYandexTwin(track, current.yandexToken, !opts.silent);
    if (twinId) {
      try {
        const url = await getYandexStreamUrl(current.yandexToken, twinId);
        if (url) return url;
      } catch (e) {
        // Подпись не выдали (истёк токен, нет Плюса на этот трек) — не тупик: ниже ещё есть
        // SoundCloud, и молча уйти в него лучше, чем отказать целиком.
        console.warn('[yandex] поток двойника не получен, играем из SoundCloud', e);
      }
    } else if (twinId === null) {
      // Именно `null`, а не любой «не сыграло»: только он означает, что поиск прошёл и трека
      // в Музыке нет. Про это можно говорить человеку (см. `explain` ниже).
      yandexMissedTrack = true;
    }
  }

  // Подписанная ссылка Яндекса живёт минуты, поэтому берётся в момент запуска, а не при
  // поиске. Заголовков к ней не нужно — `audio_load_url` в Rust скачает её как есть.
  // Отсутствие токена — не «нет ссылки», а неподключённый источник: молчаливый `null`
  // здесь выглядел бы как заблокированный трек, поэтому говорим прямо.
  if (track.source === 'yandex') {
    if (!current.yandexToken) {
      throw new Error('Яндекс Музыка не подключена — вставьте токен в настройках.');
    }
    return await getYandexStreamUrl(current.yandexToken, track.id);
  }

  if (track.source === 'soundcloud') {
    // Если источником выбран Яндекс, к любому отказу SoundCloud надо добавлять, почему до
    // него вообще дошло дело: иначе ограничения одного сервиса выглядят как поведение
    // другого — ровно та путаница, из-за которой человек видел «SoundCloud не отдаёт больше
    // 30 секунд», выбрав Яндекс.
    const explain = (text: string) =>
      yandexMissedTrack ? `В Яндекс Музыке этого трека нет. ${text}` : text;

    const clientId = await getSoundCloudClientId();
    const { ranked, dropped } = rankStreamUrls([
      ...(track.audioUrl ? [track.audioUrl] : []),
      ...(track.transcodings || []),
    ]);

    if (ranked.length === 0) {
      // Разделяем два разных «нет ссылки»: защищённый трек и трек вообще без потоков.
      // Раньше оба возвращали `null`, и человек видел одно и то же «источник не отдал
      // ссылку» — по которому нельзя понять, ждать ли толку от повтора.
      if (dropped > 0) {
        throw new Error(explain('Трек защищён (DRM) — SoundCloud не отдаёт его для прослушивания.'));
      }
      throw new Error(explain('У этого трека нет ни одного потока — SoundCloud его не раздаёт.'));
    }

    let lastStatus = '';
    for (const tUrl of ranked) {
      try {
        const res = await safeFetch(`${tUrl}?client_id=${clientId}`, { method: 'GET' });
        if (res.ok) {
          const data = await res.json();
          if (data && data.url) {
            if (isPreviewUrl(tUrl) && !opts.silent) {
              notify(explain('SoundCloud отдаёт только 30-секундный отрывок этого трека'), 'info');
            }
            return data.url;
          }
          lastStatus = 'ответ без ссылки';
        } else {
          lastStatus = `HTTP ${res.status}`;
          console.warn(`SC stream returned ${res.status} for ${tUrl}`);
        }
      } catch (e) {
        lastStatus = e instanceof Error ? e.message : String(e);
        console.warn(`SC stream fetch failed for ${tUrl}`, e);
      }
    }

    // Здесь важен именно `dropped`: у части треков незашифрованные пресеты числятся в
    // выдаче, но отдают 404 — реально раздаётся только защищённый вариант. Снаружи это
    // выглядит как «ссылки нет», хотя причина другая и повторы не помогут.
    throw new Error(
      explain(
        dropped > 0
          ? `SoundCloud не отдал ни один доступный поток (${lastStatus || 'причина неизвестна'}), ` +
            'а остальные варианты этого трека защищены DRM.'
          : `SoundCloud не отдал ссылку на поток (${lastStatus || 'причина неизвестна'}).`
      )
    );
  }

  return track.audioUrl;
}

let lyricsCache = new Map<string, string>();
const yandexLyricsMisses = new Set<string>();
if (typeof window !== 'undefined' && window.localStorage) {
  try {
    const saved = localStorage.getItem('lomifynext_lyrics_cache');
    if (saved) {
      const parsed = JSON.parse(saved);
      for (const key of Object.keys(parsed)) {
        lyricsCache.set(key, parsed[key]);
      }
    }
  } catch(e) {}
}

function saveLyricsCache() {
  if (typeof window !== 'undefined' && window.localStorage) {
    const obj = Object.fromEntries(lyricsCache);
    localStorage.setItem('lomifynext_lyrics_cache', JSON.stringify(obj));
  }
}

/**
 * Strips everything that differs between how SoundCloud labels a track and how lrclib
 * does: bracketed suffixes, `feat.` / `prod.` credits, "Official Audio" noise,
 * punctuation and case. Works on Cyrillic as well as Latin.
 */
function lyricsNorm(v: string) {
  return (v || '')
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft|prod|by|official|audio|video|lyrics|remix|slowed|reverb|sped|up)\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same name modulo the noise above. Containment needs a few characters to mean anything. */
function lyricsFieldsMatch(a: string, b: string) {
  const x = lyricsNorm(a);
  const y = lyricsNorm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const shorter = Math.min(x.length, y.length);
  if (shorter < 4) return false;
  return x.includes(y) || y.includes(x);
}

export async function getLyrics(title: string, artist: string, track?: any) {
  const cacheKey = `${title}-${artist}`;
  const current = get(settings);
  const yandexTrackId = track?.source === 'yandex' && track?.id ? `${track.id}` : '';
  const yandexCacheKey = yandexTrackId ? `yandex:${yandexTrackId}` : '';

  if (typeof window !== 'undefined' && window.localStorage) {
    if (!localStorage.getItem('lomifynext_lyrics_cache')) {
      lyricsCache.clear();
    }
  }

  // У яндекс-трека первым источником всегда остаётся сам Яндекс. Старый кеш LRCLIB по
  // названию не должен перехватывать запрос до того, как мы спросили правообладателя.
  if (yandexCacheKey && lyricsCache.has(yandexCacheKey)) {
    const cached = lyricsCache.get(yandexCacheKey);
    return cached === 'NOT_FOUND' ? null : cached;
  }

  if (yandexTrackId && current.yandexToken && !yandexLyricsMisses.has(yandexCacheKey)) {
    const fromYandex = await getYandexLyrics(current.yandexToken, yandexTrackId).catch(() => null);
    if (fromYandex) {
      lyricsCache.set(yandexCacheKey, fromYandex);
      saveLyricsCache();
      return fromYandex;
    }
    // Не пишем отказ на диск: права и каталог Яндекса меняются. В памяти достаточно, чтобы
    // плеер и открытая панель текста не повторяли один и тот же запрос за одну сессию.
    yandexLyricsMisses.add(yandexCacheKey);
  }

  if (lyricsCache.has(cacheKey)) {
    const cached = lyricsCache.get(cacheKey);
    return cached === 'NOT_FOUND' ? null : cached;
  }

  try {
    const cleanTitle = title.replace(/\s*\(prod\..*?\)/gi, '').replace(/\s*\[prod\..*?\]/gi, '').trim();
    const getUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(artist)}`;
    const getRes = await safeFetch(getUrl, { method: 'GET' });
    if (getRes.ok) {
      const data = await getRes.json();
      if (data && (data.syncedLyrics || data.plainLyrics)) {
        const result = data.syncedLyrics || data.plainLyrics;
        lyricsCache.set(cacheKey, result);
        saveLyricsCache();
        return result;
      }
    }

    // `/api/get` is an exact lookup; `/api/search` is fuzzy and will happily return
    // whatever it has that looks vaguely similar. The old code took the first result
    // with any lyrics in it at all, which is why tracks nobody has ever transcribed
    // ended up scrolling a complete stranger's lyrics — verify the match instead.
    // Nothing is better than someone else's words.
    const searchUrl = `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(artist)}`;
    const searchRes = await safeFetch(searchUrl, { method: 'GET' });
    const data = await searchRes.json();
    if (data && data.length > 0) {
      const match = data.find((x: any) =>
        (x.syncedLyrics || x.plainLyrics) &&
        lyricsFieldsMatch(x.artistName || '', artist) &&
        lyricsFieldsMatch(x.trackName || '', cleanTitle)
      );
      if (match) {
        const result = match.syncedLyrics || match.plainLyrics;
        lyricsCache.set(cacheKey, result);
        saveLyricsCache();
        return result;
      }
    }
  } catch (err) {
    console.error("Lyrics fetch error:", err);
  }
  
  lyricsCache.set(cacheKey, 'NOT_FOUND');
  saveLyricsCache();
  return null;
}

/**
 * Профиль артиста в Яндекс Музыке, один раз за сеанс на имя.
 *
 * Страница артиста спрашивает про одного и того же человека трижды — шапка, треки, релизы, —
 * а профиль стоит двух запросов (поиск по имени + `brief-info`) и меняется раз в месяц. Без
 * этой памятки открытие страницы удваивало бы обращения к Музыке впустую.
 *
 * Хранится и отрицательный ответ (`null`): «этого артиста в Музыке нет» — тоже результат, и
 * повторять поиск по каждому запросу страницы незачем. До перезапуска, не на диск: каталог
 * пополняется, и запомненный навсегда отказ означал бы, что артист не появится и через год.
 */
const yandexArtistCache = new Map<string, Promise<any | null>>();

/** Источник каталога для страницы артиста. */
export type ArtistSource = 'soundcloud' | 'yandex';

function yandexProfileFor(artistName: string, token: string) {
  const key = normKey(artistName);
  const cached = yandexArtistCache.get(key);
  if (cached) return cached;

  const pending = yandexArtistProfile(token, artistName).catch((e) => {
    // Сетевой отказ из памятки убираем: он не про артиста, а про минуту, в которую спросили.
    yandexArtistCache.delete(key);
    throw e;
  });
  yandexArtistCache.set(key, pending);
  return pending;
}

/**
 * Everything SoundCloud knows about an artist by name: avatar, header banner, follower
 * count, bio. `/search/users` already returns the whole user object, so this costs the
 * same single request `getArtistUserId` was making anyway.
 */
export async function getArtistProfile(artistName: string, sourceOverride?: ArtistSource) {
  // Переключение источника здесь по той же причине, что и в `performSearch`: страница
  // артиста — одна, и знать про `searchSource` должна не она, а тот, кто отдаёт данные.
  // Выбрав Яндекс, человек не должен видеть в шапке подписчиков SoundCloud.
  const current = get(settings);
  const source = sourceOverride ?? current.searchSource;
  if (source === 'yandex' && current.yandexToken) {
    try {
      const profile = await yandexProfileFor(artistName, current.yandexToken);
      if (profile) return profile;
      // Явно выбранная вкладка не должна притворяться Яндекс Музыкой, показывая под ней
      // профиль SoundCloud. Старые вызовы без override сохраняют мягкий fallback.
      if (sourceOverride) return null;
      // Артиста в Музыке нет — SoundCloud ниже, потому что пустая шапка хуже чужой полной.
    } catch (e) {
      console.warn('[yandex] профиль артиста не получен, беру из SoundCloud', e);
      if (sourceOverride) return null;
    }
  }
  if (source === 'yandex' && sourceOverride) return null;
  return await soundcloudArtistProfile(artistName);
}

/**
 * Треки артиста для его страницы.
 *
 * Раньше страница звала `performSearch(artistName)` — то есть показывала не дискографию, а
 * выдачу поиска по имени: одну страницу выдачи (у Яндекса это ~20 карточек, `page=0`), из
 * которой сверка имени выбрасывала все совместные вещи. У артиста с сотней треков на экране
 * оставалось шесть. У Музыки для этого есть свой метод, и он отдаёт весь список сразу
 * отсортированным по популярности (`yandexArtistTracks`).
 *
 * У SoundCloud такого метода нет вовсе: `/users/{id}/tracks` — это загрузки аккаунта, а
 * страница ищется по ИМЕНИ и на аккаунт может не попасть. Там поиск остаётся единственным
 * честным путём, поэтому развилка именно здесь, а не в компоненте.
 */
export async function getArtistTracks(artistName: string, sourceOverride?: ArtistSource) {
  const current = get(settings);
  const source = sourceOverride ?? current.searchSource;
  if (source === 'yandex' && current.yandexToken) {
    try {
      const profile = await yandexProfileFor(artistName, current.yandexToken);
      if (profile?.id) {
        const tracks = await yandexArtistTracks(current.yandexToken, profile.id);
        if (tracks.length > 0) return tracks;
        // Пустой ответ при живом id бывает у артистов, чьи вещи лежат только в сборниках.
        // Десятка из `brief-info` уже в руках — она лучше пустой страницы.
        if (profile.popularTracks?.length) return profile.popularTracks;
      }
      if (sourceOverride) return [];
    } catch (e) {
      console.warn('[yandex] треки артиста не пришли, отдаю поиск', e);
      if (sourceOverride) return [];
    }
  }
  if (source === 'yandex' && sourceOverride) return [];
  // Явная вкладка SoundCloud не зависит от глобального источника поиска. Без этого при
  // выбранном в настройках Яндексе кнопка SoundCloud снова уходила бы в Яндекс через
  // `performSearch`, хотя визуально активна другая площадка.
  return await searchSoundCloud(artistName, 50);
}

/**
 * «Этот трек — этого артиста?» Сверка по списку исполнителей, а не по склеенной подписи.
 *
 * `track.artist` у совместной вещи выглядит как «А, Б» (см. `mapYandexTrack`), и сравнение с
 * именем «А» по равенству строк её отбрасывало. Именно из-за этого со страницы артиста
 * пропадали фиты — у иных это половина всего, что они выпустили.
 */
export function trackByArtist(track: any, artistName: string): boolean {
  const wanted = normKey(artistName);
  if (!wanted) return false;

  // Сперва подпись целиком. Иначе имена с разделителем внутри («Simon & Garfunkel»,
  // «Idris & Leos», «Дайте Танк (!)») разрезались бы на части, ни одна из которых искомому
  // имени не равна, — и артист терял бы собственные треки на своей же странице.
  if (normKey(track?.artist) === wanted) return true;

  const list: string[] = Array.isArray(track?.artists) && track.artists.length > 0
    ? track.artists
    // У SoundCloud списка исполнителей нет — там в поле один аккаунт, но подпись всё равно
    // бывает вида «A x B» или «A feat. B», поэтому режем по обычным разделителям.
    : `${track?.artist ?? ''}`.split(/,|&|feat\.|ft\.| x | vs /i);

  return list.some((name) => normKey(name) === wanted);
}

async function soundcloudArtistProfile(artistName: string) {
  try {
    const clientId = await getSoundCloudClientId();
    const url = `https://api-v2.soundcloud.com/search/users?q=${encodeURIComponent(artistName)}&client_id=${clientId}&limit=5`;
    const res = await safeFetch(url, { method: 'GET' });
    if (!res.ok) return null;
    const data = await res.json();
    const collection: any[] = data?.collection || [];
    if (collection.length === 0) return null;

    // A name search lands on fan pages and soundalikes often enough that "the first
    // result" is a guess. For the id that is tolerable (it feeds "load this profile"),
    // but a banner from the wrong account is visibly, embarrassingly wrong — so the
    // banner only comes from an exact name match.
    const wanted = normKey(artistName);
    const exact = collection.find((u: any) => normKey(u?.username) === wanted || normKey(u?.permalink) === wanted);
    const user = exact || collection[0];
    // `visuals` is SoundCloud's profile header (~2480x520). Some accounts have none.
    const visual = user?.visuals?.visuals?.find((v: any) => v?.visual_url);

    return {
      id: user.id,
      username: user.username || artistName,
      avatarUrl: user.avatar_url ? user.avatar_url.replace('large', 't500x500') : '',
      bannerUrl: exact && visual ? visual.visual_url : '',
      followersCount: user.followers_count || 0,
      // Прослушиваний по артисту SoundCloud не отдаёт — поле есть, чтобы у обоих источников
      // была одна форма ответа и страница не разбиралась, кто ей ответил.
      listenersCount: 0,
      description: user.description || '',
      city: user.city || '',
      country: user.country_code || '',
      permalink: user.permalink_url || '',
      verified: !!user.verified,
      isExactMatch: !!exact,
      source: 'soundcloud',
    };
  } catch (err) {
    console.error("Failed to fetch SC artist profile:", err);
  }
  return null;
}

export async function getArtistUserId(artistName: string): Promise<number | null> {
  // Именно SoundCloud-профиль, а не `getArtistProfile`: этим id дальше зовут `/users/{id}/…`
  // SoundCloud (альбомы, новые релизы), и id артиста из Яндекса там означал бы чужого
  // человека или, чаще, 404 — то есть тихо пропавшие альбомы при выбранном Яндексе.
  const profile = await soundcloudArtistProfile(artistName);
  return profile?.id ?? null;
}

/**
 * Лайки профиля SoundCloud.
 *
 * `complete` — доехал ли список целиком. Это не отчётность ради отчётности: список
 * используется как эталон при сверке (см. `$lib/likes`), где «трека нет в ответе» означает
 * «лайк сняли», и локальная отметка после этого удаляется. Оборванный ответ выглядит оттуда
 * ровно так же, как снятые лайки, поэтому о неполноте надо сказать вслух — иначе один
 * таймаут посреди чтения стирал бы часть библиотеки.
 *
 * Отсюда же пагинация. Раньше запрос был один, с `limit=200`, и на этом чтение
 * заканчивалось: у человека с тысячей лайков восемь сотен просто не существовали для
 * приложения. SoundCloud отдаёт продолжение в `next_href` — идём по нему, пока оно есть,
 * добавляя `client_id` (в самой ссылке его нет).
 *
 * Верхний предел страниц нужен как страховка от кольца в `next_href`: пятнадцать страниц —
 * это три тысячи лайков, больше похоже на сбой, чем на библиотеку. Упёрлись в предел —
 * список неполный, и это ровно тот случай, когда сверке нельзя ничего удалять.
 */
export async function getUserLikes(userId: number): Promise<{ tracks: any[]; complete: boolean }> {
  const MAX_PAGES = 15;
  const tracks: any[] = [];
  try {
    const clientId = await getSoundCloudClientId();
    let url: string | null =
      `https://api-v2.soundcloud.com/users/${userId}/likes?client_id=${clientId}&limit=200`;

    for (let page = 0; page < MAX_PAGES && url; page++) {
      const res = await safeFetch(url, { method: 'GET' });
      // Оборвались на середине — то, что уже собрали, отдаём: полки и рекомендации этому
      // рады. А `complete: false` не даст сверке принять огрызок за полный список.
      if (!res.ok) return { tracks, complete: false };
      const data = await res.json();

      const page_tracks = (data.collection ?? [])
        .filter((item: any) => item && item.track)
        .map((item: any) => {
          const t = item.track;
          const cover = t.artwork_url ? t.artwork_url.replace('large', 't500x500') : '';
          const avatar = t.user?.avatar_url ? t.user.avatar_url.replace('large', 't500x500') : '';
          return {
            id: t.id,
            title: t.title,
            artist: t.user?.username || 'Unknown',
            coverUrl: cover,
            artistAvatarUrl: avatar,
            permalinkUrl: t.permalink_url || '',
            genre: t.genre || '',
            playbackCount: t.playback_count || 0,
            likesCount: t.likes_count || 0,
            releaseDate: t.release_date || t.created_at || t.display_date || '',
            duration: t.duration || 0,
            audioUrl: findBestTranscoding(t.media),
            transcodings: t.media?.transcodings?.map((tr: any) => `${tr.url}?client_id=${clientId}`) || [],
            source: 'soundcloud'
          };
        })
        .filter((t: any) => t.title && (t.audioUrl || t.transcodings?.length > 0));

      tracks.push(...page_tracks);

      const next = typeof data.next_href === 'string' ? data.next_href : '';
      url = next ? `${next}${next.includes('?') ? '&' : '?'}client_id=${clientId}` : null;
      if (url && page === MAX_PAGES - 1) return { tracks, complete: false };
    }
    return { tracks, complete: true };
  } catch (e) {
    console.error("Failed to fetch user likes:", e);
    return { tracks, complete: false };
  }
}

export async function resolveSoundCloudProfile(profileUrl: string) {
  try {
    const clientId = await getSoundCloudClientId();
    const url = `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(profileUrl)}&client_id=${clientId}`;
    const res = await safeFetch(url, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.kind === 'user') {
        return {
          id: data.id,
          username: data.username,
          avatarUrl: data.avatar_url ? data.avatar_url.replace('large', 't500x500') : '',
          permalink: data.permalink_url,
          // Шапка профиля (~2480x520) — то же поле, что читает getArtistProfile.
          // У части аккаунтов её нет вовсе, тогда остаётся пустая строка и профиль
          // рисует свой запасной баннер.
          bannerUrl: data.visuals?.visuals?.find((v: any) => v?.visual_url)?.visual_url || ''
        };
      }
    }
  } catch(e) {
    console.error("Failed to resolve SC profile:", e);
  }
  return null;
}

export async function getUserPlaylists(userId: number) {
  try {
    const clientId = await getSoundCloudClientId();
    const url = `https://api-v2.soundcloud.com/users/${userId}/playlists?client_id=${clientId}&limit=50&representation=full`;
    const res = await safeFetch(url, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      const playlists = [];
      for (const p of data.collection) {
        let tracksToUse = p.tracks || [];
        const missingIds = tracksToUse.filter((t: any) => !t.title).map((t: any) => t.id);
        
        if (missingIds.length > 0) {
          const chunkSize = 50;
          let fetchedTracks: any[] = [];
          for (let i = 0; i < missingIds.length; i += chunkSize) {
            const chunk = missingIds.slice(i, i + chunkSize);
            const tracksUrl = `https://api-v2.soundcloud.com/tracks?ids=${chunk.join(',')}&client_id=${clientId}`;
            const tracksRes = await safeFetch(tracksUrl, { method: 'GET' });
            if (tracksRes.ok) {
              const chunkData = await tracksRes.json();
              fetchedTracks = fetchedTracks.concat(chunkData);
            }
          }
          tracksToUse = tracksToUse.map((t: any) => {
            const fullTrack = fetchedTracks.find((ft: any) => ft.id === t.id);
            return fullTrack ? fullTrack : t;
          });
        }
        
        const validTracks = tracksToUse.map((t: any) => {
          const cover = t.artwork_url ? t.artwork_url.replace('large', 't500x500') : (p.artwork_url ? p.artwork_url.replace('large', 't500x500') : '');
          const avatar = t.user?.avatar_url ? t.user.avatar_url.replace('large', 't500x500') : '';
          return {
            id: t.id,
            title: t.title,
            artist: t.user?.username || 'Unknown',
            coverUrl: cover,
            artistAvatarUrl: avatar,
            permalinkUrl: t.permalink_url || '',
            genre: t.genre || '',
            playbackCount: t.playback_count || 0,
            likesCount: t.likes_count || 0,
            releaseDate: t.release_date || t.created_at || t.display_date || '',
            duration: t.duration || 0,
            audioUrl: findBestTranscoding(t.media),
            transcodings: t.media?.transcodings?.map((tr: any) => `${tr.url}?client_id=${clientId}`) || [],
            source: 'soundcloud'
          };
        }).filter((t: any) => t.title && (t.audioUrl || t.transcodings?.length > 0));
        
        if (validTracks.length > 0) {
          playlists.push({
            id: `sc_playlist_${p.id}`,
            title: p.title,
            tracks: validTracks
          });
        }
      }
      return playlists;
    }
  } catch (e) {
    console.error("Failed to fetch user playlists:", e);
  }
  return [];
}

export async function getArtistAlbums(artistName: string, sourceOverride?: ArtistSource) {
  // Развилка по источнику: при Яндексе прежний код уходил в SoundCloud и почти всегда
  // возвращал пусто (там `/users/{id}/albums` — релизы аккаунта с тем же именем, а его
  // может и не быть). Из-за этого блок «Релизы» на странице артиста просто не появлялся.
  const current = get(settings);
  const source = sourceOverride ?? current.searchSource;
  if (source === 'yandex' && current.yandexToken) {
    try {
      const profile = await yandexProfileFor(artistName, current.yandexToken);
      if (profile?.id) {
        const albums = await yandexArtistAlbums(current.yandexToken, profile.id);
        // `direct-albums` отдаёт только обложки и `trackCount` — содержимое каждого релиза
        // подтягивается по клику через `getAlbumTracks`. Тянуть 39 альбомов сразу — это 39
        // запросов на открытие страницы, чего мы себе не позволяем.
        if (albums.length > 0) return albums;
      }
      return [];
    } catch (e) {
      console.warn('[yandex] релизы артиста не пришли', e);
      return [];
    }
  }

  if (source === 'yandex' && sourceOverride) return [];

  try {
    const userId = await getArtistUserId(artistName);
    if (!userId) return [];

    const clientId = await getSoundCloudClientId();
    const url = `https://api-v2.soundcloud.com/users/${userId}/albums?client_id=${clientId}&limit=10&representation=full`;
    const res = await safeFetch(url, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      return data.collection.map((p: any) => ({
        id: `sc_album_${p.id}`,
        title: p.title,
        // Обложка и число треков на уровне релиза — чтобы карточка альбома выглядела
        // одинаково для обоих источников и не лазила внутрь `tracks[0]`, которого у
        // яндексовых релизов до раскрытия нет.
        coverUrl: p.artwork_url ? p.artwork_url.replace('large', 't500x500') : '',
        trackCount: p.track_count || (p.tracks || []).length,
        year: (p.release_date || p.created_at || '').slice(0, 4),
        releaseDate: p.release_date || p.created_at || p.display_date || '',
        source: 'soundcloud',
        tracks: (p.tracks || []).map((t: any) => {
          const cover = t.artwork_url ? t.artwork_url.replace('large', 't500x500') : (p.artwork_url ? p.artwork_url.replace('large', 't500x500') : '');
          const avatar = t.user?.avatar_url ? t.user.avatar_url.replace('large', 't500x500') : '';
          return {
            id: t.id,
            title: t.title,
            artist: t.user?.username || artistName,
            coverUrl: cover,
            artistAvatarUrl: avatar,
            permalinkUrl: t.permalink_url || '',
            genre: t.genre || '',
            playbackCount: t.playback_count || 0,
            likesCount: t.likes_count || 0,
            releaseDate: t.release_date || t.created_at || t.display_date || '',
            duration: t.duration || 0,
            audioUrl: findBestTranscoding(t.media),
            transcodings: t.media?.transcodings?.map((tr: any) => `${tr.url}?client_id=${clientId}`) || [],
            source: 'soundcloud'
          };
        }).filter((t: any) => t.title && (t.audioUrl || t.transcodings?.length > 0))
      })).filter((p: any) => p.tracks.length > 0);
    }
  } catch (e) {
    console.error("Failed to fetch artist albums:", e);
  }
  return [];
}

/**
 * Содержимое релиза. Для SoundCloud треки уже лежат в объекте альбома, для Яндекса их
 * приходится дозапрашивать: `direct-albums` перечисляет релизы, но не их треки.
 *
 * Возвращает тот же массив, что и был, если он уже полон, — вызывающему не нужно решать,
 * загружено ли содержимое, он просто зовёт это перед показом или воспроизведением.
 */
export async function getAlbumTracks(album: any): Promise<any[]> {
  if (Array.isArray(album?.tracks) && album.tracks.length > 0) return album.tracks;

  const current = get(settings);
  if (album?.source === 'yandex' && album?.albumId && current.yandexToken) {
    try {
      return await yandexAlbumTracks(current.yandexToken, album.albumId);
    } catch (e) {
      console.warn('[yandex] треки релиза не пришли', e);
    }
  }
  return [];
}

const NEW_RELEASE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Полка «Новые релизы» — свежее у трёх самых залайканных артистов.
 *
 * Собирается в том сервисе, который выбран источником: до этого шли только треки с
 * SoundCloud, поэтому при Яндекс.Музыке на главной оказывались чужие ссылки.
 */
export async function getNewReleases(likedTracks: any[]) {
  if (!likedTracks || likedTracks.length === 0) return [];

  const counts = likedTracks.reduce((acc, t) => { if (t.artist) acc[t.artist] = (acc[t.artist] || 0) + 1; return acc; }, {});
  const topArtists = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 3);

  if (topArtists.length === 0) return [];

  const current = get(settings);
  if (current.searchSource === 'yandex' && current.yandexToken) {
    const fromYandex = await yandexNewReleases(current.yandexToken, topArtists);
    // Пустой ответ отдаём как есть: на SoundCloud тут молча не переключаемся.
    if (fromYandex !== null) return fromYandex;
  }

  let releases: any[] = [];
  try {
    const clientId = await getSoundCloudClientId();
    
    const fetchPromises = topArtists.map(async (artistName) => {
      const userId = await getArtistUserId(artistName);
      if (!userId) return [];
      
      const tracksUrl = `https://api-v2.soundcloud.com/users/${userId}/tracks?client_id=${clientId}&limit=5`;
      const res = await safeFetch(tracksUrl, { method: 'GET' });
      if (res.ok) {
        const data = await res.json();
        return data.collection.filter((t: any) => t && t.id).map((t: any) => {
          const cover = t.artwork_url ? t.artwork_url.replace('large', 't500x500') : '';
          const avatar = t.user?.avatar_url ? t.user.avatar_url.replace('large', 't500x500') : '';
          return {
            id: t.id,
            title: t.title,
            artist: t.user?.username || artistName,
            coverUrl: cover,
            artistAvatarUrl: avatar,
            permalinkUrl: t.permalink_url || '',
            genre: t.genre || '',
            playbackCount: t.playback_count || 0,
            likesCount: t.likes_count || 0,
            releaseDate: t.release_date || t.created_at || t.display_date || '',
            duration: t.duration || 0,
            audioUrl: findBestTranscoding(t.media),
            transcodings: t.media?.transcodings?.map((tr: any) => `${tr.url}?client_id=${clientId}`) || [],
            source: 'soundcloud'
          };
        }).filter((t: any) => t.title && (t.audioUrl || t.transcodings?.length > 0));
      }
      return [];
    });
    
    const results = await Promise.allSettled(fetchPromises);
    for (const res of results) {
      if (res.status === 'fulfilled' && res.value && res.value.length > 0) {
        releases.push(...res.value);
      }
    }
    
    releases.sort((a, b) => {
      const dateA = new Date(a.releaseDate).getTime() || 0;
      const dateB = new Date(b.releaseDate).getTime() || 0;
      return dateB - dateA;
    });
    
    const twoMonthsAgo = Date.now() - NEW_RELEASE_WINDOW_MS;
    releases = releases.filter(t => {
      const tDate = new Date(t.releaseDate).getTime() || 0;
      return tDate > twoMonthsAgo;
    });

    return releases.slice(0, 15);

  } catch (e) {
    console.error("Failed to fetch new releases:", e);
  }
  return [];
}

/**
 * Яндексовая половина `getNewReleases`.
 *
 * `null` означает «сервис не ответил» — на него вызывающий падает обратно на SoundCloud.
 * Пустой массив — «ответил, свежего нет»: это законный результат, подменять источник в
 * таком случае нельзя.
 *
 * Путь длиннее соундклаудовского не от лишнего: у Музыки нет ленты «последнее у артиста».
 * Есть поиск артиста по имени (даёт id), его релизы (`direct-albums`, отсортированы по
 * году, но без содержимого) и содержимое конкретного релиза. Поэтому сначала отбираем по
 * дате сами релизы и только за свежими идём за треками — так запрос на альбом уходит
 * ноль-один раз на артиста, а не по разу на каждую позицию дискографии.
 */
async function yandexNewReleases(token: string, artistNames: string[]): Promise<any[] | null> {
  const since = Date.now() - NEW_RELEASE_WINDOW_MS;

  const perArtist = await Promise.allSettled(artistNames.map(async (name) => {
    const profile = await yandexArtistProfile(token, name);
    // Не тот артист — хуже, чем пустая полка: в «новых релизах» появился бы однофамилец.
    if (!profile?.id || !profile.isExactMatch) return [];

    const albums = await yandexArtistAlbums(token, profile.id, 20);
    const fresh = albums.filter((a: any) => (new Date(a.releaseDate).getTime() || 0) > since).slice(0, 3);
    if (fresh.length === 0) return [];

    const contents = await Promise.allSettled(fresh.map(async (a: any) => {
      const tracks = await yandexAlbumTracks(token, a.albumId);
      // У трека Музыки своей даты выпуска нет — она у релиза, из которого он взят.
      return tracks.map((t: any) => ({ ...t, releaseDate: t.releaseDate || a.releaseDate }));
    }));
    return contents.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  }));

  // Ни один артист не прошёл целиком — считаем, что не ответила Музыка, а не что у трёх
  // любимых артистов разом нет новинок.
  if (!perArtist.some(r => r.status === 'fulfilled')) {
    console.warn('[yandex] новые релизы не пришли', (perArtist[0] as PromiseRejectedResult)?.reason);
    return null;
  }

  const releases = perArtist.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  const unique = new Map<string | number, any>();
  for (const t of releases) if (t?.id && !unique.has(t.id)) unique.set(t.id, t);

  return [...unique.values()]
    .sort((a, b) => (new Date(b.releaseDate).getTime() || 0) - (new Date(a.releaseDate).getTime() || 0))
    .slice(0, 15);
}
