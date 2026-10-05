fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["secret_save", "secret_get", "secret_delete"]),
    )).expect("Tauri build configuration failed")
}
