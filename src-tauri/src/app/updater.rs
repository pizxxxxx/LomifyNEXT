use std::path::PathBuf;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

#[derive(Clone, serde::Serialize)]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    pub percent: f64,
}

#[tauri::command]
pub async fn check_and_download_update(
    app: AppHandle,
    url: String,
    filename: String,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("LomifyNEXT-Updater")
        .build()
        .map_err(|e| format!("Не удалось инициализировать HTTP клиент: {}", e))?;

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Ошибка сети при скачивании обновления: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("Сервер ответил статусом: {}", res.status()));
    }

    let total = res.content_length().unwrap_or(0);
    let temp_dir = std::env::temp_dir();
    let safe_filename = if filename.is_empty() {
        "LomifyNEXT_Update.exe".to_string()
    } else {
        filename
    };
    let target_path = temp_dir.join(&safe_filename);

    let mut file = tokio::fs::File::create(&target_path)
        .await
        .map_err(|e| format!("Не удалось создать файл на диске: {}", e))?;

    let mut stream = res.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Ошибка при чтении потока: {}", e))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("Ошибка записи на диск: {}", e))?;
        downloaded += chunk.len() as u64;

        if last_emit.elapsed().as_millis() > 100 || (total > 0 && downloaded == total) {
            last_emit = std::time::Instant::now();
            let percent = if total > 0 {
                ((downloaded as f64 / total as f64) * 100.0).min(100.0)
            } else {
                0.0
            };
            let _ = app.emit(
                "update:download-progress",
                DownloadProgress {
                    downloaded,
                    total,
                    percent,
                },
            );
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("Ошибка сохранения файла: {}", e))?;

    Ok(target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn install_update(installer_path: String) -> Result<(), String> {
    let path = PathBuf::from(&installer_path);
    if !path.exists() {
        return Err("Файл установщика не найден на диске".into());
    }

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(&path)
            .spawn()
            .map_err(|e| format!("Не удалось запустить установщик: {}", e))?;
        std::process::exit(0);
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = open::that(&path);
        Ok(())
    }
}
