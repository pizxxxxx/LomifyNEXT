//! Сборка HLS-потока в один буфер + распознавание защищённых потоков.
//!
//! Модуль общий на всё приложение, и это не аккуратность ради аккуратности. HLS-ссылка
//! приходит в три разных места: анонимную загрузку с SoundCloud (`track_cache::sc_anon`),
//! фоновое кэширование по ссылке от источника (`track_cache::state::download_api`) и
//! мгновенное воспроизведение (`audio::engine::load_url`). Собирать сегменты умело только
//! первое, а остальные два скачивали текст плейлиста как аудио: кэш отвечал «Invalid audio
//! data», плеер — ошибкой декодера. Причина у обоих одна, поэтому и код один.
//!
//! Почему это вообще случается: SoundCloud перечисляет transcoding'и так, что HLS идёт
//! первым, а progressive — последним, так что «первая же ссылка» — почти всегда плейлист.
//!
//! Защищённые потоки (`playlist.m3u8` из путей `/cbcs/` и `/cenc/`) распознаём и честно
//! отказываем: ключ там выдаёт лицензионный сервер (`#EXT-X-KEY:METHOD=SAMPLE-AES,
//! KEYFORMAT="com.apple.streamingkeydelivery"`), расшифровать его нечем. Отдельная ошибка
//! нужна затем, чтобы наверх ушло «трек защищён», а не «битые данные» — из второго
//! вообще ничего не следует, и по нему выше по стеку начинались бессмысленные повторы.

use bytes::{Bytes, BytesMut};
use reqwest::Client;
use url::Url;

/// Сколько сегментов тянем одновременно. Больше не нужно: у SC сегмент ~10 секунд, три
/// параллельных запроса уже перекрывают запись на диск.
const PREFETCH_SEGMENTS: usize = 3;

/// Сколько уровней вложенности плейлистов разворачиваем (master → media).
const MAX_PLAYLIST_DEPTH: usize = 2;

/// Ошибка «поток зашифрован» — по этой строке вызывающая сторона отличает защищённый
/// трек от сбоя и не повторяет запрос.
pub const DRM_ERROR: &str = "поток защищён (DRM) — воспроизвести нельзя";

/// Похоже ли начало ответа на m3u8-плейлист.
///
/// Смотрим на содержимое, а не на расширение в адресе: подписанная ссылка SoundCloud несёт
/// `.m3u8` в пути, а ссылка нашей раздачи — нет, при том что отдаёт тот же плейлист.
pub fn looks_like_playlist(prefix: &[u8]) -> bool {
    let head = &prefix[..prefix.len().min(64)];
    let text = String::from_utf8_lossy(head);
    text.trim_start().starts_with("#EXTM3U")
}

/// Есть ли в плейлисте шифрование, которое мы не можем снять.
///
/// `METHOD=NONE` встречается в манифестах как явное «дальше не зашифровано» и запретом не
/// является. Всё остальное (`SAMPLE-AES`, `AES-128` с внешним `KEYFORMAT`) означает ключ у
/// лицензионного сервера.
fn is_protected(playlist: &str) -> bool {
    playlist.lines().any(|line| {
        let line = line.trim();
        if !line.starts_with("#EXT-X-KEY") && !line.starts_with("#EXT-X-SESSION-KEY") {
            return false;
        }
        !line.contains("METHOD=NONE")
    })
}

/// Скачивает плейлист по ссылке и собирает из него один буфер аудио.
pub async fn download(client: &Client, playlist_url: &str) -> Result<Bytes, String> {
    let raw = fetch_bytes(client, playlist_url).await?;
    assemble(client, &String::from_utf8_lossy(&raw), playlist_url).await
}

/// Собирает поток из уже полученного текста плейлиста.
///
/// Отдельно от `download`, потому что вызывающая сторона часто уже держит тело ответа в
/// руках: она скачала ссылку, не зная заранее, аудио там или плейлист. Повторный запрос за
/// тем же манифестом стоил бы лишнего round-trip'а и — на подписанных ссылках с коротким
/// сроком — иногда просто не проходил бы.
pub async fn assemble(
    client: &Client,
    playlist: &str,
    playlist_url: &str,
) -> Result<Bytes, String> {
    let mut text = playlist.to_string();
    let mut base = playlist_url.to_string();

    // Master playlist перечисляет не сегменты, а варианты качества. Разворачиваем, пока не
    // дойдём до медиа-плейлиста: без этого «сегментами» оказались бы вложенные .m3u8 и
    // склеенный файл был бы набором манифестов.
    for _ in 0..MAX_PLAYLIST_DEPTH {
        if is_protected(&text) {
            return Err(DRM_ERROR.to_string());
        }
        if !text.contains("#EXT-X-STREAM-INF") {
            break;
        }
        let (_, variants) = parse_playlist(&text, &base);
        let variant = variants
            .into_iter()
            .next()
            .ok_or_else(|| "master playlist без вариантов".to_string())?;
        let raw = fetch_bytes(client, &variant).await?;
        text = String::from_utf8_lossy(&raw).into_owned();
        base = variant;
    }

    if is_protected(&text) {
        return Err(DRM_ERROR.to_string());
    }

    let (init_url, segment_urls) = parse_playlist(&text, &base);
    if segment_urls.is_empty() {
        return Err("в плейлисте нет сегментов".into());
    }

    let mut buf = BytesMut::new();

    if let Some(ref init) = init_url {
        let data = fetch_bytes(client, init).await?;
        // `enca`/`encv` в заголовке init-сегмента — признак зашифрованных сэмплов даже
        // тогда, когда в плейлисте про ключ ничего не сказано.
        if data.windows(4).any(|w| w == b"enca" || w == b"encv") {
            return Err(DRM_ERROR.to_string());
        }
        buf.extend_from_slice(&data);
    }

    let mut inflight: Vec<tokio::task::JoinHandle<Result<Bytes, String>>> = Vec::new();
    let mut next_idx = 0usize;

    let fill_queue = |inflight: &mut Vec<tokio::task::JoinHandle<Result<Bytes, String>>>,
                      next_idx: &mut usize,
                      client: &Client,
                      urls: &[String]| {
        while *next_idx < urls.len() && inflight.len() < PREFETCH_SEGMENTS {
            let c = client.clone();
            let u = urls[*next_idx].clone();
            inflight.push(tokio::spawn(async move { fetch_bytes(&c, &u).await }));
            *next_idx += 1;
        }
    };

    fill_queue(&mut inflight, &mut next_idx, client, &segment_urls);

    while !inflight.is_empty() {
        let handle = inflight.remove(0);
        match handle.await {
            Ok(Ok(chunk)) => buf.extend_from_slice(&chunk),
            Ok(Err(e)) => return Err(format!("сегмент не скачался: {e}")),
            Err(e) => return Err(format!("задача сегмента упала: {e}")),
        }
        fill_queue(&mut inflight, &mut next_idx, client, &segment_urls);
    }

    Ok(buf.freeze())
}

/// Скачивает ссылку целиком. Для progressive-потока это и есть готовое аудио.
pub async fn fetch_bytes(client: &Client, url: &str) -> Result<Bytes, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("request: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    resp.bytes().await.map_err(|e| format!("body: {e}"))
}

/// Возвращает (init-сегмент, список ссылок) — для медиа-плейлиста это сегменты, для
/// master'а варианты качества.
fn parse_playlist(content: &str, base_url: &str) -> (Option<String>, Vec<String>) {
    let base = Url::parse(base_url).unwrap_or_else(|_| Url::parse("https://localhost").unwrap());
    let mut init_url = None;
    let mut urls = Vec::new();

    for line in content.lines() {
        let line = line.trim();
        if let Some(start) = line.find("#EXT-X-MAP:URI=\"") {
            let rest = &line[start + 16..];
            if let Some(end) = rest.find('"') {
                init_url = Some(resolve_url(&rest[..end], &base));
            }
            continue;
        }
        if line.starts_with('#') || line.is_empty() {
            continue;
        }
        urls.push(resolve_url(line, &base));
    }

    (init_url, urls)
}

fn resolve_url(url: &str, base: &Url) -> String {
    if url.starts_with("http://") || url.starts_with("https://") {
        return url.to_string();
    }
    base.join(url)
        .map(|u| u.to_string())
        .unwrap_or_else(|_| url.to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_protected, looks_like_playlist, parse_playlist};
    use url::Url;

    /// Живая проверка сквозного пути «собрали HLS в память → отдали декодеру плеера».
    ///
    /// Нужна затем, что симптом «играет короткий звук в начале и тишина» не отличим снаружи
    /// от «ссылка просрочилась» или «сеть отвалилась»: и там и там слышно одно и то же. Тест
    /// берёт свежую подписанную m3u8-ссылку из окружения, собирает поток ровно тем же
    /// `assemble`, что и плеер, и печатает, сколько секунд аудио из этого буфера реально
    /// достаёт `rodio::Decoder`. Если декодированная длительность заметно короче трека —
    /// виноват декодер, а не сеть.
    ///
    /// ```text
    /// LOMIFY_TEST_HLS_URL='https://…/playlist.m3u8?…' \
    ///   cargo test --lib shared::hls::tests::assembled_stream_decodes_to_the_end -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "live network: нужна свежая подписанная ссылка в LOMIFY_TEST_HLS_URL"]
    fn assembled_stream_decodes_to_the_end() {
        use rodio::Source;

        let url = std::env::var("LOMIFY_TEST_HLS_URL")
            .expect("нет LOMIFY_TEST_HLS_URL — подставь свежую подписанную ссылку");

        // Тот же User-Agent, что у плеера: раздача SoundCloud и Яндекса отвечает 403 на
        // клиентов без браузерного UA, и тест «падал бы по сети», ничего не проверив.
        let client = reqwest::Client::builder()
            .user_agent(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            )
            .no_proxy()
            .build()
            .expect("client");

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let bytes = runtime
            .block_on(super::download(&client, &url))
            .expect("поток не собрался");

        let head: Vec<String> = bytes
            .iter()
            .take(16)
            .map(|b| format!("{b:02x}"))
            .collect();
        println!("собрано {} байт, начало: {}", bytes.len(), head.join(" "));

        let source = crate::audio::decode::build_symphonia_decoder(&bytes)
            .expect("декодер отказался");
        let rate = source.sample_rate().get() as f64;
        let channels = source.channels().get() as f64;
        let reported = source.total_duration();
        let samples = source.count() as f64;
        let decoded_secs = samples / (rate * channels);

        println!(
            "декодер: {rate} Гц, {channels} кан., total_duration={reported:?}, \
             сэмплов={samples}, реально декодировано {decoded_secs:.1} с"
        );

        // 30 секунд — заведомо больше одного сегмента HLS (у SoundCloud ~10 с) и заведомо
        // меньше любого трека, которым имеет смысл проверять.
        assert!(
            decoded_secs > 30.0,
            "декодировано всего {decoded_secs:.1} с — буфер обрывается на первых сегментах"
        );
    }

    #[test]
    fn playlist_is_recognised_by_content() {
        assert!(looks_like_playlist(b"#EXTM3U\n#EXT-X-VERSION:7\n"));
        assert!(looks_like_playlist(b"\n#EXTM3U"));
        // Первые байты mp3 (ID3) и mp4 (ftyp) плейлистом быть не должны.
        assert!(!looks_like_playlist(b"ID3\x04\x00\x00\x00"));
        assert!(!looks_like_playlist(b"\x00\x00\x00\x20ftypM4A "));
        assert!(!looks_like_playlist(b""));
    }

    #[test]
    fn fairplay_playlist_is_protected() {
        let drm = "#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://abc\",\
                   KEYFORMAT=\"com.apple.streamingkeydelivery\"\n";
        assert!(is_protected(drm));
    }

    #[test]
    fn plain_playlist_is_not_protected() {
        let plain = "#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nseg0.mp3\n";
        assert!(!is_protected(plain));
        // Явное «дальше не зашифровано» запретом не считается.
        assert!(!is_protected("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n"));
    }

    #[test]
    fn segments_resolve_against_the_playlist_url() {
        let playlist = "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:10,\n\
                        data000.m4s\n#EXTINF:10,\nhttps://cdn/data001.m4s\n#EXT-X-ENDLIST\n";
        let (init, segments) = parse_playlist(playlist, "https://host/a/b/playlist.m3u8?e=1");
        assert_eq!(init.as_deref(), Some("https://host/a/b/init.mp4"));
        assert_eq!(
            segments,
            vec![
                "https://host/a/b/data000.m4s".to_string(),
                "https://cdn/data001.m4s".to_string(),
            ]
        );
        // Базовый адрес должен разбираться — иначе относительные сегменты уехали бы в
        // localhost и весь трек «скачался» бы как набор ошибок.
        assert!(Url::parse("https://host/a/b/playlist.m3u8?e=1").is_ok());
    }
}
