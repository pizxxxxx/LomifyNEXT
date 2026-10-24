fn main() {
    println!("cargo:rerun-if-changed=google-desktop.local.json");
    // Google's desktop registration parameter is bundled in the native binary.
    // It cannot be treated as a server secret; PKCE and state protect each login.
    // Only an installed-client file is accepted. Never use Web/Admin credentials.
    if let Ok(source) = std::fs::read_to_string("google-desktop.local.json") {
        let config: serde_json::Value = serde_json::from_str(&source).expect("Invalid local Google Desktop configuration");
        let client = &config["installed"];
        for (key, env_name) in [("client_id", "LOMIFY_GOOGLE_DESKTOP_CLIENT_ID"), ("client_secret", "LOMIFY_GOOGLE_DESKTOP_CLIENT_SECRET")] {
            let value = client[key].as_str().expect("Expected a Google Desktop installed-client file");
            assert!((8..=200).contains(&value.len()) && value.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)), "Invalid local Google Desktop configuration");
            println!("cargo:rustc-env={env_name}={value}");
        }
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["secret_save", "secret_get", "secret_exists", "secret_delete", "secret_migrate_legacy", "secret_clear_legacy", "lastfm_signed_request"]),
    )).expect("Tauri build configuration failed")
}
