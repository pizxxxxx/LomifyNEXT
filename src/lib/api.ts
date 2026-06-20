import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { get } from 'svelte/store';
import { settings } from './stores';
import { convertFileSrc } from '@tauri-apps/api/core';

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
  
  return transcodings[0].url;
}

export async function searchSoundCloud(query: string, limit: number = 15) {
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
          genre: t.genre || '',
          playbackCount: t.playback_count || 0,
          likesCount: t.likes_count || 0,
          releaseDate: t.release_date || t.created_at || t.display_date || '',
          duration: t.duration || 0,
          audioUrl: findBestTranscoding(t.media),
          transcodings: t.media?.transcodings?.map((tr: any) => `${tr.url}?client_id=${clientId}`) || [],
          source: 'soundcloud',
          isBanned: t.policy === 'BLOCK' || t.policy === 'SNIPPET' || t.access === 'blocked' || !(t.media?.transcodings?.length > 0)
        };
      }).filter((t: any) => t.title);
  } catch (err) {
    console.error("SoundCloud search error:", err);
    return [];
  }
}

export async function getRelatedTracks(track: any) {
  if (track.source === 'soundcloud' && track.id) {
    try {
      const clientId = await getSoundCloudClientId();
      const url = `https://api-v2.soundcloud.com/tracks/${track.id}/related?client_id=${clientId}&limit=15`;
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
          isBanned: t.policy === 'BLOCK' || t.policy === 'SNIPPET' || t.access === 'blocked' || !(t.media?.transcodings?.length > 0)
        };
      }).filter((t: any) => t.title);
    } catch (e) {
      console.error("Failed to fetch related SC tracks:", e);
    }
  }
  return await getTrendingTracks();
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

export async function getSoundCloudPlaylists(query: string = 'phonk', limit: number = 3) {
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
  }
  return [];
}

export async function getTrendingTracks(likedTracks: any[] = [], listenStats: any = null, searchHistory: string[] = [], playlists: any[] = []) {
  const customArtists = [
    'Morgenshtern', 'Toxi$', 'Big Baby Tape', 'Kizaru', 'Aarne', 'Friendly Thug 52 Ngg', 'Alblak 52', 'Bushido Zho', 'Scally Milano', 'Uglystephan', 'Heronwater', 'Yeei', 'Platina', 'OG Buda', 'MAYOT', 'SEEMEE', '163ONMYNECK', 'Pinq', 'Voskr8', 'Xcho', 'CUPSIZE', 'тёмный принц', 'Паранойя', 'sexyswag.', 'greyrock', 'tewiq', 'Рэйчи', 'Юпи', 'Villian', 'Katastrofa.', 'Kai Angel', '9mice', 'Viperr', 'Lovesomemama', 'Rocket', 'LIL VAN', 'Lovesleep', 'Bnz', 'Fresco', 'Kid Sole', 'Sqwore', 'skurt', 'g0ner', '17 SEVENTEEN', 'rizza', 'LXNER', 'quiizzzmeow', 'Midix', 'treepside', '3TERNITY', 'LOLIWZ', 'lil 17th', 'HOROSHIYAGNI', 'liberum', 'pyatno', 'WENARO', 'хочуспать', 'JojoHF', 'КАКАЯ РАЗНИЦА', 'Rory in early 20s', 'shadowraze', 'zxcursed', 'hikikomori kai', 'mu護', 'shinra', 'Kaito Shoma', 'DVRST', 'PlayaPhonk', 'ghostface playa', 'Lida', 'CMH', 'findmyname', 'glwzbll', 'GSPD', 'Dead Blonde', 'Ssshhhiiittt!', 'Пошлая Молли', 'DK', 'BOOKER', 'Pepel Nahudi', 'FORTUNA 812', 'Baby Melo', 'NEWLIGHTCHILD', 'xxxmanera', 'Macan', 'Jakone', 'A.V.G', 'Misha Xramovi', 'Niletto', 'PHARAOH', 'Boulevard Depo', 'i61', 'Jeembo', 'Tveth', 'Saluki', 'Lizer', 'Flesh', 'Thrill Pill', 'Face', 'Yanix', 'Markul', 'Obladaet', 'Thomas Mraz', 'LSP', 'Oxxxymiron', 'Feduk', 'Allj', 'T-Fest', 'Scriptonite', '10age', 'Sqwoz Bab', 'Slava Marlow', 'Soda Luv', 'Blago White', 'GONE.Fludd', 'IOCK', 'CAKEBOY', 'Flipper Floyd', 'Clonnex', 'Shiki', 'unki', 'Glocki52', 'SaintWorld', 'Icegergert', 'Noize MC', 'Anacondaz', 'Pyrokinesis', 'mzlff', 'Слава КПСС', 'Замай', 'Хаски', 'Масло черного тмина', 'Loc-Dog', 'Johnyboy', 'Schokk', 'Czar', 'ST', 'REPAC', 'Егор Крид', 'Мот', "L'One", 'Тимати', 'Джиган', 'Natan', 'Pacha TQ', 'Guf', 'Slimus', 'Птаха', 'Баста', 'Смоки Мо', 'Рем Дигга', 'Типси Тип', 'MiyaGi', 'Andy Panda', 'TumaniYO', 'H loyalty', 'Mav-d', 'Ollane', 'Krec', 'Ассаи', 'Каста', 'Влади', 'Шым', 'Хамиль', 'Змей', 'Триада', 'Нигатив', 'Многоточие', 'Руставели', 'Ю.Г.', 'D.O.B. Community', 'Лигалайз', 'Децл', 'Bad Balance', 'Шеff', 'Михей', 'Кровосток', '25/17', 'Грот', 'Миша Маваши', 'Ярмак', 'Стольный Град', 'Брутто', 'ВесЪ', 'Зануда', 'Гио Пика', 'Честный', 'Нурминский', 'Ганвест', 'homie', 'Леша Свик', 'Зомб', 'Jah Khalib', 'HammAli', 'Navai', "Ramil'", 'Jony', 'Elman', 'Andro', 'Gafur', 'The Limba', 'Idris & Leos', 'Bahh Tee', 'Kavabanga Depo Kolibri', '10iz', 'Truwer', '104', 'Niman', 'Benz', 'Kali', 'Murovei', 'VibeTGK', 'Jahmal TGK', 'Триагрутрика', 'ОУ74', 'Пастор Напас', 'Manky Monk', 'Казян', 'Сын Окопа', 'КУОК', 'БУЕРАК', 'Перемотка', 'Черная Речка', 'Источник', 'Пасош', 'автоспорт', 'Валентин Дядька', 'Кис-Кис', 'найтивыход', 'эхопрокуренныхподъездов', 'вы соглашаетесь', 'вожатый', 'увула', 'созвездие отрезок', 'Синекдоха Монток', 'Сироткин', 'Антоха МС', 'Cream Soda', 'Грязь', 'Монеточка', 'Kedr Livanskiy', 'IC3PEAK', 'Pussy Riot', 'Coldcloud', 'Why, Berry', 'Offmi', 'Marco9', 'Lil Krystalll', 'Shaitan', 'YNGLY', 'LOV66', 'Malenkiyyy', 'ooes', 'zoloto', 'петля пристрастия', 'Валентин Стрикало', 'Нервы', 'Женя Мильковский', 'Гречка', 'Алена Швец', 'Дайте Танк (!)', 'Краснознаменная Дивизия Имени Моей Бабушки', 'Комсомольск', 'Хадн Дадн', 'Shortparis', 'СБПЧ', 'Глюкоза', 'Линда', 'Дельфин', 'Дубовый Гаайъ', 'Мальчишник', 'Сектор Газа', 'Красная Плесень', 'Кирпичи', 'Аигел', '2H Company'
  ];
  const genres = ['Популярные хиты 2024', 'русские хиты', 'русский рэп', 'mylancore', 'madk1d', 'tiktok remix', 'hyperpop', 'русская попса', 'russian pop', 'russian rap', 'phonk', 'lofi'];
  
  const pickRandom = (arr: string[], n: number) => [...arr].sort(() => 0.5 - Math.random()).slice(0, n);
  const selectedKeywords = new Set<string>();

  // 1. Liked / Listened Artists (Personalized)
  let userFavorites: string[] = [];
  if (likedTracks && likedTracks.length > 0) {
    const counts = likedTracks.reduce((acc, t) => { if (t.artist) acc[t.artist] = (acc[t.artist] || 0) + 1; return acc; }, {});
    userFavorites.push(...Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 10));
  }
  if (listenStats && listenStats.history) {
    const vals = Object.values(listenStats.history) as { count: number, artist: string }[];
    userFavorites.push(...vals.sort((a, b) => b.count - a.count).slice(0, 10).map(h => h.artist).filter(Boolean));
  }
  userFavorites = [...new Set(userFavorites)];
  
  if (userFavorites.length > 0) {
    const pickCount = (likedTracks && likedTracks.length > 50) ? 4 : 2;
    pickRandom(userFavorites, pickCount).forEach(k => selectedKeywords.add(k));
  }

  // 2. Search History
  if (searchHistory && searchHistory.length > 0) {
    pickRandom(searchHistory.slice(0, 10), 1).forEach(k => selectedKeywords.add(k));
  }

  // 3. General Genres
  pickRandom(genres, selectedKeywords.size < 3 ? 2 : 1).forEach(k => selectedKeywords.add(k));

  // 4. Curated Artist Pool (Fill the rest up to 6 queries)
  const needed = 6 - selectedKeywords.size;
  pickRandom(customArtists, needed).forEach(k => selectedKeywords.add(k));

  let sc: any[] = [];
  // We fetch up to 40 tracks per keyword in parallel
  const searchPromises = Array.from(selectedKeywords).map(query => searchSoundCloud(query, 40));
  const results = await Promise.allSettled(searchPromises);
  
  for (const res of results) {
    if (res.status === 'fulfilled' && res.value && res.value.length > 0) {
      sc.push(...res.value);
    }
  }

  // Remove exact duplicates from multiple searches
  const uniqueSc = new Map();
  for (const track of sc) {
    uniqueSc.set(track.id, track);
  }
  sc = Array.from(uniqueSc.values());

  if (sc && sc.length > 0) {
    // Filter out compilations/mixes > 5 minutes (300000 ms)
    let filtered = sc.filter((t: any) => t.duration > 0 && t.duration <= 300000);
    
    // Filter out known tracks (liked, listened, in playlists)
    const knownSignatures = new Set<string>();
    
    if (likedTracks) {
      likedTracks.forEach(t => {
        if (t.title && t.artist) knownSignatures.add(`${t.title}-${t.artist}`.toLowerCase());
      });
    }
    
    if (listenStats && listenStats.history) {
      Object.values(listenStats.history).forEach((h: any) => {
        if (h.title && h.artist) knownSignatures.add(`${h.title}-${h.artist}`.toLowerCase());
      });
    }
    
    if (playlists) {
      playlists.forEach(pl => {
        if (pl.tracks) {
          pl.tracks.forEach((t: any) => {
            if (t.title && t.artist) knownSignatures.add(`${t.title}-${t.artist}`.toLowerCase());
          });
        }
      });
    }

    filtered = filtered.filter((t: any) => !knownSignatures.has(`${t.title}-${t.artist}`.toLowerCase()));

    // Filter to tracks with at least some plays to avoid completely obscure tracks if we have plenty
    if (filtered.length > 20) {
       filtered = filtered.sort((a: any, b: any) => (b.playbackCount || 0) - (a.playbackCount || 0)).slice(0, 200);
    }
    
    if (filtered.length > 0) {
      // Sort by playback count descending, but add a slight random factor (e.g. +/- 30% to playbackCount) to keep it fresh
      filtered = filtered.sort((a: any, b: any) => {
        const aScore = (a.playbackCount || 0) * (0.7 + Math.random() * 0.6);
        const bScore = (b.playbackCount || 0) * (0.7 + Math.random() * 0.6);
        return bScore - aScore;
      });

      // Space out tracks by the same artist so they don't appear consecutively
      const spaced: any[] = [];
      const remaining = [...filtered];
      while (remaining.length > 0) {
        let found = false;
        for (let i = 0; i < remaining.length; i++) {
          if (spaced.length === 0 || spaced[spaced.length - 1].artist !== remaining[i].artist) {
            spaced.push(remaining[i]);
            remaining.splice(i, 1);
            found = true;
            break;
          }
        }
        if (!found) {
          spaced.push(remaining.shift());
        }
      }
      filtered = spaced;
    }
    
    return filtered.length > 0 ? filtered : sc;
  }
  return [];
}

export async function performSearch(query: string) {
  return await searchSoundCloud(query, 50);
}

export async function getAudioUrl(track: any) {
  if (!track) return null;
  if (track.isLocal || track.source === 'local' || track.source === 'Локальный') {
    return convertFileSrc(track.audioUrl);
  }

  if (track.source === 'soundcloud') {
    try {
      const clientId = await getSoundCloudClientId();
      const urlsToTry = track.audioUrl ? [track.audioUrl.split('?')[0]] : [];
      if (track.transcodings && track.transcodings.length > 0) {
        track.transcodings.forEach((t: string) => {
          const clean = t.split('?')[0];
          if (!urlsToTry.includes(clean)) {
            urlsToTry.push(clean);
          }
        });
      }

      for (const tUrl of urlsToTry) {
        try {
           const res = await safeFetch(`${tUrl}?client_id=${clientId}`, { method: 'GET' });
           if (res.ok) {
             const data = await res.json();
             if (data && data.url) return data.url;
           } else {
             console.warn(`SC stream returned ${res.status} for ${tUrl}`);
           }
        } catch (e) {
           console.warn(`SC stream fetch failed for ${tUrl}`, e);
        }
      }
      return null;
    } catch (err) {
      console.error("Failed to get SC audio url:", err);
    }
  }
  
  return track.audioUrl;
}

let lyricsCache = new Map<string, string>();
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

export async function getLyrics(title: string, artist: string) {
  const cacheKey = `${title}-${artist}`;
  
  if (typeof window !== 'undefined' && window.localStorage) {
    if (!localStorage.getItem('lomifynext_lyrics_cache')) {
      lyricsCache.clear();
    }
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

    const searchUrl = `https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanTitle)}&artist_name=${encodeURIComponent(artist)}`;
    const searchRes = await safeFetch(searchUrl, { method: 'GET' });
    const data = await searchRes.json();
    if (data && data.length > 0) {
      const match = data.find((x: any) => x.syncedLyrics || x.plainLyrics);
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

export async function getArtistUserId(artistName: string): Promise<number | null> {
  try {
    const clientId = await getSoundCloudClientId();
    const url = `https://api-v2.soundcloud.com/search/users?q=${encodeURIComponent(artistName)}&client_id=${clientId}&limit=1`;
    const res = await safeFetch(url, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      if (data && data.collection && data.collection.length > 0) {
        const user = data.collection[0];
        return user.id;
      }
    }
  } catch (err) {
    console.error("Failed to get SC user id:", err);
  }
  return null;
}

export async function getUserLikes(userId: number) {
  try {
    const clientId = await getSoundCloudClientId();
    const url = `https://api-v2.soundcloud.com/users/${userId}/likes?client_id=${clientId}&limit=200`;
    const res = await safeFetch(url, { method: 'GET' });
    if (res.ok) {
      const data = await res.json();
      return data.collection
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
        }).filter((t: any) => t.title && (t.audioUrl || t.transcodings?.length > 0));
    }
  } catch (e) {
    console.error("Failed to fetch user likes:", e);
  }
  return [];
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
          permalink: data.permalink_url
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

export async function getArtistAlbums(artistName: string) {
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

export async function getNewReleases(likedTracks: any[]) {
  if (!likedTracks || likedTracks.length === 0) return [];
  
  const counts = likedTracks.reduce((acc, t) => { if (t.artist) acc[t.artist] = (acc[t.artist] || 0) + 1; return acc; }, {});
  const topArtists = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 3);
  
  if (topArtists.length === 0) return [];
  
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
    
    const twoMonthsAgo = Date.now() - (60 * 24 * 60 * 60 * 1000);
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
