use std::time::Duration;

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata as SmtcMetadata, MediaPlayback, MediaPosition,
    PlatformConfig,
};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::state::AudioState;
use crate::audio::types::MediaCmd;

fn metadata_duration(seconds: f64) -> Option<Duration> {
    (seconds.is_finite() && seconds > 0.0).then(|| Duration::from_secs_f64(seconds))
}

fn media_position(seconds: f64) -> MediaPosition {
    let seconds = if seconds.is_finite() {
        seconds.max(0.0)
    } else {
        0.0
    };
    MediaPosition(Duration::from_secs_f64(seconds))
}

/// SMTC sends button/seek callbacks through the message queue of the thread that created
/// `MediaControls`. Blocking forever on `rx.recv()` starved that queue: Windows kept the
/// session around, but its card and controls could stop updating. The souvlaki Windows
/// examples pump this queue continuously for the same reason.
#[cfg(target_os = "windows")]
fn pump_windows_event_queue() {
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, PeekMessageW, TranslateMessage, MSG, PM_REMOVE, WM_QUIT,
    };

    unsafe {
        let mut message = MSG::default();
        while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
            if message.message == WM_QUIT {
                break;
            }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

pub fn start_media_controls(app: &AppHandle) {
    let handle = app.clone();
    let (tx, rx) = std::sync::mpsc::channel::<MediaCmd>();

    let state = app.state::<AudioState>();
    *state.media_tx.lock().unwrap() = Some(tx);

    std::thread::Builder::new()
        .name("media-controls".into())
        .spawn(move || {
            #[cfg(not(target_os = "windows"))]
            let hwnd = None;

            #[cfg(target_os = "windows")]
            let hwnd = {
                handle.get_webview_window("main").and_then(|window| {
                    use raw_window_handle::HasWindowHandle;

                    window
                        .window_handle()
                        .ok()
                        .and_then(|handle| match handle.as_raw() {
                            raw_window_handle::RawWindowHandle::Win32(handle) => {
                                Some(handle.hwnd.get() as *mut std::ffi::c_void)
                            }
                            _ => None,
                        })
                })
            };

            #[cfg(target_os = "windows")]
            if hwnd.is_none() {
                // `souvlaki` panics on Windows when called without an HWND. Keep the app
                // alive and leave an actionable diagnostic instead of silently losing the
                // whole media-controls thread to that panic.
                eprintln!("[MediaControls] Main window HWND is unavailable");
                return;
            }

            let config = PlatformConfig {
                display_name: "Lomify",
                dbus_name: "lomify",
                hwnd,
            };

            let mut controls = match MediaControls::new(config) {
                Ok(controls) => controls,
                Err(error) => {
                    eprintln!("[MediaControls] Failed to create: {:?}", error);
                    return;
                }
            };

            let event_handle = handle.clone();
            if let Err(error) = controls.attach(move |event: MediaControlEvent| match event {
                    MediaControlEvent::Play => {
                        event_handle.emit("media:play", ()).ok();
                    }
                    MediaControlEvent::Pause => {
                        event_handle.emit("media:pause", ()).ok();
                    }
                    MediaControlEvent::Toggle => {
                        event_handle.emit("media:toggle", ()).ok();
                    }
                    MediaControlEvent::Next => {
                        event_handle.emit("media:next", ()).ok();
                    }
                    MediaControlEvent::Previous => {
                        event_handle.emit("media:prev", ()).ok();
                    }
                    MediaControlEvent::SetPosition(MediaPosition(pos)) => {
                        event_handle.emit("media:seek", pos.as_secs_f64()).ok();
                    }
                    MediaControlEvent::Seek(dir) => {
                        let offset = match dir {
                            souvlaki::SeekDirection::Forward => 10.0,
                            souvlaki::SeekDirection::Backward => -10.0,
                        };
                        event_handle.emit("media:seek-relative", offset).ok();
                    }
                    _ => {}
                }) {
                eprintln!("[MediaControls] Failed to attach controls: {error}");
            }

            loop {
                #[cfg(target_os = "windows")]
                pump_windows_event_queue();

                #[cfg(target_os = "windows")]
                let command = rx.recv_timeout(Duration::from_millis(50));
                #[cfg(not(target_os = "windows"))]
                let command = rx
                    .recv()
                    .map_err(|_| std::sync::mpsc::RecvTimeoutError::Disconnected);

                match command {
                    Ok(MediaCmd::SetMetadata {
                        title,
                        artist,
                        cover_url,
                        duration_secs,
                    }) => {
                        let duration = metadata_duration(duration_secs);
                        let result = controls.set_metadata(SmtcMetadata {
                            title: Some(&title),
                            artist: Some(&artist),
                            cover_url: cover_url.as_deref(),
                            duration,
                            ..Default::default()
                        });

                        // `souvlaki` applies the thumbnail before calling DisplayUpdater.Update().
                        // A malformed, expired, or unsupported cover URI therefore used to hide
                        // the title and artist as well. Retry without art so the track still lands
                        // in the Windows media panel; keep the first error in logs for diagnosis.
                        if let Err(error) = result {
                            if cover_url.is_some() {
                                eprintln!(
                                    "[MediaControls] Metadata cover failed ({error}); retrying without it"
                                );
                                if let Err(retry_error) = controls.set_metadata(SmtcMetadata {
                                    title: Some(&title),
                                    artist: Some(&artist),
                                    cover_url: None,
                                    duration,
                                    ..Default::default()
                                }) {
                                    eprintln!(
                                        "[MediaControls] Failed to publish metadata: {retry_error}"
                                    );
                                }
                            } else {
                                eprintln!("[MediaControls] Failed to publish metadata: {error}");
                            }
                        }
                    }
                    Ok(MediaCmd::SetPlaying(playing)) => {
                        let state = handle.state::<AudioState>();
                        // get_pos() is output time; the OS expects source-timeline position.
                        let pos = state
                            .player
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|player| {
                                media_position(crate::audio::engine::source_pos(&state, player)).0
                            })
                            .unwrap_or_default();
                        let progress = Some(MediaPosition(pos));
                        let playback = if playing {
                            MediaPlayback::Playing { progress }
                        } else {
                            MediaPlayback::Paused { progress }
                        };
                        if let Err(error) = controls.set_playback(playback) {
                            eprintln!("[MediaControls] Failed to publish playback state: {error}");
                        }
                    }
                    Ok(MediaCmd::SetPosition(secs)) => {
                        let state = handle.state::<AudioState>();
                        let is_playing = state
                            .player
                            .lock()
                            .unwrap()
                            .as_ref()
                            .map(|player| !player.is_paused() && !player.empty())
                            .unwrap_or(false);
                        let progress = Some(media_position(secs));
                        let playback = if is_playing {
                            MediaPlayback::Playing { progress }
                        } else {
                            MediaPlayback::Paused { progress }
                        };
                        if let Err(error) = controls.set_playback(playback) {
                            eprintln!("[MediaControls] Failed to publish position: {error}");
                        }
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .expect("failed to spawn media-controls thread");
}

#[cfg(test)]
mod tests {
    use super::{media_position, metadata_duration};

    #[test]
    fn invalid_timeline_values_cannot_kill_media_controls() {
        assert!(metadata_duration(f64::NAN).is_none());
        assert!(metadata_duration(-1.0).is_none());
        assert_eq!(media_position(f64::INFINITY).0.as_secs_f64(), 0.0);
        assert_eq!(media_position(-4.0).0.as_secs_f64(), 0.0);
    }
}
