# Проверка безопасного входа в Windows

Секреты Яндекса, Spotify и Last.fm сохраняются в Windows Credential Manager через
`tauri-plugin-keyring-store` 0.2.0. Настройки, плейлисты, публичный SoundCloud client_id
и обычный кэш не шифруются. Мобильный проект в этом изменении не затронут.

## Что изменено

- `src/lib/secretStorage.ts`: загрузка секретов, очередь операций и ожидание готовности.
- `src/lib/secretMigration.ts`: старая запись сохраняется до проверки всех перенесённых секретов.
- `src/lib/stores.ts`: секретные поля исключены из `lomifynext_settings`.
- `src/lib/spotify.ts`, `src/lib/lastfm.ts`: в browser storage остаются только публичные данные аккаунта.
- `src-tauri/src/secrets.rs`: запись с проверкой чтения, удаление и перенос старых файлов.
- `src-tauri/src/lastfm.rs`: подпись и отправка запросов Last.fm с личными ключами.
- `src/lib/logRedaction.ts`, `src/hooks.client.ts`, `src-tauri/src/shared/log_redaction.rs`:
  маскирование заголовков, токенов, ключей сессии и известных значений в логах и ошибках.
- `src-tauri/src/network/soundcloud_bypass.rs`: срок хранения диагностики потока три минуты,
  очистка при запуске, выходе и отключении SoundCloud.

Команды `auth_status`, `auth_set_session`, `auth_logout`, `auth_set_premium`,
`ym_import_start`, `ym_import_stop` и событие `auth:changed` не имели frontend-вызовов.
Активные `auth/mod.rs` и `import/ym.rs` удалены из сборки. Вложенные неактивные копии
не изменялись. Старые `auth_session.json` и `sc-auth.json` переносятся независимо;
их содержимое не возвращается в интерфейс.

Last.fm использует личный API key и Shared secret из существующей формы подключения.
Shared secret и session key остаются в системном хранилище и используются только Rust.
`VITE_LASTFM_SHARED_SECRET` больше не читается. Встроенного общего секрета нет.

Старая страница callback Spotify больше не сохраняет одноразовый код входа.
Его прежняя неиспользуемая запись очищается при запуске. Текущий вход получает
code/state через нативное подтверждение, создаёт verifier в памяти и не сохраняет их.

## Автоматические проверки

```text
npm run check
node --experimental-strip-types --test src/lib/secretMigration.test.mjs src/lib/logRedaction.test.mjs
node --experimental-vm-modules --test scripts/secret-storage-test.mjs
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
npm run tauri dev
node scripts/audit-secret-history.mjs
```

Тесты проверяют успешную миграцию, отказ записи, отказ чтения, несовпадение прочитанного
значения, частичную запись нескольких секретов, сохранение старой копии при сбое browser
storage, ожидание загрузки перед реальным транспортом Яндекса и маскирование логов.
Нативные тесты также проверяют старые файлы, подпись Last.fm, запрет посторонних методов,
истечение диагностики и реальное хранилище Windows в отдельном тестовом пространстве.
Тестовая запись удаляется; реальные аккаунты тест не использует.

Проверка запуска через Tauri подтвердила доступность обычных и именованных секретных
команд, отказ чтения Last.fm-секретов, запрет сырого экспорта keyring и отсутствие старого
auth IPC. Временный проверочный код удалён после проверки.

Поиск по шаблонам в текущих файлах и истории Git не обнаружил секретов.
При проверке завершённой реализации: 757 версий из истории и 247 текущих текстовых файлов.
Это проверка характерных шаблонов, а не доказательство отсутствия любых возможных секретов.
`.env`, старые auth-файлы и файл диагностики исключены из Git.

Проверка типов: 0 ошибок и 0 предупреждений. Сборка интерфейса прошла.
Тесты frontend/миграции и ежедневных подборок: 32 прошли. Rust: 40 прошли,
8 существующих тестов проигрывателя пропущены. Запуск Tauri и проверка пяти правил
доступа к командам прошли; воспроизведение музыки реальных аккаунтов не проверялось.
Проверка новых подборок и их ручной чек-лист: [DAILY_MIXES.md](DAILY_MIXES.md).

## Что проверить вручную

1. Открой «Настройки» и подключи Яндекс, Spotify и Last.fm обычным способом. Для Last.fm
   введи свои API key и Shared secret, разреши доступ в браузере и заверши подключение.
2. Полностью закрой Lomify через выход в меню значка возле часов. Открой снова.
   Все подключённые аккаунты должны сохраниться. Поиск Яндекса и запуск трека должны работать.
3. Проверь Spotify: открой список доступных плейлистов после перезапуска. Затем проверь
   Last.fm: профиль загружается, проигрываемая песня появляется в Now Playing,
   дослушанная песня добавляется в историю Last.fm.
4. Для проверки старых файлов нажми Win+R, вставь `%APPDATA%\com.lomify.next` и нажми Enter.
   После успешного переноса `auth_session.json` и `sc-auth.json` должны отсутствовать.
   Если хранилище отказало, файлы должны остаться, а приложение должно сообщить об ошибке переноса.
5. В отладочной версии проверь browser storage без копирования значений:
   `lomifynext_settings` не содержит `yandexToken` и секретных полей Spotify/Last.fm;
   `lomifynext_spotify_session` содержит Client ID и срок действия;
   записи Last.fm содержат публичные данные и время начала подтверждения.
   При неудачной миграции старая секретная запись должна оставаться до успешного повторения.
6. Отвяжи аккаунт в «Настройках», закрой приложение и открой снова. Аккаунт должен оставаться
   отключённым. Нажми Win+R, вставь `control.exe /name Microsoft.CredentialManager`,
   открой «Учётные данные Windows» и проверь удаление соответствующей записи Lomify.
7. После ошибки потока SoundCloud файл `soundcloud-bypass-playback.json` должен удалиться
   после трёх минут, при следующем запуске, выходе или отвязке SoundCloud.

Вход в реальные аккаунты, обновление Spotify после истечения access token и реальный
скробблинг Last.fm требуют ручной проверки. Android и macOS: не проверено.

## Полный список файлов этого изменения

Список относится к коммитам текущей задачи. Прежние незакоммиченные правки в него не включены.

### Нативная часть и её конфигурация

- `src-tauri/Cargo.lock` - изменён.
- `src-tauri/Cargo.toml` - изменён.
- `src-tauri/build.rs` - изменён.
- `src-tauri/capabilities/default.json` - изменён.
- `src-tauri/capabilities/tray-desktop.json` - добавлен.
- `src-tauri/permissions/account-secrets.toml` - добавлен.
- `src-tauri/permissions/desktop-commands.toml` - добавлен.
- `src-tauri/src/app/diagnostics.rs` - изменён.
- `src-tauri/src/auth/mod.rs` - удалён из активной сборки.
- `src-tauri/src/import/mod.rs` - изменён.
- `src-tauri/src/import/ym.rs` - удалён из активной сборки.
- `src-tauri/src/lastfm.rs` - добавлен.
- `src-tauri/src/lib.rs` - изменён.
- `src-tauri/src/network/direct_fetch.rs` - изменён.
- `src-tauri/src/network/soundcloud_bypass.rs` - изменён.
- `src-tauri/src/secrets.rs` - добавлен.
- `src-tauri/src/shared/log_redaction.rs` - добавлен.
- `src-tauri/src/shared/mod.rs` - изменён.

### Frontend и его тесты

- `src/hooks.client.ts` - добавлен.
- `src/lib/api.ts` - изменён.
- `src/lib/changelog.ts` - изменён.
- `src/lib/components/DailyMixes.svelte` - добавлен.
- `src/lib/components/LastFmConnect.svelte` - изменён.
- `src/lib/components/Settings.svelte` - изменён.
- `src/lib/components/SpotifyImport.svelte` - изменён.
- `src/lib/dailyMixes.test.mjs` - добавлен.
- `src/lib/dailyMixes.ts` - добавлен.
- `src/lib/dailyMixesCore.test.mjs` - добавлен.
- `src/lib/dailyMixesCore.ts` - добавлен.
- `src/lib/lastfm.ts` - изменён.
- `src/lib/logRedaction.test.mjs` - добавлен.
- `src/lib/logRedaction.ts` - добавлен.
- `src/lib/secretMigration.test.mjs` - добавлен.
- `src/lib/secretMigration.ts` - добавлен.
- `src/lib/secretStorage.ts` - добавлен.
- `src/lib/spotify.ts` - изменён.
- `src/lib/stores.ts` - изменён.
- `src/lib/yandex.ts` - изменён.
- `src/routes/+layout.svelte` - изменён.
- `src/routes/+page.svelte` - изменён.
- `src/routes/callback/+page.svelte` - изменён.

### Документы, проверки и настройки репозитория

- `.env.example` - изменён.
- `.gitignore` - изменён.
- `docs/DAILY_MIXES.md` - добавлен.
- `docs/PROJECT_MAP.md` - изменён.
- `docs/SECURE_STORAGE_WINDOWS.md` - добавлен.
- `scripts/audit-secret-history.mjs` - добавлен.
- `scripts/secret-storage-test.mjs` - добавлен.
