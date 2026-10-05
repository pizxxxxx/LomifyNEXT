// Native modules share the same sanitization at the stdout/stderr boundary.
macro_rules! println {
    () => { std::println!() };
    ($($args:tt)*) => { std::println!("{}", crate::shared::log_redaction::redact_text(&format!($($args)*))) };
}
macro_rules! eprintln {
    () => { std::eprintln!() };
    ($($args:tt)*) => { std::eprintln!("{}", crate::shared::log_redaction::redact_text(&format!($($args)*))) };
}

mod app;
mod rockium;
mod audio;
mod secrets;
mod lastfm;
mod discord;
mod import;
mod network;
mod shared;
mod track_cache;

use std::sync::{Arc, Mutex};
use tauri::Manager;

use discord::commands::DiscordState;
use network::server::ServerState;

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    let _ = network::soundcloud_bypass::clear_playback_issue(&app);
    app.exit(0);
}

/// WebView2 normally keeps decoded images, script heaps and render caches around for fast
/// revisits. Lomify is a long-running player rather than a tab-heavy browser, so ask the
/// runtime to release those caches more aggressively. Older WebView2 runtimes simply fail
/// the interface cast; that is logged and startup continues normally.
#[cfg(windows)]
fn request_low_webview_memory(app: &tauri::App) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
    };
    use windows_core::Interface;

    let Some(main) = app.get_webview_window("main") else {
        return;
    };

    if let Err(error) = main.with_webview(|webview| {
        let result = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.cast::<ICoreWebView2_19>())
                .and_then(|core| {
                    core.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW)
                })
        };
        if let Err(error) = result {
            eprintln!("[WebView2] low-memory target is unavailable: {error}");
        }
    }) {
        eprintln!("[WebView2] failed to configure memory target: {error}");
    }
}

#[cfg(not(windows))]
fn request_low_webview_memory(_app: &tauri::App) {}

/// Иконка кнопки приложения на панели задач Windows.
///
/// Tauri выставляет окну только «малую» иконку - ту, что видно в заголовке. Кнопку на панели
/// задач Windows берёт из «большой», а её никто не задавал: окно отвечало на запрос пустотой,
/// и оболочка подставляла картинку из своего кэша иконок. Кэш же хранил прежнее оформление с
/// тёмной подложкой - из-за этого на панели держался квадрат с фоном, хотя в приложении и в
/// самом файле программы иконка давно прозрачная. Здесь оба слота задаются явно, поэтому
/// панель задач показывает текущую иконку и в кэш больше не заглядывает.
///
/// Файл иконки вшит в приложение и один раз распаковывается в папку данных: `LoadImageW` умеет
/// читать `.ico` только с диска, зато сама выбирает подходящий по размеру кадр из набора и
/// масштабирует его правильно.
#[cfg(windows)]
fn apply_windows_window_icons(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetSystemMetrics, LoadImageW, SendMessageW, IMAGE_ICON, LR_LOADFROMFILE, SM_CXICON,
        SM_CXSMICON, SM_CYICON, SM_CYSMICON,
    };

    const ICON_BYTES: &[u8] = include_bytes!("../icons/icon.ico");
    const WM_SETICON: u32 = 0x0080;
    const ICON_SMALL: usize = 0;
    const ICON_BIG: usize = 1;

    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let icon_path = data_dir.join("window-icon.ico");
    let needs_write = std::fs::metadata(&icon_path)
        .map(|metadata| metadata.len() != ICON_BYTES.len() as u64)
        .unwrap_or(true);
    if needs_write {
        let _ = std::fs::create_dir_all(&data_dir);
        if std::fs::write(&icon_path, ICON_BYTES).is_err() {
            return;
        }
    }
    let Ok(raw_handle) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(raw_handle.0 as isize);
    let wide: Vec<u16> = icon_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();

    unsafe {
        for (slot, cx, cy) in [
            (ICON_BIG, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON)),
            (
                ICON_SMALL,
                GetSystemMetrics(SM_CXSMICON),
                GetSystemMetrics(SM_CYSMICON),
            ),
        ] {
            if let Ok(handle) = LoadImageW(
                HINSTANCE::default(),
                PCWSTR(wide.as_ptr()),
                IMAGE_ICON,
                cx,
                cy,
                LR_LOADFROMFILE,
            ) {
                SendMessageW(hwnd, WM_SETICON, WPARAM(slot), LPARAM(handle.0));
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_keyring_store::init())
        .plugin(tauri_plugin_liquid_glass::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![])))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_asynchronous_uri_scheme_protocol("scproxy", |_ctx, request, responder| {
            let Some(state) = network::proxy::STATE.get() else {
                responder.respond(
                    http::Response::builder()
                        .status(503)
                        .body(b"not ready".to_vec())
                        .unwrap(),
                );
                return;
            };
            state.rt_handle.spawn(async move {
                responder.respond(network::proxy::handle_uri(request).await);
            });
        })
        .setup(move |app| {
            request_low_webview_memory(app);

            #[cfg(any(windows, all(not(debug_assertions), target_os = "linux")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                // Portable/dev Windows runs have no installer to register the URI.
                // The version the listener starts owns its public Lomify links.
                if let Err(error) = app.deep_link().register_all() {
                    eprintln!("[music-links] registration failed: {}", shared::log_redaction::redact_text(&error.to_string()));
                }
            }

            let cache_dir = app
                .path()
                .app_cache_dir()
                .expect("failed to resolve app cache dir");
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");
            network::soundcloud_bypass::start_playback_issue_cleanup(app.handle());

            let audio_dir = cache_dir.join("audio");
            std::fs::create_dir_all(&audio_dir).ok();

            let liked_audio_dir = cache_dir.join("audio_liked");
            std::fs::create_dir_all(&liked_audio_dir).ok();

            // Raw staging ("А") for freshly downloaded bytes pending transcode
            // into the clean m4a caches ("Б" = audio_dir / audio_liked).
            let incoming_audio_dir = cache_dir.join("audio_incoming");
            std::fs::create_dir_all(&incoming_audio_dir).ok();

            let assets_dir = cache_dir.join("assets");
            std::fs::create_dir_all(&assets_dir).ok();

            let wallpapers_dir = cache_dir.join("wallpapers");
            std::fs::create_dir_all(&wallpapers_dir).ok();

            let images_dir = cache_dir.join("images");
            std::fs::create_dir_all(&images_dir).ok();

            let downloaded_covers_dir = cache_dir.join("audio_covers");
            std::fs::create_dir_all(&downloaded_covers_dir).ok();

            let rt = tokio::runtime::Runtime::new().expect("failed to create tokio runtime");

            let http_client = reqwest::Client::builder().build().unwrap();

            network::proxy::STATE
                .set(network::proxy::State {
                    assets_dir,
                    http_client: http_client.clone(),
                    rt_handle: rt.handle().clone(),
                })
                .ok();

            network::image_cache::STATE
                .set(network::image_cache::ImageCache {
                    dir: images_dir,
                    downloaded_dir: downloaded_covers_dir,
                    http_client,
                })
                .ok();

            let (static_port, proxy_port) = rt.block_on(network::server::start_all(wallpapers_dir));
            let rt_handle = rt.handle().clone();

            #[cfg(windows)]
            network::zapret_catalog::start_updates(
                data_dir.join("soundcloud-bypass-strategies.json"),
                rt_handle.clone(),
            );

            std::thread::spawn(move || {
                rt.block_on(std::future::pending::<()>());
            });

            app.manage(Arc::new(ServerState {
                static_port,
                proxy_port,
            }));
            app::diagnostics::mark_session_started(app.handle());
            app::diagnostics::start_linux_fd_monitor(app.handle());
            app.manage(Arc::new(DiscordState {
                client: Mutex::new(None),
            }));

            let ffmpeg_dir = cache_dir.join("ffmpeg");
            std::fs::create_dir_all(&ffmpeg_dir).ok();

            let mut track_cache_state =
                track_cache::init(audio_dir, liked_audio_dir, incoming_audio_dir);
            track_cache_state.set_app_handle(app.handle().clone());
            let recovery_state = track_cache_state.clone();
            app.manage(track_cache_state);
            // Acquire ffmpeg (system PATH or one-time download) in the background,
            // then sweep interrupted temps and resume transcoding raw files left
            // by a previous crash/close.
            rt_handle.spawn(async move {
                recovery_state.init_ffmpeg(ffmpeg_dir).await;
                recovery_state.recover_incoming().await;
            });

            let audio_state = audio::init();
            let analyser_buffer = audio_state.analyser_buffer.clone();
            app.manage(audio_state);
            audio::start_tick_emitter(app.handle());
            audio::start_media_controls(app.handle());
            audio::start_default_output_monitor(app.handle());
            audio::start_fft_thread(app.handle().clone(), analyser_buffer);

            app.manage(app::popover::TrayState::default());
            app::tray::setup_tray(app).expect("failed to setup tray");

            let call_state = network::call::CallState::init(data_dir.clone(), rt_handle);
            network::call::manage_state(app.handle(), call_state.clone());
            network::call::maybe_autostart(app.handle(), call_state);

            if let Some(main_win) = app.get_webview_window("main") {
                if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
                    let _ = main_win.set_icon(icon);
                }
                #[cfg(windows)]
                apply_windows_window_icons(app.handle(), &main_win);
            }

            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() != "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            // Transient popover (tray left-click) dismisses on blur; a pinned one
            // (opened from the "Mini player" menu) stays put — closed only by its ✕.
            tauri::WindowEvent::Focused(false)
            if window.label() == app::popover::LABEL =>
                {
                    let st = window.app_handle().state::<app::popover::TrayState>();
                    if !st.is_pinned() {
                        let _ = window.hide();
                        st.mark_hidden();
                    }
                }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![exit_app,
            secrets::secret_save,
            secrets::secret_get,
            secrets::secret_exists,
            secrets::secret_delete,
            secrets::secret_migrate_legacy,
            secrets::secret_clear_legacy,
            lastfm::lastfm_signed_request,
            rockium::rockium_publish,
            rockium::rockium_configure,
            app::updater::check_and_download_update,
            app::updater::install_update,
            network::server::get_server_ports,
            app::diagnostics::diagnostics_log,
            discord::commands::discord_connect,
            discord::commands::discord_disconnect,
            discord::commands::discord_set_activity,
            discord::commands::discord_clear_activity,
            get_os_username,
            audio::audio_load_file,
            audio::audio_load_url,
            audio::audio_play,
            audio::audio_pause,
            audio::audio_stop,
            audio::audio_cancel_load,
            audio::audio_seek,
            audio::audio_set_volume,
            audio::audio_set_playback_rate,
            audio::audio_set_ab_loop,
            audio::audio_get_position,
            audio::audio_playback_clock,
            audio::audio_set_eq,
            audio::audio_set_normalization,
            audio::audio_set_spatial,
            audio::audio_is_playing,
            audio::audio_set_metadata,
            audio::audio_set_playback_state,
            audio::audio_set_media_position,
            audio::audio_list_devices,
            audio::audio_switch_device,
            audio::audio_set_follow_default_output,
            audio::audio_set_lyrics_timeline,
            audio::audio_clear_lyrics_timeline,
            audio::audio_set_comments_timeline,
            audio::audio_clear_comments_timeline,
            audio::audio_preview_play,
            audio::audio_preview_stop,
            audio::save_track_to_path,
             import::spotify_oauth_start,
            track_cache::track_ensure_cached,
            track_cache::track_export,
            track_cache::track_is_cached,
            track_cache::track_transcode_status,
            track_cache::track_get_cache_path,
            track_cache::track_get_cache_info,
            track_cache::track_preload,
            track_cache::track_cache_size,
            track_cache::track_liked_cache_size,
            track_cache::track_clear_cache,
            track_cache::track_clear_liked_cache,
            track_cache::track_remove_cached,
            track_cache::track_list_cached,
            track_cache::track_cache_inventory,
            track_cache::track_enforce_cache_limit,
            track_cache::track_smart_cleanup,
            track_cache::track_cache_likes,
            track_cache::track_cache_likes_running,
            track_cache::track_cancel_cache_likes,
            network::image_cache::image_cache_size,
            network::image_cache::image_cache_clear,
            network::image_cache::image_cache_prune,
            network::call::call_set_enabled,
            network::call::call_is_enabled,
            network::call::call_status,
            network::wallpapers::wallpaper_search,
            network::direct_fetch::net_fetch_direct,
            network::soundcloud_bypass::soundcloud_bypass_start,
            network::soundcloud_bypass::soundcloud_bypass_stop,
            network::soundcloud_bypass::soundcloud_bypass_status,
            network::soundcloud_bypass::soundcloud_bypass_test_connection,
            network::soundcloud_bypass::soundcloud_bypass_report_playback_failure,
            network::soundcloud_bypass::soundcloud_clear_playback_issue,
            network::soundcloud_bypass::soundcloud_bypass_strategy_options,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    let _ = network::soundcloud_bypass::clear_playback_issue(window.app_handle());
                    std::process::exit(0);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
                let _ = network::soundcloud_bypass::clear_playback_issue(app);
            }
        });
}

#[tauri::command]
fn get_os_username() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "User".to_string())
}
