//! Загрузка потока для анонимного пути SoundCloud.
//!
//! Прямые GET'ы по медиа-хостам SoundCloud — без прокси, без повторов сверх того, что
//! делает сам `reqwest`, и без восстановления по отдельным сегментам: сбой сегмента рвёт
//! всю загрузку, чтобы вызывающая сторона успела уйти на раздачу.
//!
//! Сама сборка HLS живёт в [`crate::shared::hls`] и общая на всё приложение: тот же
//! плейлист приходит и в фоновое кэширование, и в мгновенное воспроизведение. Здесь
//! остались только имена, под которыми её знает этот путь.

use bytes::Bytes;
use reqwest::Client;

use crate::shared::hls;

/// Скачивает одним файлом (progressive-поток).
pub async fn download_progressive(client: &Client, url: &str) -> Result<Bytes, String> {
    let data = hls::fetch_bytes(client, url).await?;
    if data.is_empty() {
        return Err("progressive download returned empty body".into());
    }
    Ok(data)
}

/// Скачивает и склеивает все сегменты HLS-плейлиста.
pub async fn download_hls_full(client: &Client, m3u8_url: &str) -> Result<Bytes, String> {
    hls::download(client, m3u8_url).await
}
