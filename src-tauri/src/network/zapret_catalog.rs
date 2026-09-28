//! Imports only bounded HTTPS desync parameters from Flowseal's general presets.
//! Batch commands, filters, executables and referenced payload files are never run or copied.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const REPO_API: &str = "https://api.github.com/repos/Flowseal/zapret-discord-youtube";
const RAW_BASE: &str = "https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/";
const MAX_PRESET_BYTES: usize = 64 * 1024;
const MAX_PRESETS: usize = 32;

#[derive(Debug, Serialize, Deserialize)]
pub struct CatalogStrategy {
    pub name: String,
    pub args: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StrategyCatalog {
    pub source: String,
    pub revision: String,
    pub updated_at: u64,
    pub strategies: Vec<CatalogStrategy>,
}

fn ascii_value(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".,_+=!-".contains(&byte))
}

fn split_marker(value: &str) -> bool {
    ascii_value(value, 80)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b",+-".contains(&byte))
}

fn safe_arg(raw: &str) -> Option<String> {
    let (key, value) = raw.trim_end_matches('^').split_once('=')?;
    let value = value.trim_matches('"');
    let allowed = match key {
        "--dpi-desync" => {
            let modes: Vec<_> = value.split(',').collect();
            !modes.is_empty()
                && modes.len() <= 3
                && modes.iter().all(|mode| {
                    matches!(
                        *mode,
                        "fake" | "multisplit" | "multidisorder" | "fakedsplit" | "hostfakesplit"
                    )
                })
        }
        "--dpi-desync-repeats" => value
            .parse::<u8>()
            .is_ok_and(|number| (1..=20).contains(&number)),
        "--dpi-desync-fooling" => {
            let modes: Vec<_> = value.split(',').collect();
            !modes.is_empty()
                && modes.len() <= 4
                && modes
                    .iter()
                    .all(|mode| matches!(*mode, "badseq" | "ts" | "md5sig" | "hopbyhop2"))
        }
        "--dpi-desync-split-pos" | "--dpi-desync-hostfakesplit-midhost" => split_marker(value),
        "--dpi-desync-split-seqovl" => value.parse::<u16>().is_ok_and(|number| number <= 2048),
        "--dpi-desync-badseq-increment" => value
            .parse::<i32>()
            .is_ok_and(|number| number.unsigned_abs() <= 100_000_000),
        "--dpi-desync-fakedsplit-pattern" | "--dpi-desync-fake-tls" => {
            value.len() >= 4
                && value.len() <= 512
                && value.starts_with("0x")
                && value[2..].bytes().all(|byte| byte.is_ascii_hexdigit())
        }
        "--dpi-desync-fake-tls-mod" => {
            ascii_value(value, 120)
                && value.split(',').all(|part| {
                    matches!(part, "none" | "rnd" | "rndsni" | "dupsid" | "padencap")
                        || part
                            .strip_prefix("sni=")
                            .is_some_and(|host| ascii_value(host, 64))
                })
        }
        "--dpi-desync-hostfakesplit-mod" => {
            ascii_value(value, 120)
                && value.split(',').all(|part| {
                    matches!(part, "none" | "altorder=0" | "altorder=1")
                        || part
                            .strip_prefix("host=")
                            .is_some_and(|host| ascii_value(host, 64))
                })
        }
        "--ip-id" => value == "zero",
        _ => false,
    };
    allowed.then(|| format!("{key}={value}"))
}

fn parse_profile_line(line: &str, name: &str) -> Option<CatalogStrategy> {
    if !line.contains("list-general.txt") {
        return None;
    }
    let tokens: Vec<_> = line.split_whitespace().collect();
    let tcp_ports = tokens
        .iter()
        .find_map(|token| token.strip_prefix("--filter-tcp="))?;
    if !tcp_ports.split(',').any(|port| port == "443") {
        return None;
    }
    let args: Vec<_> = tokens.into_iter().filter_map(safe_arg).take(12).collect();
    if !args.iter().any(|arg| arg.starts_with("--dpi-desync=")) {
        return None;
    }
    Some(CatalogStrategy {
        name: format!("Flowseal {name}"),
        args,
    })
}

fn raw_url(revision: &str, name: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(RAW_BASE).map_err(|error| error.to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Некорректный адрес GitHub".to_string())?
        .push(revision)
        .push(name);
    Ok(url)
}

pub async fn refresh(path: &PathBuf) -> Result<usize, String> {
    let client = reqwest::Client::builder()
        .user_agent("LomifyNEXT SoundCloud strategy updater")
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| error.to_string())?;
    let commit: serde_json::Value = client
        .get(format!("{REPO_API}/commits/main"))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let revision = commit["sha"]
        .as_str()
        .filter(|value| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or("GitHub не вернул версию набора стратегий")?;
    let tree: serde_json::Value = client
        .get(format!("{REPO_API}/git/trees/{revision}?recursive=1"))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    if tree["truncated"].as_bool() == Some(true) {
        return Err("GitHub вернул неполный список стратегий".into());
    }
    let mut names: Vec<_> = tree["tree"]
        .as_array()
        .ok_or("GitHub не вернул файлы стратегий")?
        .iter()
        .filter_map(|entry| {
            let name = entry["path"].as_str()?;
            let size = entry["size"].as_u64()?;
            (entry["type"] == "blob"
                && name.starts_with("general")
                && name.ends_with(".bat")
                && name.len() <= 64
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b" ().".contains(&byte))
                && size as usize <= MAX_PRESET_BYTES)
                .then(|| name.to_string())
        })
        .collect();
    names.sort();
    names.truncate(MAX_PRESETS);

    let mut strategies = Vec::new();
    let mut seen = HashSet::new();
    for name in names {
        let response = client
            .get(raw_url(revision, &name)?)
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
        if response
            .content_length()
            .is_some_and(|size| size as usize > MAX_PRESET_BYTES)
        {
            continue;
        }
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if bytes.len() > MAX_PRESET_BYTES {
            continue;
        }
        let body = String::from_utf8_lossy(&bytes);
        for line in body.lines() {
            if let Some(strategy) = parse_profile_line(line, name.trim_end_matches(".bat")) {
                let identity = strategy.args.join("\0");
                if seen.insert(identity) {
                    strategies.push(strategy);
                }
            }
        }
    }
    if strategies.is_empty() {
        return Err("На GitHub не найдены подходящие HTTPS-стратегии".into());
    }
    let catalog = StrategyCatalog {
        source: "Flowseal/zapret-discord-youtube".into(),
        revision: revision.into(),
        updated_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_secs(),
        strategies,
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec(&catalog).map_err(|error| error.to_string())?;
    std::fs::write(path, bytes).map_err(|error| error.to_string())?;
    Ok(catalog.strategies.len())
}

pub fn start_updates(path: PathBuf, runtime: tokio::runtime::Handle) {
    runtime.spawn(async move {
        loop {
            let delay = match tokio::time::timeout(Duration::from_secs(60), refresh(&path)).await {
                Ok(Ok(count)) => {
                    eprintln!("[soundcloud] loaded {count} Flowseal strategy variants");
                    Duration::from_secs(6 * 60 * 60)
                }
                Ok(Err(error)) => {
                    eprintln!("[soundcloud] strategy update failed: {error}");
                    Duration::from_secs(30 * 60)
                }
                Err(_) => Duration::from_secs(30 * 60),
            };
            tokio::time::sleep(delay).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{parse_profile_line, refresh, safe_arg, StrategyCatalog};

    #[test]
    fn imports_only_bounded_desync_options() {
        let line = r#"--filter-tcp=80,443 --hostlist="%LISTS%list-general.txt" --dpi-desync=fake,multisplit --dpi-desync-repeats=8 --dpi-desync-split-pos=1,midsld --dpi-desync-fake-tls="%BIN%payload.bin" --wf-tcp=* --new ^"#;
        let profile = parse_profile_line(line, "general (ALT)").unwrap();
        assert_eq!(
            profile.args,
            [
                "--dpi-desync=fake,multisplit",
                "--dpi-desync-repeats=8",
                "--dpi-desync-split-pos=1,midsld",
            ]
        );
    }

    #[test]
    fn rejects_untrusted_flags_and_shell_characters() {
        assert!(safe_arg("--wf-tcp=*").is_none());
        assert!(safe_arg("--dpi-desync=fake;Start-Process").is_none());
        assert!(safe_arg("--dpi-desync-fake-tls=\"%BIN%payload.bin\"").is_none());
    }

    #[tokio::test]
    #[ignore = "live GitHub request"]
    async fn refreshes_flowseal_catalog() {
        let path = std::env::temp_dir().join(format!(
            "lomify-soundcloud-strategies-test-{}.json",
            std::process::id()
        ));
        let count = refresh(&path).await.unwrap();
        let catalog: StrategyCatalog =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(catalog.strategies.len(), count);
        assert!(count > 0);
        assert!(catalog.strategies.iter().all(|strategy| strategy
            .args
            .iter()
            .all(|arg| !arg.starts_with("--wf-") && !arg.starts_with("--hostlist"))));
        std::fs::remove_file(path).unwrap();
    }
}
