//! Запрос в обход системного прокси.
//!
//! Зачем это отдельная команда, а не `plugin-http`: плагин собирает `reqwest`-клиент со
//! настройками прокси из системы и отключить их из JS нельзя. А в Windows галка «использовать
//! прокси-сервер» остаётся включённой и после того, как VPN выключен или упал, — и тогда
//! каждый запрос уходит в мёртвый CONNECT-туннель. Для Яндекс Музыки это выглядело особенно
//! обидно: до API запрос не доходил, приложение показывало «Яндекс отклонил запрос», и человек
//! шёл менять исправный токен.
//!
//! Область намеренно узкая — только GET и POST и только к хостам Яндекса. В заголовке уходит
//! OAuth-токен от аккаунта, поэтому произвольный адрес здесь недопустим: команда, которой
//! можно передать любой URL, превратилась бы в способ отправить токен куда угодно.
//!
//! POST появился ради «Моей волны»: станция принимает отметки о треках
//! (`radioStarted`/`trackStarted`/`trackFinished`/`skip`) только POST-ом с телом JSON, и без
//! них волна не подстраивается под то, что человек слушает и пропускает. Список методов
//! закрытый, а не «любой из args»: смысл команды — узкая щель к Яндексу, и PUT или DELETE в
//! ней не нужны никому, кроме того, кто захочет что-нибудь испортить чужим токеном.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

const REQUEST_TIMEOUT_SECS: u64 = 20;

/// Хосты, к которым разрешено ходить этой командой. Сравнение по суффиксу домена, чтобы
/// охватить `api.music.yandex.net`, `music.yandex.ru` и раздачи `*.strm.yandex.net`.
const ALLOWED_SUFFIXES: &[&str] = &[".yandex.net", ".yandex.ru"];

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectFetchArgs {
    pub url: String,
    pub headers: Option<HashMap<String, String>>,
    /// `GET` (по умолчанию) или `POST`. Остальное отклоняется — см. заголовок модуля.
    pub method: Option<String>,
    /// Тело для POST. Строкой: единственный потребитель отправляет JSON.
    pub body: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectFetchResponse {
    pub status: u16,
    pub body: String,
}

fn host_allowed(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    ALLOWED_SUFFIXES
        .iter()
        .any(|suffix| host.ends_with(suffix) || host == suffix.trim_start_matches('.'))
}

/// Метод запроса из аргументов. `Err` — «этой команде такое не поручают».
fn parse_method(raw: Option<String>) -> Result<reqwest::Method, String> {
    match raw.unwrap_or_default().trim().to_ascii_uppercase().as_str() {
        "" | "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        other => Err(format!("метод {other} не разрешён для прямого запроса")),
    }
}

/// Клиент живёт между вызовами: так переиспользуется TLS-сессия, а серия запросов (аккаунт →
/// лайки → гидрация чанками) не пересогласовывает соединение на каждом шаге.
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                // Собственно смысл всей команды.
                .no_proxy()
                .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
                .build()
                .map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| e.clone())
}

#[tauri::command]
pub async fn net_fetch_direct(args: DirectFetchArgs) -> Result<DirectFetchResponse, String> {
    let parsed = reqwest::Url::parse(&args.url).map_err(|e| format!("некорректный адрес: {e}"))?;
    let host = parsed.host_str().unwrap_or_default();
    if !host_allowed(host) {
        return Err(format!("хост {host} не разрешён для прямого запроса"));
    }
    let method = parse_method(args.method)?;

    let mut req = client()?.request(method, parsed);
    for (name, value) in args.headers.unwrap_or_default() {
        req = req.header(name, value);
    }
    if let Some(body) = args.body {
        req = req.body(body);
    }

    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    // Тело отдаём как текст: единственный потребитель — JSON-API, а на отказе периметра там
    // приезжает HTML или страница с капчей, и её тоже важно донести до диагностики.
    let body = resp.text().await.map_err(|e| e.to_string())?;

    Ok(DirectFetchResponse { status, body })
}

#[cfg(test)]
mod tests {
    use super::{host_allowed, parse_method};

    #[test]
    fn yandex_hosts_are_allowed() {
        assert!(host_allowed("api.music.yandex.net"));
        assert!(host_allowed("music.yandex.ru"));
        assert!(host_allowed("s123sas.storage.yandex.net"));
        assert!(host_allowed("yandex.ru"));
    }

    #[test]
    fn lookalike_hosts_are_rejected() {
        // Ровно то, от чего защищает список: адрес, куда мог бы уехать OAuth-токен.
        assert!(!host_allowed("evil.com"));
        assert!(!host_allowed("yandex.net.evil.com"));
        assert!(!host_allowed("notyandex.ru"));
        assert!(!host_allowed(""));
    }

    #[test]
    fn only_get_and_post_pass() {
        // Пустой метод — это «не указали», и он должен вести себя как GET: так команду
        // зовёт весь прежний код, который про поле `method` ничего не знает.
        assert_eq!(parse_method(None).unwrap(), reqwest::Method::GET);
        assert_eq!(parse_method(Some(String::new())).unwrap(), reqwest::Method::GET);
        assert_eq!(parse_method(Some("post".into())).unwrap(), reqwest::Method::POST);
        assert!(parse_method(Some("DELETE".into())).is_err());
        assert!(parse_method(Some("PUT".into())).is_err());
    }
}
