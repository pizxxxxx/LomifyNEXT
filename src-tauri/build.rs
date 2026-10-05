fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["secret_save", "secret_get", "secret_delete", "secret_migrate_legacy", "secret_clear_legacy"]),
    )).expect("Tauri build configuration failed")
}
