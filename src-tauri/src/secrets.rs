use std::sync::Mutex;
use std::path::Path;
use tauri::Manager;
use tauri_plugin_keyring_store::{KeyringExt, KeyringStore};

const KEYS: &[&str] = &[
    "yandex_music_token", "spotify_access_token", "spotify_refresh_token",
    "lastfm_shared_secret", "lastfm_session_key", "lastfm_auth_token",
    "lastfm_pending_shared_secret", "legacy_auth_session", "legacy_sc_session",
];
static SECRET_LOCK: Mutex<()> = Mutex::new(());

pub(crate) trait SecretVault {
    fn read(&self, key: &str) -> Result<Option<String>, String>;
    fn write(&self, key: &str, value: &str) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

impl SecretVault for KeyringStore {
    fn read(&self, key: &str) -> Result<Option<String>, String> {
        let value = self.get_password(key).map_err(|_| "Не удалось прочитать системное хранилище".to_string())?;
        if let Some(ref value) = value { crate::shared::log_redaction::remember_secret(value); }
        Ok(value)
    }
    fn write(&self, key: &str, value: &str) -> Result<(), String> {
        crate::shared::log_redaction::remember_secret(value);
        self.set_password(key, value).map_err(|_| "Не удалось записать в системное хранилище".into())
    }
    fn remove(&self, key: &str) -> Result<(), String> {
        self.delete(key).map_err(|_| "Не удалось удалить секрет из системного хранилища".into())
    }
}

pub(crate) fn save_verified(vault: &impl SecretVault, key: &str, value: &str) -> Result<(), String> {
    vault.write(key, value)?;
    if vault.read(key)?.as_deref() != Some(value) {
        return Err("Проверка записи в системное хранилище не прошла".into());
    }
    Ok(())
}

fn check_key(window: &tauri::WebviewWindow, key: &str) -> Result<(), String> {
    if window.label() != "main" || !KEYS.contains(&key) || key.starts_with("legacy_") {
        return Err("Доступ к этому секрету запрещён".into());
    }
    Ok(())
}

pub(crate) async fn with_vault<T: Send + 'static>(
    app: tauri::AppHandle,
    operation: impl FnOnce(&KeyringStore) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let store = app.keyring().store.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = SECRET_LOCK.lock().map_err(|_| "Системное хранилище занято".to_string())?;
        operation(&store)
    }).await.map_err(|_| "Ошибка системного хранилища".to_string())?
}

#[tauri::command]
pub async fn secret_save(app: tauri::AppHandle, window: tauri::WebviewWindow, key: String, value: String) -> Result<(), String> {
    check_key(&window, &key)?;
    if value.is_empty() || value.len() > 16_384 { return Err("Некорректный секрет".into()); }
    with_vault(app, move |vault| {
        if key == "lastfm_pending_shared_secret" { crate::lastfm::invalidate_authorization(); }
        save_verified(vault, &key, &value)
    }).await
}

#[tauri::command]
pub async fn secret_get(app: tauri::AppHandle, window: tauri::WebviewWindow, key: String) -> Result<Option<String>, String> {
    check_key(&window, &key)?;
    if key.starts_with("lastfm_") { return Err("Секрет Last.fm используется только в Rust".into()); }
    with_vault(app, move |vault| vault.read(&key)).await
}

#[tauri::command]
pub async fn secret_exists(app: tauri::AppHandle, window: tauri::WebviewWindow, key: String) -> Result<bool, String> {
    check_key(&window, &key)?;
    with_vault(app, move |vault| Ok(vault.read(&key)?.is_some())).await
}

#[tauri::command]
pub async fn secret_delete(app: tauri::AppHandle, window: tauri::WebviewWindow, key: String) -> Result<(), String> {
    check_key(&window, &key)?;
    with_vault(app, move |vault| {
        if key.starts_with("lastfm_") { crate::lastfm::invalidate_authorization(); }
        vault.remove(&key)?;
        if vault.read(&key)?.is_some() { return Err("Удаление секрета не подтверждено".into()); }
        Ok(())
    }).await
}

const LEGACY_FILES: &[(&str, &str)] = &[
    ("auth_session.json", "legacy_auth_session"),
    ("sc-auth.json", "legacy_sc_session"),
];

pub(crate) fn migrate_legacy_file(vault: &impl SecretVault, path: &Path, key: &str) -> Result<(), String> {
    if !path.exists() { return Ok(()); }
    let bytes = std::fs::read(path).map_err(|_| "Не удалось прочитать старый файл аккаунта".to_string())?;
    let data: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Старый файл аккаунта повреждён. Копия сохранена".to_string())?;
    let candidate = data.get("token").or_else(|| data.get("state")?.get("sessionId"));
    match candidate {
        Some(serde_json::Value::String(token)) => {
            if !token.is_empty() && token != "null" && token != "undefined" { save_verified(vault, key, token)?; }
        },
        Some(serde_json::Value::Null) => {},
        _ => return Err("Старый файл аккаунта не распознан. Копия сохранена".into()),
    }
    std::fs::remove_file(path).map_err(|_| "Секрет сохранён, но старый файл удалить не удалось".to_string())
}

#[tauri::command]
pub async fn secret_migrate_legacy(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    check_key(&window, "yandex_music_token")?;
    let dir = app.path().app_data_dir().map_err(|_| "Не удалось найти папку аккаунта".to_string())?;
    with_vault(app, move |vault| {
        // Process each source independently, so one unreadable file cannot hide another.
        let mut failed = false;
        for (file, key) in LEGACY_FILES {
            if migrate_legacy_file(vault, &dir.join(file), key).is_err() { failed = true; }
        }
        if failed { Err("Перенос старых файлов аккаунта не завершён. Неудалённые копии сохранены".into()) }
        else { Ok(()) }
    }).await
}

#[tauri::command]
pub async fn secret_clear_legacy(app: tauri::AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    check_key(&window, "yandex_music_token")?;
    let dir = app.path().app_data_dir().map_err(|_| "Не удалось найти папку аккаунта".to_string())?;
    with_vault(app, move |vault| {
        for (_, key) in LEGACY_FILES {
            vault.remove(key)?;
            if vault.read(key)?.is_some() { return Err("Удаление старого секрета не подтверждено".into()); }
        }
        for (file, _) in LEGACY_FILES {
            match std::fs::remove_file(dir.join(file)) {
                Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err("Не удалось удалить старый файл аккаунта".into()),
                _ => {},
            }
        }
        Ok(())
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[derive(Default)]
    struct FakeVault { values: RefCell<HashMap<String, String>>, failure: &'static str }
    impl SecretVault for FakeVault {
        fn read(&self, key: &str) -> Result<Option<String>, String> {
            if self.failure == "read" { return Err("read failed".into()); }
            if self.failure == "mismatch" { return Ok(Some("wrong-fake-value".into())); }
            Ok(self.values.borrow().get(key).cloned())
        }
        fn write(&self, key: &str, value: &str) -> Result<(), String> {
            if self.failure == "write" { return Err("write failed".into()); }
            self.values.borrow_mut().insert(key.into(), value.into()); Ok(())
        }
        fn remove(&self, key: &str) -> Result<(), String> { self.values.borrow_mut().remove(key); Ok(()) }
    }

    fn temp_file() -> std::path::PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!("lomify-secret-test-{}-{}.json", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)))
    }

    #[test]
    fn legacy_files_are_removed_only_after_verified_storage() {
        for source in [r#"{"token":"fake-legacy-token","premium":true}"#, r#"{"state":{"sessionId":"fake-legacy-token"}}"#] {
            let path = temp_file();
            std::fs::write(&path, source).unwrap();
            let vault = FakeVault::default();
            migrate_legacy_file(&vault, &path, "legacy_auth_session").unwrap();
            assert!(!path.exists());
            assert_eq!(vault.read("legacy_auth_session").unwrap().as_deref(), Some("fake-legacy-token"));
        }
    }

    #[test]
    fn legacy_file_survives_write_read_and_verification_failures() {
        for failure in ["write", "read", "mismatch"] {
            let path = temp_file();
            let source = r#"{"token":"fake-legacy-token"}"#;
            std::fs::write(&path, source).unwrap();
            let vault = FakeVault { failure, ..Default::default() };
            assert!(migrate_legacy_file(&vault, &path, "legacy_auth_session").is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
            std::fs::remove_file(path).unwrap();
        }
    }

    #[test]
    fn unrecognized_legacy_file_is_preserved() {
        let path = temp_file();
        let source = r#"{"unknown":"fake-unknown"}"#;
        std::fs::write(&path, source).unwrap();
        assert!(migrate_legacy_file(&FakeVault::default(), &path, "legacy_auth_session").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
        std::fs::remove_file(path).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_credential_manager_round_trip() {
        // A separate namespace protects every real application credential.
        let vault = KeyringStore::new(format!("com.lomify.security-test.{}", std::process::id()));
        struct Cleanup(KeyringStore);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = self.0.delete("probe"); } }
        let cleanup = Cleanup(vault.clone());
        save_verified(&vault, "probe", "fake-windows-probe").unwrap();
        assert_eq!(vault.read("probe").unwrap().as_deref(), Some("fake-windows-probe"));
        vault.remove("probe").unwrap();
        assert_eq!(vault.read("probe").unwrap(), None);
        drop(cleanup);
    }
}
