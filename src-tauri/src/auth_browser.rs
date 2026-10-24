//! Self-contained completion pages. Only fixed copy is rendered, never callback parameters.
use std::io::{self, Write};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy)]
pub enum AuthProvider { Google, Spotify }
#[derive(Clone, Copy)]
pub enum AuthResult { Received, Cancelled, Invalid }

const TEMPLATE: &str = include_str!("auth_browser.html");
const SCRIPT: &str = include_str!("auth_browser.js");

pub fn render(provider: AuthProvider, result: AuthResult) -> String {
    let provider_name = match provider { AuthProvider::Google => "Google", AuthProvider::Spotify => "Spotify" };
    let (state, eyebrow, title, description, next_title, next_description) = match result {
        AuthResult::Received => (
            "received", "Почти готово", format!("Ответ {provider_name} получен"),
            format!("Вернись в Lomify, чтобы завершить подключение. Эта вкладка уже передала ответ {provider_name} в приложение."),
            "Открой окно Lomify", "Дождись результата в карточке подключения. После входа Google там появится твоя почта.",
        ),
        AuthResult::Cancelled => (
            "cancelled", "Можно попробовать снова", "Вход отменён".to_string(),
            "Подключение не завершено. Вернись в Lomify, если захочешь повторить вход.".to_string(),
            "Повтори вход в приложении", "Открой Настройки, затем Подключения и снова нажми кнопку входа нужного сервиса.",
        ),
        AuthResult::Invalid => (
            "invalid", "Нужна новая попытка", "Вход не завершён".to_string(),
            "Не удалось подтвердить этот ответ. Вернись в Lomify и начни вход заново.".to_string(),
            "Открой Настройки в Lomify", "В разделе Подключения найди нужный сервис и снова нажми кнопку входа.",
        ),
    };
    let next_description = if matches!((provider, result), (AuthProvider::Spotify, AuthResult::Received)) {
        "Дождись результата в карточке Spotify. Подключение завершится в приложении."
    } else { next_description };
    let logo = STANDARD.encode(include_bytes!("../icons/128x128.png"));
    TEMPLATE.replace("{{logo}}", &logo).replace("{{provider}}", provider_name)
        .replace("{{result}}", state).replace("{{eyebrow}}", eyebrow)
        .replace("{{title}}", &title).replace("{{description}}", &description)
        .replace("{{next-title}}", next_title).replace("{{next-description}}", next_description)
        .replace("{{script}}", &SCRIPT.replace("\r\n", "\n"))
}

pub fn write_response(stream: &mut impl Write, provider: AuthProvider, result: AuthResult) -> io::Result<()> {
    let body = render(provider, result);
    let script_hash = STANDARD.encode(Sha256::digest(SCRIPT.replace("\r\n", "\n").as_bytes()));
    let status = if matches!(result, AuthResult::Invalid) { "400 Bad Request" } else { "200 OK" };
    write!(stream, "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'sha256-{script_hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\nConnection: close\r\n\r\n", body.len())?;
    stream.write_all(body.as_bytes())?;
    stream.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_response_is_self_contained_and_has_exact_utf8_length() {
        let mut bytes = Vec::new();
        write_response(&mut bytes, AuthProvider::Google, AuthResult::Received).unwrap();
        let response = String::from_utf8(bytes).unwrap();
        let (headers, body) = response.split_once("\r\n\r\n").unwrap();
        assert!(headers.contains(&format!("Content-Length: {}", body.len())));
        assert!(headers.contains("Cache-Control: no-store") && headers.contains("default-src 'none'"));
        assert!(headers.contains(&format!("'sha256-{}'", STANDARD.encode(Sha256::digest(SCRIPT.replace("\r\n", "\n").as_bytes())))));
        assert!(body.contains("data:image/png;base64,") && body.contains("<style>"));
        assert!(!body.contains("{{") && !body.contains("https://") && !body.contains("id_token") && !body.contains("access_token"));
    }
    #[test]
    fn received_response_does_not_claim_that_account_connection_is_complete() {
        for provider in [AuthProvider::Google, AuthProvider::Spotify] {
            let received = render(provider, AuthResult::Received);
            assert!(received.contains("чтобы завершить подключение"));
            assert!(!received.contains("Вход выполнен") && !received.contains("Spotify подключён"));
            let cancelled = render(provider, AuthResult::Cancelled);
            assert!(cancelled.contains("Вход отменён") && !cancelled.contains("Почти готово"));
        }
        let mut bytes = Vec::new();
        write_response(&mut bytes, AuthProvider::Google, AuthResult::Invalid).unwrap();
        assert!(bytes.starts_with(b"HTTP/1.1 400 Bad Request\r\n"));
    }
}
