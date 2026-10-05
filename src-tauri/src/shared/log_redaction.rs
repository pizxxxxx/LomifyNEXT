use std::collections::BTreeSet;
use std::sync::{Mutex, OnceLock};
use regex::Regex;

const MASK: &str = "[скрыто]";
static SECRETS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

pub(crate) fn remember_secret(value: &str) {
    if value.len() < 6 { return; }
    if let Ok(mut values) = SECRETS.lock() {
        values.insert(value.to_string());
        values.insert(urlencoding::encode(value).into_owned());
    }
}

pub(crate) fn redact_text(value: &str) -> String {
    let mut text: String = value.chars().take(65_536).collect();
    if let Ok(values) = SECRETS.lock() {
        for secret in values.iter().rev() { text = text.replace(secret, MASK); }
    }
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| vec![
        Regex::new(r#"(?i)\b(authorization["']?\s*[:=]\s*["']?\s*(?:(?:Bearer|OAuth|Basic)\s+)?)[^"'\s,;}]+"#).unwrap(),
        Regex::new(r"(?i)\b((?:Bearer|OAuth|Basic)\s+)[A-Za-z0-9._~+/=-]+").unwrap(),
        Regex::new(r#"(?i)\b((?:access[_ -]?token|refresh[_ -]?token|yandexToken|spotifyAccessToken|spotifyRefreshToken|lastfmSharedSecret|lastfmSessionKey|token|session[_ -]?key|shared[_ -]?secret|client[_ -]?secret|api_sig|sk|x-session-id)["']?\s*[:=]\s*["']?)[^"'&,;\s}\]]+"#).unwrap(),
        Regex::new(r"(?i)\b((?:access_token|refresh_token|token|session_key|sk)%3d)[^%&\s]+").unwrap(),
        Regex::new(r"(?i)\b((?:set-cookie|cookie)\s*:\s*)[^\r\n]+").unwrap(),
    ]);
    for pattern in patterns { text = pattern.replace_all(&text, format!("${{1}}{MASK}")).into_owned(); }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_are_masked_in_headers_json_queries_and_errors() {
        for source in [
            "Authorization: Bearer fake-access", "authorization=\"OAuth fake-yandex\"",
            r#"{"access_token":"fake-access","refreshToken":"fake-refresh"}"#,
            "https://example.test/?token=fake-token&sk=fake-session&public=yes",
            "session key = fake-session", "sharedSecret: fake-secret",
            "token%3Dfake-token&public=yes", "Cookie: session=fake-cookie; other=fake-other",
        ] { assert!(!redact_text(source).contains("fake-")); }
        assert_eq!(redact_text("status=403&client_id=public"), "status=403&client_id=public");
    }
    #[test]
    fn bare_and_encoded_known_secrets_are_masked() {
        remember_secret("fake+known/native-credential");
        assert!(!redact_text("server echoed fake+known/native-credential").contains("credential"));
        assert!(!redact_text("url/fake%2Bknown%2Fnative-credential").contains("credential"));
    }
}
