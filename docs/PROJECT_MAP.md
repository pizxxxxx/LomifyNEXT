# LomifyNEXT project map

Last verified: 2026-10-03  
Repository version at verification: 9.5.1

This file is the navigation index for the repository. Read it before broad exploration.
It explains where a change normally belongs; source code is still the final authority.

## 1. Project at a glance

LomifyNEXT is a desktop audio player that combines SoundCloud and Yandex Music, with
local/offline tracks, Spotify playlist import, Last.fm scrobbling and taste history,
lyrics, likes, playlists, a native audio engine, cache management, media controls,
Discord Rich Presence, tray controls, and visual customization.

Primary stack:

- Tauri 2 desktop shell and command/event bridge.
- Rust 2021 native backend.
- SvelteKit 2 + Svelte 5 + TypeScript frontend.
- Vite 6 and the Svelte static adapter; the application is an SPA with SSR disabled.
- Tailwind CSS 4 plus large project-owned CSS files.
- `rodio`, `cpal`, `rustfft`, and FFmpeg-related code for native playback and processing.

High-level runtime flow:

```text
Svelte routes/components
        |
        +--> Svelte stores and browser persistence
        +--> SoundCloud/Yandex/Spotify/Last.fm API modules
        +--> Tauri invoke/listen bridge
                  |
                  v
          src-tauri/src/lib.rs
                  |
        +---------+----------+-----------+
        |                    |           |
      audio              track_cache   network/auth/app/discord/import
        |                    |           |
        +---------- OS audio, filesystem, HTTP, tray and media controls
```

## 2. Start here by task

| Task | First files to inspect |
| --- | --- |
| App startup, global theme, window-level effects | `src/routes/+layout.svelte`, `src/app.css` |
| Windows taskbar, shortcut and executable icons | `src-tauri/src/lib.rs` (`apply_windows_window_icons`), `src-tauri/icons/tray.png`, `src-tauri/icons/icon.ico`, `src-tauri/tauri.conf.json`, `src-tauri/src/app/tray.rs` |
| Page/view navigation and home layout | `src/routes/+page.svelte`, `src/lib/stores.ts` |
| Player controls, listening time or queue behavior | `src/lib/components/Player.svelte`, `src/lib/stores.ts`, `src/lib/wave.ts`, `src-tauri/src/audio/commands.rs` |
| Native playback, seeking, volume, crossfade | `src-tauri/src/audio/commands.rs`, `src-tauri/src/audio/engine.rs`, `src-tauri/src/audio/state.rs` |
| Audio output devices | `src/lib/audioOutput.ts`, `src-tauri/src/audio/device.rs` |
| Equalizer or FFT visualizer | `src/lib/components/Equalizer.svelte`, `src/lib/components/Fullscreen.svelte`, `src/lib/fft.ts`, `src-tauri/src/audio/eq.rs`, `src-tauri/src/audio/analyser.rs` |
| SoundCloud search, metadata, playlist import by URL, stream choice | `src/lib/api.ts` |
| Windows SoundCloud Zapret bypass and strategy selection | `src/lib/components/Settings.svelte`, `src-tauri/src/network/soundcloud_bypass.rs`, `src-tauri/src/network/zapret_catalog.rs`, `src-tauri/resources/zapret/` |
| Yandex Music account, search, likes, playlists, video shots, Wave, streams | `src/lib/yandex.ts`, `src/lib/playlistImport.ts`, `src/lib/wave.ts`, `src/lib/likes.ts` |
| Lyrics | `src/lib/components/Lyrics.svelte`, `src/lib/api.ts`, `src/lib/lyrics.ts`, `src-tauri/src/audio/timing.rs` |
| Likes and likes synchronization | `src/lib/likes.ts`, `src/lib/stores.ts`, `src/lib/components/Library.svelte` |
| Local library/imported files | `src/lib/db.ts`, `src/lib/components/Library.svelte` |
| Downloading, transcoding, offline audio/covers | `src/lib/offlineCovers.ts`, `src/lib/cacheMaintenance.ts`, `src-tauri/src/track_cache/`, `src-tauri/src/network/image_cache.rs` |
| Automatic cache cleanup | `src/lib/cacheMaintenance.ts`, `src/lib/components/Settings.svelte`, `src-tauri/src/track_cache/state.rs`, `src-tauri/src/network/image_cache.rs` |
| HTTP proxy, images, wallpapers, local servers | `src-tauri/src/network/` |
| Settings UI or persistence | `src/lib/components/Settings.svelte`, `src/lib/stores.ts` |
| HiDPI/interface scale | `src/routes/+layout.svelte`, `src/lib/components/Settings.svelte`, `src/lib/stores.ts`, `src-tauri/capabilities/default.json` |
| Tray, popover, diagnostics | `src-tauri/src/app/` |
| Account secrets and legacy migration | `src/lib/secretStorage.ts`, `src-tauri/src/secrets.rs` |
| Discord Rich Presence | `src-tauri/src/discord/commands.rs` |
| Yandex library import | `src/lib/playlistImport.ts`, `src/lib/yandex.ts` |
| Spotify account/library import | `src/lib/spotify.ts`, `src/lib/musicImport.ts`, `src/lib/components/SpotifyImport.svelte`, `src-tauri/src/import/spotify.rs` |
| Last.fm account, cloud reports, recommendations, scrobbling | `src/lib/lastfm.ts`, `src/lib/components/LastFmConnect.svelte`, `src/lib/components/Profile.svelte`, `src/lib/components/Player.svelte`, `src/lib/api.ts` |
| Auto-updates and GitHub releases | `src/lib/updater.ts`, `src-tauri/src/app/updater.rs`, `src/routes/+layout.svelte`, `src/lib/components/Settings.svelte` |
| Windows installer appearance, pages, artwork, licence text | `src-tauri/installer/installer.nsi`, `src-tauri/installer/`, `scripts/build-installer-assets.ps1`, `src-tauri/tauri.conf.json` |
| Mis-aimed clicks after a relayout, card tilt drift | `src/lib/utils/hitGuard.ts`, `src/lib/utils/tilt.ts`, `src/lib/components/Library.svelte`, `src/routes/+layout.svelte` |
| Release/version update | `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src/lib/version.ts`, changelog |

## 3. Repository layout

| Path | Role |
| --- | --- |
| `src/` | Active Svelte frontend. |
| `src/routes/` | SvelteKit shell, main screen, and callback route. |
| `src/lib/components/` | Screens and reusable UI components. |
| `src/lib/actions/` | Svelte actions for range dragging and liquid-glass interaction. |
| `src/lib/utils/` | Small frontend helpers for artists, navigation, visual effects, and formatting. |
| `src-tauri/src/` | Active Rust/Tauri application. |
| `src-tauri/capabilities/` | Tauri permission/capability declarations. |
| `src-tauri/installer/` | Windows NSIS installer assets: forked `installer.nsi` template, `header.bmp`, `sidebar.bmp`, `license.rtf`. Referenced from `bundle.windows.nsis` in `src-tauri/tauri.conf.json`. |
| `scripts/` | Repository helper scripts run by hand, not by the app. |
| `.gitattributes` | Pins `*.ps1` to LF. `core.autocrlf` is on in this repository, so without the rule git would hand out the SoundCloud bypass script with CRLF on one clone and LF on another. Its SHA-256 is compiled into the binary, so that would make the hash differ between clones. Every `.ps1` here is already LF with BOM, so the rule only fixes the current state in place. |
| `utils/` | Rust helper crates referenced from `src-tauri/Cargo.toml`. |
| `static/` | Files copied into the frontend build as static assets. |
| `permissions/` | Additional permission definitions kept at repository root. |
| `README.md` | User-facing project overview, features and download links. |
| `src/lib/changelog.ts` | Current and historical release notes shown in the app. |

Generated, dependency, and local-only paths that should not be used for architecture
discovery:

- `node_modules/`
- `.svelte-kit/`
- `build/`, `build_output/`, `dist/`, `.output/`
- `src-tauri/target/` and any other `target/`
- `.agents/` and `.claude/` are local agent assets; `.vscode/` is IDE configuration.
  Skip them for architecture discovery unless the task explicitly concerns agent or IDE setup.
- `tauri-dev.log` and other `*.log`

## 4. Frontend map

### Routes and composition

| File | Responsibility |
| --- | --- |
| `src/routes/+layout.ts` | Disables SSR for the Tauri SPA. |
| `src/routes/+layout.svelte` | Initializes stores, applies themes/effects, restores output device, schedules daily cache maintenance, sets up title bar and global app behavior. |
| `src/routes/+page.svelte` | Main composition root: sidebar, home, view switching, player, fullscreen overlay, notifications, initial data loading. |
| `src/routes/callback/+page.svelte` | Legacy browser OAuth callback page; current desktop Spotify import uses the native loopback callback instead. |

`currentView` in `src/lib/stores.ts` is the current manual view router. Its known values
are `home`, `search`, `library`, `settings`, `lyrics`, `equalizer`, `fullscreen`, `profile`,
and `artist`. When adding a view, update the union types, navigation history logic,
`+page.svelte`, and the sidebar or other entry controls together.

### Main components

| Component | Responsibility |
| --- | --- |
| `Player.svelte` | Playback orchestration, queue, preloading, crossfade decisions, Tauri audio commands, media/tray events, Discord activity, and listening statistics from the native output clock. |
| `Search.svelte` | Search UI and results for configured sources. |
| `Library.svelte` | Likes, playlists, SoundCloud/Yandex playlist import by URL, local files, disliked/hidden tracks, caching/download actions, library layouts. |
| `Settings.svelte` | All settings groups, account/source configuration, Yandex account playlist import, cache controls, autostart, diagnostics-facing controls. |
| `Lyrics.svelte` | Lyrics loading, synchronization, seeking, alignment, and line rendering. |
| `Fullscreen.svelte` | Fullscreen player, fullscreen lyrics, FFT visualization, optional Yandex video shot background, playback-rate integration, and split/panning track titles. |
| `Equalizer.svelte` | Ten-band equalizer UI and presets. |
| `ArtistPage.svelte` | Artist profile with source metadata/biography, releases/albums and persisted track sorting; the compact photo header does not publish a page atmosphere. |
| `ArtistTrackList.svelte` | Shared artist/album track rows with dates, duration, available play counts, likes, expandable metadata and progressive rendering. |
| `Profile.svelte` | User profile dashboard, local listening/likes/playlist statistics, ranked tracks, listening history grouped by day, SoundCloud/Yandex/Last.fm identity, and cloud Last.fm period reports. The history reuses `listenStats.history` (one record per track with `count` and `lastPlayedAt`) sorted by time, so a track appears once with its latest play; there is no separate chronological journal. |
| `Sidebar.svelte` | Main view navigation, support entry to the existing Settings dialog, and the same account-identity precedence as the profile header. |
| `Titlebar.svelte` | Custom Tauri window controls, persisted Windows/macOS-style placement, and window-state saving. |
| `WaveHero.svelte` | Home-page Yandex “My Wave” hero and visual presentation. |
| `PlaylistMenu.svelte` | Add-to-playlist menu. |
| `PlaylistOrderControls.svelte` | Whole-playlist random/smart shuffle and shared persistent undo; smart mode separates artists and collaborations where possible. Saves through the playlist store. |
| `PlaylistSearch.svelte` | Playlist search field, result count, clear action and Escape handling; `Library.svelte` owns the query and progressive results. |
| `PlaylistCoverEditor.svelte` | Local image selection, cover replacement/reset and save feedback in the playlist detail header. |
| `PlaylistTrailer.svelte` | Hover/preview playback for playlist content. |
| `SpotifyImport.svelte` | Spotify developer-app setup and read-only account connection, plus no-Premium local Account data JSON import, progress, cancellation, and recovery UI. |
| `LastFmConnect.svelte` | Last.fm app-key setup, browser authorization, distinct now-playing/recent-scrobble state, monthly favourites dashboard, and account actions. |
| `MusicServiceIcon.svelte` | Local, network-independent provider marks for SoundCloud, Yandex Music, Spotify, and Last.fm. |
| `ArtistTag.svelte` | Clickable artist identity/navigation. |
| `TrackStatus.svelte` | Compact track status/availability indicator. |
| `Notifications.svelte` | Toast-like notifications from the global store. |
| `GlyphWake.svelte` | Capped canvas cursor effect: scroll-coupled terminal-grid glyph puffs, interpolated pointer sampling, lightweight inertia, viewport-edge/collision physics, and reduced-motion/performance gates. |
| `WaveFrame.svelte` | Small visual helper for Wave/soundprint rendering. |
| `ArchiveStation.svelte` | Active grid/card renderer for the Home shelves (`Новые релизы`, `Главная`, similar artists); also owns hover audio preview for those cards. |

The largest frontend hotspots are `WaveHero.svelte`, `Settings.svelte`, `Player.svelte`,
`Library.svelte`, and `ArtistPage.svelte`. Prefer targeted searches inside these files
instead of reading all of them for unrelated changes.

### Home feed fast path

For Home recommendations or Home-card performance, inspect these files first and in this
order; do not scan the whole frontend before them:

1. `src/routes/+page.svelte` — loads the feed, keeps playlists out of the rendered Home
   grid, and progressively exposes at most 96 recommendation cards.
2. `src/lib/api.ts` — `buildTasteProfile()` and `getTrendingTracks()` build/rank the feed
   from likes, repeat listens, recent searches, playlist tracks, cached Last.fm monthly/all-time
   favourites, and similar artists. Playlist and known Last.fm tracks are excluded from returned
   recommendations.
3. `src/lib/components/ArchiveStation.svelte` — the actual Home card markup, responsive/lazy
   cover loading, keyed reconciliation, like lookup, and lazily-created hover preview audio.
4. `src/lib/components/WaveHero.svelte`, `src/routes/+layout.svelte`, and the
   `body[data-perf="light"]` block near the end of `src/app.css` — performance mode stops
   the Wave render loop, card preview/animation work, tilt/glare, blur, and large backdrop
   layers while preserving the normal-mode card appearance.
   `effectivePerformanceMode` in `src/lib/stores.ts` reads the saved `perfMode` preference
   only. `automaticPerformanceMode` (the `detectLowEndDevice` heuristic) is advisory and feeds
   a hint line in Settings; it must not be OR-ed back into the effective mode. It used to be,
   which latched light mode on permanently with the toggle disabled, and that is what removed
   the blur from the sidebar and from fullscreen settings panels in release builds only
   (`navigator.deviceMemory` needs a secure context, and dev and release run on different
   origins, so dev and release disagreed).

### State and data modules

| File | Responsibility |
| --- | --- |
| `src/lib/stores.ts` | Canonical global stores, default settings, navigation state, active library tab, queue, current track, likes, dislikes, playlists, notifications, statistics, localStorage hydration. |
| `src/lib/settings.ts` | Compatibility re-export of the canonical settings store; do not create a second settings store here. |
| `src/lib/api.ts` | SoundCloud requests, playlist import by direct URL, generic safe fetch, search aggregation, stream ranking, related/trending content, cached Last.fm taste/discovery weighting and known-track exclusion, lyrics aggregation, artist/album APIs. |
| `src/lib/yandex.ts` | Yandex token normalization, account APIs, track mapping, search, lyrics, Wave, artist/album APIs, likes, playlist import and video shot metadata, stream URL resolution. |
| `src/lib/playlistImport.ts` | Shared SoundCloud/Yandex playlist link routing and identity-based local merge for Library and Settings; waits for IndexedDB persistence before reporting success. |
| `src/lib/playlistStorage.ts` | IndexedDB snapshot and duplicate cleanup for playlists; replaces the localStorage size limit for large imports. |
| `src/lib/playlistCover.ts` | Shared playlist-cover selection and local JPG/PNG/WebP normalization to a centered square JPEG, at most 768px. |
| `src/lib/likes.ts` | Local like mutation and synchronization queues for remote sources. |
| `src/lib/dislikes.ts` | Disliked/hidden tracks mutation, Yandex Music negative recommendations sync, and Wave/queue filtering. |
| `src/lib/wave.ts` | Yandex Wave session lifecycle and queue refill. |
| `src/lib/waveFilters.ts` | Wave language/content/genre filtering and labels. |
| `src/lib/db.ts` | IndexedDB wrapper for locally imported track metadata. |
| `src/lib/lyrics.ts` | LRC parsing and additional lyrics lookup helpers. |
| `src/lib/audioOutput.ts` | Lists and restores native output-device selection. |
| `src/lib/cacheMaintenance.ts` | Protected likes/recent-cover collection, cache size reads, startup/manual smart-cleanup orchestration. |
| `src/lib/spotify.ts` | Spotify PKCE token/session handling, 2026 Web API pagination, importable-source discovery, and official Account data JSON parsing for no-Premium import. |
| `src/lib/musicImport.ts` | Shared Yandex/SoundCloud matching, deduplication, progress, and atomic library merge for Spotify and file imports. |
| `src/lib/lastfm.ts` | Last.fm signed desktop authorization, local session, cloud charts for week/month/year/all-time, recent and known-track cache, similar-artist discovery, now-playing updates, and listened-time scrobbling. |
| `src/lib/offlineCovers.ts` | Reactive downloaded-track inventory and local cover URLs served by the native loopback server. |
| `src/lib/exportAudio.ts` | Direct track export to MP3/WAV files on disk with tags and cover art. |
| `src/lib/utils/trackUrn.ts` | Canonical track-cache URN builder shared by playback and maintenance. |
| `src/lib/utils/playlistOrder.ts` | Immutable random/smart shuffle and order-only undo, preserving current tracks and metadata; smart artist scheduling uses a heap and bounded candidate selection. |
| `src/lib/utils/playlistSearch.ts` | Full-playlist title/artist matching with case and ё normalization; preserves source indices for numbering and playback from a search result. |
| `src/lib/utils/artistTracks.ts` | Artist track sorting, release-date/duration formatting and the sort preference key. |
| `src/lib/utils/hitGuard.ts` | `pointerMissed(event, element)` rejects clicks whose cursor point is outside the element's fresh `getBoundingClientRect`. Guards against the WebView hit-tree lagging behind a relayout (settings round-trip, tab switch, incremental grid rows); used from `Library.svelte` on the track action rows in capture phase. |
| `src/lib/utils/tilt.ts` | Pointer tilt/glare for track cards. Caches the hovered card's box and re-measures it once per hover when the cursor is more than `OUTSIDE_SLACK` px outside, so cards that move during incremental loading stop tilting from a stale centre. |
| `src/lib/fft.ts` | Fixed-size FFT payload normalization for UI visualizers. |
| `src/lib/updater.ts` | GitHub Releases update checking, semver comparison, asset download tracking, and installer invocation. |
| `src/lib/changelog.ts` | Structured application changelog history, release highlights, expandable details, and agent instructions. |
| `src/lib/version.ts` | UI-facing application name, version, and release channel. |

### Styling

| File | Responsibility |
| --- | --- |
| `src/app.css` | Main global styles, themes, effects, performance mode, and most component-facing utility classes. Accent themes are `[data-theme="…"]` blocks that set `--color-primary` only; `obsidian` is the exception and also overrides `--color-dark`/`--color-dark-gradient`, so it is declared as `html body[data-theme="obsidian"]` with a paired `[data-global-theme="true"]` rule. The picker list lives in `src/lib/components/Settings.svelte` (`themes`). |
| `src/design-aurora.css` | Alternative Aurora design layer. |
| `src/sc-theme.css` | SoundCloud-oriented theme styles. |
| `src/app.html` | HTML shell. |

## 5. Native/Tauri map

### Entry and registration

- `src-tauri/src/main.rs` only launches `lomifynext_tauri_lib::run()`.
- `src-tauri/src/lib.rs` is the native composition root. It registers plugins, creates
  cache/data directories, starts network servers, initializes managed state, starts audio
  workers, configures the tray, and registers every callable Tauri command.
- When a frontend `invoke("command_name")` fails because a new command is unknown, check
  both the command annotation in its module and the `generate_handler!` list in `lib.rs`.

### Native modules

Windows icons: `src-tauri/icons/taskbar.png` is the full-size transparent artwork and the
source the other sizes are generated from. `src-tauri/icons/tray.png` is its 32 px
derivative used for the tray and the Tauri window icon; the original 1536x1536 file expanded
to nine megabytes of pixels on every start and lost definition when scaled to tray size.
Bundle PNGs (32, 64, 128, 256) and `icon.ico` use the same artwork so executable/shortcut
icons match the running window. Keep ICO layers 16, 24, 32, 48, 64 and 128 as 32-bit BMP DIB
with alpha/AND mask; 256 is PNG. This preserves the NSIS icon format correction from 9.4.92.
macOS and mobile artwork are separate.

`apply_windows_window_icons` in `src-tauri/src/lib.rs` sends `WM_SETICON` for both
`ICON_SMALL` and `ICON_BIG`. Tauri's own `set_icon` fills only the small slot (the title bar),
so the taskbar button, which Windows draws from the big slot, had nothing to read and fell
back to the shell icon cache - where the pre-9.5 artwork with a dark plate was still stored.
That is why a background kept showing on the taskbar after the artwork had already become
transparent everywhere else. The function unpacks the embedded `icon.ico` into
`window-icon.ico` in the app data directory because `LoadImageW` reads `.ico` only from disk;
in exchange it picks the right frame from the set and scales it correctly.

| Module | Responsibility |
| --- | --- |
| `app/diagnostics.rs` | Native diagnostics log and Linux file-descriptor monitoring. |
| `app/popover.rs` | Tray popover window state and behavior. |
| `app/tray.rs` | Tray creation and tray actions. |
| `app/updater.rs` | Streaming update download to %TEMP% with progress emission and Windows installer process spawn. |
| `audio/commands.rs` | Tauri command surface for loading, playback, seek, volume, EQ, devices, timelines, preview, and export. |
| `audio/engine.rs` | Playback engine operations and mixer behavior. |
| `audio/state.rs` | Shared audio state and initialization. |
| `audio/decode.rs` | Decode pipeline and normalization analysis/cache. |
| `audio/device.rs` | Output enumeration, switching, and default-device monitoring. |
| `audio/eq.rs` | Equalizer processing. |
| `audio/spatial.rs` | 3D virtual room, Dolby Atmos style binaural crossfeed, and spatial processing. |
| `audio/analyser.rs` | FFT analysis and `audio:fft` emission. |
| `audio/tick.rs` | Playback clock, end detection, reconnect behavior, `audio:tick`. |
| `audio/timing.rs` | Lyrics and floating-comment timelines. |
| `audio/media_controls.rs` | OS media-key/control integration. |
| `secrets.rs` | Named OS credentials, verified writes/deletes and one-way migration of old auth files. Legacy generic auth IPC is closed because the frontend never called it. |
| `discord/commands.rs` | Discord Rich Presence lifecycle. |
| `import/spotify.rs` | Short-lived fixed-port `127.0.0.1:43827` OAuth callback for Spotify PKCE; emits the authorization result without storing tokens. |
| `network/call.rs` | Optional call-client state and persistence. |
| `network/direct_fetch.rs` | Restricted direct native HTTP command. |
| `network/image_cache.rs` | Ordinary image download/LRU plus downloaded-track covers stored by URN and served independently of their music service. |
| `network/proxy.rs` | `scproxy` protocol handling and asset cache. |
| `network/proxy_server.rs` | Local proxy server. |
| `network/static_server.rs` | Local static/wallpaper serving. |
| `network/server.rs` | Starts native servers and exposes their ports. |
| `network/soundcloud_bypass.rs` | Windows-only launcher/status commands for bundled Zapret strategy checks, plus diagnosis of failed SoundCloud track streams. `soundcloud_bypass_start` takes an optional `force` flag (sweep every strategy and keep the fastest even when direct access already works) and an optional `strategy` name (run only that one); `soundcloud_bypass_strategy_options` lists the catalog for the manual picker. It returns immediately, waiting for elevation on a background task so cancellation stays available; the `elevating` state is worded so it does not promise a UAC window, which custom Windows builds may auto-approve without showing anything. Status carries `mode` (`auto`/`force`/`manual`) and a step-by-step `report`. The helper can run beside another winws using a SoundCloud IP-scoped WinDivert filter and never controls other processes. See "SoundCloud bypass launch chain" in section 10 for why the launch is shaped the way it is. |
| `network/zapret_catalog.rs` | Background import of validated HTTPS strategy parameters from the Flowseal and Bol-van GitHub repositories; saves an app-data catalog for the elevated SoundCloud helper, keeping each entry's origin so the UI can show where a strategy came from. |
| `network/wallpapers.rs` | Wallpaper search sources. |
| `shared/hls.rs` | HLS parsing/download helpers shared by playback/cache code. |
| `shared/net.rs` | Shared network validation/helpers. |
| `track_cache/commands.rs` | Tauri cache command surface. |
| `track_cache/state.rs` | Cache inventory, limits, jobs, recovery, and managed state. |
| `track_cache/direct_download.rs` | Direct track downloads. |
| `track_cache/sc_anon/` | Anonymous SoundCloud stream resolution/download support. |
| `track_cache/transcode.rs` | FFmpeg discovery/download, transcoding, temp-file recovery. |

### Tauri command groups

The authoritative registration list is in `src-tauri/src/lib.rs`.

- App/server: `exit_app`, `get_os_username`, `get_server_ports`, `diagnostics_log`.
- Rockium: `rockium_publish`, `rockium_configure`.
- Discord: `discord_connect`, `discord_disconnect`, `discord_set_activity`,
  `discord_clear_activity`.
- Audio: commands prefixed with `audio_`, including `audio_playback_clock` for output time used by listening statistics, plus `save_track_to_path`.
- Import: `spotify_oauth_start`; Yandex import is implemented in frontend modules.
- Track cache: commands prefixed with `track_`.
- Image cache: `image_cache_size`, `image_cache_clear`, `image_cache_prune`.
- Call client: commands prefixed with `call_`.
- Account secrets: `secret_save`, `secret_get`, `secret_delete`, `secret_migrate_legacy`, `secret_clear_legacy`.
- Wallpapers/direct network: `wallpaper_search`, `net_fetch_direct`.
- SoundCloud bypass and connection check: `soundcloud_bypass_start` (optional `force`, optional
  `strategy` name for manual selection), `soundcloud_bypass_stop`, `soundcloud_bypass_status`
  (including Flowseal/Bol-van catalog, playback diagnosis, selection `report`, and `mode` of
  `auto`/`force`/`manual`), `soundcloud_bypass_strategy_options` (name, description and origin
  set for the manual picker), `soundcloud_bypass_test_connection`,
  `soundcloud_bypass_report_playback_failure`.
- Updates: `check_and_download_update`, `install_update`.

Important event families:

- Playback: `audio:tick`, `audio:ended`, `audio:fft`.
- Devices: `audio:default-device-changed`, `audio:device-reconnected`.
- OS media controls: `media:play`, `media:pause`, `media:toggle`, `media:next`,
  `media:prev`, `media:seek`, `media:seek-relative`.
- Timelines: `lyrics:active_line`, `comments:show`.
- App: `tray-action`.
- Spotify import: `spotify:oauth-callback`.
- Updates: `update:download-progress`.
- Cache and import modules also emit progress/status events; inspect the emitting module
  and its matching frontend listener when changing their payloads.

## 6. Persistence and caches

### Browser-side persistence

`src/lib/stores.ts` owns the main localStorage-backed state:

- `lomifynext_settings`
- `lomifynext_stats`
- `lomifynext_likes`
- `lomifynext_dislikes`
- `lomifynext_search_history`
- `lomifynext_active_library_tab`

The settings payload also persists `windowControlsStyle`.

Additional browser keys:

- `lomifynext_likes_sync` in `src/lib/likes.ts`.
- `lomifynext_yandex_twins`, `lomifynext_lyrics_cache`, and `lomifynext_sc_client_id_cache` in `src/lib/api.ts`.
- `lomify-library-liked-view` in `Library.svelte`.
- `lomify-artist-track-sort` in `ArtistPage.svelte` remembers popularity, newest, oldest or title ordering; playback queues use that same order. Library artist cards also support likes, name and recent-addition ordering within the open library view.
- `spotify_auth_code` in the callback route.
- `lomifynext_spotify_session` in `src/lib/spotify.ts` stores the Spotify PKCE access and
  refresh session separately from normal settings; unlinking Spotify removes only this key.
- `lomifynext_lastfm_session`, `lomifynext_lastfm_pending`, and
  `lomifynext_lastfm_overview` in `src/lib/lastfm.ts` store the signed Last.fm session,
  short-lived browser-authorization attempt, and fifteen-minute dashboard/report/taste cache;
  unlinking removes all three.
- `src/routes/+layout.svelte` removes the obsolete `lomifynext_apple_music_session` key at
  startup so tokens saved by builds that briefly exposed Apple Music do not remain on disk.

Optional release-build credentials are documented in `.env.example`:
`VITE_LASTFM_API_KEY` and `VITE_LASTFM_SHARED_SECRET`. Without them, Settings asks the
local user for the corresponding Last.fm developer credentials.

Local imported track metadata is stored in IndexedDB database `LomifyNextDB`, object
store `offline_tracks`, through `src/lib/db.ts`.
Playlists are stored in IndexedDB database `LomifyNextPlaylists`, object store `snapshots`,
through `src/lib/playlistStorage.ts`. `src/lib/stores.ts` migrates the old
`lomifynext_playlists` localStorage key on startup and removes it after a successful write.
Loading also removes saved duplicate playlist IDs and exact Yandex copies with the same
title and track IDs, then persists the cleaned snapshot.
Shuffled playlists include `shuffleOriginalOrder`, a compact list of track identities
from before the first shuffle. Undo survives navigation and restart, skips removed tracks
and appends newly added tracks. Undo clears the snapshot; reimport replaces it with the
imported playlist. These controls change the saved playlist, leaving current playback alone.
The optional playlist `customCoverUrl` stores a compact JPEG data URL in the same snapshot.
Library cards, playlist details and trailers prefer it over the first track cover. Choosing
a JPG/PNG/WebP file up to 20 MB copies its image data, so moving the source file has no effect.
Reset removes the override; playlist-link/account reimport preserves it.

### Native persistence

Native code uses these application cache directories. `src-tauri/src/lib.rs` creates
most of them; the audio commands initialize `audio-normalization/` when needed:

- `audio/` — normal cached tracks.
- `audio_liked/` — liked-track cache.
- `audio_incoming/` — raw/staging files awaiting transcode or recovery.
- `audio-normalization/` — normalization analysis cache created by audio commands.
- `assets/` — proxied assets.
- `wallpapers/` — wallpaper files served locally.
- `images/` — image cache.
- `audio_covers/` — covers tied to downloaded-track URNs; ignored by ordinary image cleanup
  and removed when their matching audio is removed.
- `ffmpeg/` — managed FFmpeg binary/location.

Application data includes `auth_session.json` (with migration from `sc-auth.json`),
`call_enabled.json`, and `soundcloud-bypass-strategies.json` (validated Flowseal strategy
parameters refreshed in the background every six hours). SoundCloud bypass also uses
`soundcloud-bypass-playback.json` for the latest track failure and
`soundcloud-bypass-enabled` for the user's automatic retry preference; disabling the bypass
removes the latter marker. `soundcloud-bypass-status.json` holds the state the settings UI
polls (state, strategy, `mode`, `report`), and `soundcloud-bypass-stop` is the cancel marker
the elevated script checks every 200 ms. `soundcloud-bypass-input.json` carries the built-in
strategy list to the elevated script, and `soundcloud-bypass-launch.log` holds the one line a
failed launch leaves behind. `window-icon.ico` is the unpacked copy of the embedded icon used
for the taskbar button. The three settings keys that gate all of this live
in `src/lib/stores.ts`: `soundcloudBypassEnabled` (whole section, read as `!== false`),
`soundcloudBypassAutoStart` (launch the bypass at app start, wired in
`src/routes/+layout.svelte`), and `soundcloudBypassForce` (sweep every strategy).

Smart cache cleanup is scheduled by `src/routes/+layout.svelte` and runs at most once per
day when `settings.autoCacheCleanup` is enabled. The frontend sends liked/current/recent
track URNs and cover URLs as protected sets. Native `track_smart_cleanup` and
`image_cache_prune` remove only unprotected stale files, then enforce the selected ordinary
cache quota; `audio_liked/` is excluded from quota eviction. The related settings
(`cacheRetentionDays`, `cacheMaxMb`, `lastCacheCleanupAt`) persist in
`lomifynext_settings`.
The same settings object also stores `fullscreenYandexVideo` and
`fullscreenYandexVideoFill`, the fullscreen video-shot and screen-fill toggles.
`fullscreenYandexVideoFill` defaults to on. During settings hydration, an absent
`fullscreenYandexVideoFillDefaultApplied` marker enables it once for existing installs;
later changes to the fill switch persist normally.
It also stores `waveCustomName`, the optional word after «Моя» in the Home station title;
`waveDisplayName` in `src/lib/stores.ts` supplies the fallback «Моя тусня».

Every successful `track_ensure_cached` request may include `coverUrl`. Native code saves
that image into `audio_covers/` without delaying playback. The loopback
`/downloaded-cover/` route serves it by canonical track URN, and can backfill covers for
audio downloaded by older builds while the original source is reachable. Track removal,
ordinary/liked cache clearing, quota enforcement, and smart cleanup prune orphan covers.

The persisted `settings.uiScale` mode controls native WebView zoom. `auto` is calculated
in `src/routes/+layout.svelte` from the Tauri window's physical size divided by the OS
scale factor, using 1920×1080 as 100%; the manual options store their percentage as a
string. Applying it requires `core:webview:allow-set-webview-zoom` in the main capability.

## Playlist synchronization

- `src/lib/playlistSync.ts`: account-bound serialized reconciliation, startup/resume/online
  scheduling, local publication to private Yandex playlists, pause/resume and conflict
  resolution. Mounted from `src/routes/+layout.svelte`; no new Tauri command.
- `src/lib/playlistSyncCore.ts`: occurrence-preserving three-way merge of title/order/
  track membership. Concurrent independent edits merge; opposing names/orders require
  an explicit choice. Unbased legacy copies keep all tracks on initial enrollment.
- `src/lib/yandexPlaylists.ts`: complete authenticated snapshots and form POST create/
  name/change requests through `yandex.ts > ymJson`. Content writes carry the server
  revision and retry conflicts against fresh snapshots. Only own playlists are writable;
  mixed-service lists are rejected before publication.
- `src/lib/api.ts > getSoundCloudSyncPlaylists`: strict paginated public snapshots with
  track hydration and unavailable placeholders; SoundCloud remains pull-only.
- `PlaylistSyncSettings.svelte` is embedded in service connections/settings;
  `PlaylistSyncControl.svelte` owns per-playlist linking, pause, retry and version choice.
- `settings.syncYandexPlaylists` and `settings.syncSoundCloudPlaylists` default to false.
  A playlist's `sync` field persists its provider/account/remote identity, baseline,
  revision, pause state, conflict and error beside ordinary playlist data. Unsent local
  differences survive restart/offline failure. `playlistSyncStorage.ts` adapts the
  desktop IndexedDB flush or mobile synchronous localStorage persistence.
- Hidden synchronized playlists are recorded in `lomifynext_playlist_sync_excluded`
  by provider/account/remote ID. Mobile's existing imported-playlist exclusions also
  apply. Removing a whole playlist in Lomify never calls remote delete.
- `node scripts/playlist-sync-test.mjs` verifies merging, duplicate/empty lists, native
  request payloads, revision retries, offline edits, account switching, writes concurrent
  with local edits, conflict resolution, private publication and read-only SoundCloud.

## 7. Shared Rust crates

The active helper crates are at repository-root `utils/`:

- `utils/call/client`
- `utils/call/relay`
- `utils/decrypt-client`
- `utils/decrypt`
- `utils/dpi-desync`
- `utils/tls-common`

`src-tauri/Cargo.toml` currently references `../utils/call/client` and
`../utils/decrypt-client`. Confirm manifest dependencies before assuming another helper
crate is part of the desktop build.

## 8. Known duplicate and inactive paths

The repository contains tracked nested copies that are not activated by the current
Rust module declarations in `src-tauri/src/lib.rs` and the parent `mod.rs` files:

- `src-tauri/src/audio/audio/`
- `src-tauri/src/app/app/`
- `src-tauri/src/auth/auth/`
- `src-tauri/src/import/import/`
- `src-tauri/src/shared/shared/`

Several differ from their active parent files, so editing the nested copy can produce a
convincing change that never compiles into the application. The active paths are the
parent directories listed in section 5.

`src-tauri/utils/` is an identical tracked mirror of root `utils/`, but the active path
dependencies in `src-tauri/Cargo.toml` resolve to root `utils/`. Treat `src-tauri/utils/`
as inactive unless the manifest changes or the task explicitly concerns the duplicate.

Do not delete duplicate trees merely because they are inactive; removal is a separate
repository-cleanup decision that requires an explicit task.

## 9. Build and verification

| Purpose | Command |
| --- | --- |
| Install JS dependencies | `npm install` |
| Frontend development server only | `npm run dev` |
| Desktop development | `npm run tauri dev` |
| Svelte/TypeScript checks | `npm run check` |
| Playlist shuffle/undo/search regression tests (Node.js 24+) | `node --test src/lib/utils/playlistOrder.test.mjs` |
| Frontend production build | `npm run build` |
| Rust tests | `cargo test --manifest-path src-tauri/Cargo.toml` |
| Desktop bundle | `npm run tauri build` |

Rust unit tests currently live in active audio decode, HLS/shared network helpers,
direct fetch, wallpapers, SoundCloud anonymous cache logic, and transcoding modules.

The package script `npm run push` stages every change, creates a generic commit, and
pushes it. Agents must not run it unless the user explicitly asks for that exact action.

## 10. Release/version synchronization

The desktop application tracks `src-tauri/Cargo.lock`. Tauri and its plugins are pinned in
`src-tauri/Cargo.toml` and `package.json` to the matching versions verified for the release.
Keep both lockfiles when building installers; update the native and JavaScript packages together.

Desktop 9.5.0 was published on 2026-10-02 as GitHub release `v9.5.0` with the NSIS installer
attached; `npm run tauri build` produces
`src-tauri/target/release/bundle/nsis/LomifyNEXT_<version>_x64-setup.exe` from the forked
template in `src-tauri/installer/`. The earlier, prematurely published desktop 9.5.1 release
and tag were withdrawn before that, and the number was reused for the current version. The
Android 1.0.14 release remains published in the mobile repository.

### SoundCloud bypass launch chain

The bypass needs administrator rights, so `soundcloud_bypass_start` runs an unelevated
`powershell.exe` whose only job is `Start-Process -Verb RunAs` for a second `powershell.exe`
that runs `resources/zapret/soundcloud-bypass.ps1`. Facts this shape depends on, all found
the hard way while fixing a launch that silently did nothing in 9.5.0:

- Both shells need `-ExecutionPolicy Bypass`. `-EncodedCommand` itself is not subject to
  execution policy, but `& script.ps1` inside it is, and the Windows default for the machine
  scope is `Restricted`. Without the switch the bypass never ran at all on a machine where
  nobody had relaxed that policy.
- Nothing in the elevated process reports to the user by itself. Anything that fails before
  the script's own `try` - execution policy, a hash mismatch, an unbound parameter - dies in a
  hidden window. `CHILD_TEMPLATE` therefore wraps the whole call in `try`/`catch` and writes
  both the status file and `soundcloud-bypass-launch.log`.
- `Start-Process -Verb RunAs` writes a non-terminating error when elevation is refused, and
  the host `powershell.exe` still exits 0. A zero exit code is not evidence that anything
  started, so the spawned task polls the status file for 25 s and only treats the launch as
  successful once the script has replaced `elevating` with its own state.
- The strategy list goes through `soundcloud-bypass-input.json`, not the command line. As an
  argument it pushed the final command line past 21 000 characters through two base64 layers
  and two nested shells; by file it is about 15 000. Passing it by file is no weaker: every
  strategy argument is checked against the `Test-CatalogArg` allow-list inside the script, and
  the strategy catalog already arrives as a file in the same directory.
- The script writes its first status line before the component hash checks. Those checks read
  a three-megabyte library, and until they finished there was no way to tell a working launch
  from a dead one.
- `read_status` ages `elevating` out after 240 s, but `soundcloud_bypass_start` treats it as
  in-progress for only 30 s. Otherwise a failed first attempt made the button do nothing at all
  for four minutes.

### Windows installer theming

`bundle.windows.nsis.template` points at `src-tauri/installer/installer.nsi`, a fork of the
Tauri CLI 2.11.2 NSIS template with `LOMIFY`-tagged edits only. Keeping it a thin fork is
deliberate: re-diff it against the upstream template when the pinned Tauri CLI version changes.

Facts the fork depends on, all verified empirically:

- NSIS page controls do not live directly under `$HWNDPARENT`. Control 1018 is a hidden
  placeholder; the real page dialog is a `#32770` child with no control ID, so the fork walks
  `FindWindow $0 "#32770" "" $HWNDPARENT $childAfter` in a loop and recolours every match.
- `SetCtlColors` only records colours. A forced
  `USER32::RedrawWindow(hwnd, 0, 0, 0x0185)` is what makes them appear on the current page.
- `SysListView32` (the InstFiles detail list, id 1016) ignores `SetCtlColors`; it needs
  `LVM_SETBKCOLOR`, `LVM_SETTEXTBKCOLOR` and `LVM_SETTEXTCOLOR`.
- The installer runs without visual styles, so push buttons never receive `WM_CTLCOLORBTN`.
  The bottom buttons, `Обзор ...`, `Детали...`, check-box squares and radio circles stay
  native by design; recolouring them would require owner-draw.
- Colours are `COLORREF` (`0x00BBGGRR`), i.e. reverse byte order from CSS `RRGGBB`.

`scripts/build-installer-assets.ps1` regenerates the artwork and the licence page:
`sidebar.bmp` (164x314, 24-bit `BI_RGB` - NSIS rejects other variants), `header.bmp`
(150x57) and `license.rtf`. Run it by hand after changing the icon or wordmark; the outputs
are committed, so a normal build does not need it. The script contains Cyrillic, so it must
stay UTF-8 with BOM - Windows PowerShell 5.1 reads a BOM-less file as ANSI and breaks.

When changing the application version, verify all of these locations:

1. `package.json` and the root package in `package-lock.json` - npm/package version.
2. `src-tauri/Cargo.toml` and its package entry in `src-tauri/Cargo.lock` - Rust package version.
3. `src-tauri/tauri.conf.json` — Tauri bundle version.
4. `src/lib/version.ts` — UI-visible version and channel.
5. Release changelog filename/content when the release process requires it.

## 11. Maintaining this map

### Secure account storage (Windows)

`src/lib/secretStorage.ts` exposes named secret save/read/delete operations through
`src-tauri/src/secrets.rs`. The native module verifies every write by reading it back.
`tauri-plugin-keyring-store` uses the OS credential store; raw plugin export/import
permissions are denied. `src-tauri/permissions/account-secrets.toml` restricts the
application secret commands to the main window capability.

`src/lib/secretMigration.ts` verifies each legacy credential before removing its field
from browser storage. `secretStorage.ts` loads credentials separately before service
requests; failed migrations preserve their source and block settings persistence until
its secret fields have been verified. Yandex settings retain a memory-only token.
Spotify and Last.fm browser session/pending records contain public metadata only;
their tokens, refresh tokens, session keys and personal shared secrets use keyring.
Disconnect actions remove provider credentials before reporting success.

The removed active `auth/mod.rs` and `import/ym.rs` had no frontend callers (including
the `auth:changed` event). Their inactive nested copies remain outside the build.
Old `auth_session.json` and `sc-auth.json` credentials are migrated independently into
reserved keyring entries and each file is removed only after verified persistence.
No legacy token is returned to frontend. Unlinking SoundCloud/reset removes these entries.

### Rockium local playback integration (2026-09-25)

`src/lib/rockiumBridge.ts` is mounted once by `Player.svelte`. It publishes playback,
lyrics (including when the lyrics view is closed), and a normalized 160px PNG cover with retry and multi-source resolution.
Track changes invalidate pending lyric requests and reactive reloads propagate immediately.
`src-tauri/src/rockium.rs` owns the versioned `rockium_publish` and `rockium_configure` commands, registered by `src-tauri/src/lib.rs`.
The backend updates `%LOCALAPPDATA%/LomifyNEXT/integrations/rockium.json` and writes `api.json` with active server port info.
The native audio tick thread in `src-tauri/src/audio/tick.rs` continuously updates position and play state every ~300 ms,
ensuring snapshots remain fresh even when the application is minimized or backgrounded.
In addition, `src-tauri/src/network/proxy_server.rs` serves local HTTP API endpoints (`/rockium`, `/lyrics`, `/now-playing`, `/cover`)
when enabled. Users can toggle the Rockium HTTP server or integration in System Settings: when the server is disabled, `api.json` is automatically deleted and endpoints return 404, prompting Rockium to smoothly fall back to reading `rockium.json` directly from disk without opening any local HTTP port, while internal Lomify streaming and cover proxies (`/p`, `/img`, `/downloaded-cover`) remain entirely unaffected.

### Full-width centered backdrop adlibs (2026-09-25)

`src/lib/components/BackdropAdlibStage.svelte`, `src/lib/stores.ts`, and `src/app.css` implement a cinematic backdrop stage (`.lyrics-backdrop-stage`) for background adlibs (e.g. `(damn)`, `(раскрой)`). To prevent CSS containing-block traps caused by parent transforms (such as `.fs-lyrics-side` in Fullscreen mode), the stage lives at the root view layer (`Fullscreen.svelte` root and `+page.svelte` main layer) and receives state via `activeBackdropAdlib` and `departingBackdropAdlib` stores driven by `src/lib/components/Lyrics.svelte`. Short phrases (up to 6 letters, e.g. "damn", "yeah") dynamically appear on alternating left or right sides with an anti-streak counter and organic tilt (~ -15 deg on the left, ~ +15 deg on the right with randomized jitter). Longer phrases appear centered with large, high-impact font sizes (`getBackdropFontSize` in `src/lib/lyrics.ts`) and safe viewport bounds (`max-width: min(90vw, 1400px)`, `text-wrap: balance`, `word-break: break-word`). To prevent rectangular clipping and box artifacts on GPU compositor layers, text styling uses boundless glyphs with pure `text-shadow` glows and dissipation rather than CSS container blur filters. Departing items dissolve via text-shadow expansion and fade out within 320 ms (`.lyrics-backdrop-callout.is-departing`).



The optional `LOMIFY_BUILD_DIR` environment variable sets the static adapter output directory. Pair it with a Tauri `build.frontendDist` override when the usual `build` directory is locked on Windows; the default remains `build`.

Update this file in the same change when any of the following happens:

- A route, view, composition root, or major component is added or removed.
- Ownership moves between frontend modules or Rust modules.
- A Tauri command/event is added, removed, or changes payload ownership.
- Persistence keys, cache directories, or migration behavior changes.
- A duplicate tree is removed, activated, or replaced.
- Build/test commands or release-version locations change.

Do not update the verification date for a cosmetic edit. Update it only after checking
the affected paths against the repository.
