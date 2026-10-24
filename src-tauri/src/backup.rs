use std::{fs, io::Write, path::Path, time::{SystemTime, UNIX_EPOCH}};
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: usize = 64 * 1024 * 1024;

fn validate_content(content: &str) -> Result<(), String> {
    if content.len() > MAX_BYTES { return Err("Копия больше 64 МБ.".into()); }
    let value: serde_json::Value = serde_json::from_str(content).map_err(|_| "Не удалось подготовить файл .lomi.".to_string())?;
    if value["format"] != "lomify-backup" || value["version"] != 1 || !value["data"].is_object() {
        return Err("Некорректный формат резервной копии.".into());
    }
    Ok(())
}

fn write_backup(path: &Path, content: &str) -> Result<(), String> {
    validate_content(content)?;
    if !path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("lomi")) {
        return Err("Выбери имя файла с расширением .lomi.".into());
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.is_symlink() || !metadata.is_file() { return Err("Выбери обычный файл .lomi.".into()); }
    }
    let parent = path.parent().ok_or("Не удалось определить папку сохранения.")?;
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| "Не удалось подготовить сохранение.")?.as_nanos();
    let temporary = parent.join(format!(".lomify-{}-{nonce}.tmp", std::process::id()));
    let result = (|| -> Result<(), std::io::Error> {
        let mut file = fs::OpenOptions::new().write(true).create_new(true).open(&temporary)?;
        file.write_all(content.as_bytes())?; file.sync_all()?; drop(file);
        if fs::read(&temporary)? != content.as_bytes() {
            return Err(std::io::Error::other("backup verification failed"));
        }
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() { let _ = fs::remove_file(&temporary); }
    result.map_err(|_| "Не удалось сохранить .lomi. Проверь свободное место и выбери доступную папку.".into())
}

/// The native dialog owns the destination. The renderer cannot supply an arbitrary write path.
#[tauri::command]
pub async fn save_lomi_backup(app: tauri::AppHandle, window: tauri::WebviewWindow, content: String, recovery: bool) -> Result<bool, String> {
    if window.label() != "main" { return Err("Сохранение доступно только в главном окне.".into()); }
    validate_content(&content)?;
    tauri::async_runtime::spawn_blocking(move || {
        let title = if recovery { "Сохранить текущие данные перед восстановлением" } else { "Сохранить резервную копию Lomify" };
        let filename = if recovery { "Lomify-before-restore.lomi" } else { "Lomify-backup.lomi" };
        let Some(selected) = app.dialog().file().set_title(title).set_file_name(filename).add_filter("Резервная копия Lomify", &["lomi"]).blocking_save_file() else { return Ok(false); };
        let mut path = selected.into_path().map_err(|_| "Выбери папку на компьютере для сохранения.")?;
        if path.extension().is_none() { path.set_extension("lomi"); }
        write_backup(&path, &content)?;
        Ok(true)
    }).await.map_err(|_| "Не удалось открыть окно сохранения.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    const CONTENT: &str = r#"{"format":"lomify-backup","version":1,"data":{}}"#;
    #[test]
    fn validates_format_before_file_operations() {
        assert!(validate_content(CONTENT).is_ok());
        for value in ["not json", "{}", r#"{"format":"lomify-backup","version":2,"data":{}}"#] { assert!(validate_content(value).is_err()); }
        assert!(write_backup(Path::new("unexpected.exe"), CONTENT).is_err());
    }
    #[test]
    fn saves_and_replaces_only_verified_lomi_files() {
        let dir = std::env::temp_dir().join(format!("lomify-backup-test-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("sample.lomi");
        write_backup(&path, CONTENT).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), CONTENT);
        let newer = r#"{"format":"lomify-backup","version":1,"data":{"test":true}}"#;
        write_backup(&path, newer).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), newer);
        assert!(write_backup(&path, "broken").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), newer);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_file(&path).unwrap(); fs::remove_dir(&dir).unwrap();
    }
}
