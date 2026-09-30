//! Imports only bounded HTTPS desync parameters from public zapret presets.
//! Batch commands, filters, executables and referenced payload files are never run or copied.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const API_BASE: &str = "https://api.github.com/repos/";
const RAW_BASE: &str = "https://raw.githubusercontent.com/";
const MAX_PRESET_BYTES: usize = 64 * 1024;
const MAX_PRESETS: usize = 32;

/// Откуда берутся готовые наборы параметров. Источников два, а не один: у Flowseal наборы
/// подобраны под российских провайдеров, у автора самого zapret лежат эталонные примеры, и там,
/// где не помог первый список, нередко выручает второй.
struct Source {
    /// Подпись перед названием стратегии. По ней человек видит, откуда набор, и по ней же
    /// скрипт обхода отличает свои имена от чужих.
    label: &'static str,
    repo: &'static str,
    branch: &'static str,
    /// Какие файлы репозитория считаются пресетами.
    is_preset: fn(&str) -> bool,
    /// Какие строки внутри пресета имеют смысл для SoundCloud.
    accepts_line: fn(&str) -> bool,
}

fn is_flowseal_preset(path: &str) -> bool {
    path.starts_with("general")
        && path.ends_with(".bat")
        && path.len() <= 64
        && path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" ().".contains(&byte))
}

/// У Flowseal в одном файле лежат строки и для общего списка сайтов, и для отдельных сервисов
/// вроде YouTube. Берём только общие: набор, подобранный под конкретный чужой сервис, для
/// SoundCloud ничего не обещает.
fn accepts_flowseal_line(line: &str) -> bool {
    line.contains("list-general.txt")
}

/// У bol-van пресеты лежат в папке `zapret-winws`. Рядом с обычными есть варианты на Lua: у них
/// свой набор ключей, ни один из которых мы не переносим, поэтому такие строки отсеются сами -
/// в них просто нет `--dpi-desync=`.
fn is_bolvan_preset(path: &str) -> bool {
    path.starts_with("zapret-winws/preset")
        && path.ends_with(".cmd")
        && path.len() <= 80
        && path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b" ()./_-".contains(&byte))
}

fn accepts_bolvan_line(_line: &str) -> bool {
    true
}

const SOURCES: [Source; 2] = [
    Source {
        label: "Flowseal",
        repo: "Flowseal/zapret-discord-youtube",
        branch: "main",
        is_preset: is_flowseal_preset,
        accepts_line: accepts_flowseal_line,
    },
    Source {
        label: "Bol-van",
        repo: "bol-van/zapret-win-bundle",
        branch: "master",
        is_preset: is_bolvan_preset,
        accepts_line: accepts_bolvan_line,
    },
];

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

fn parse_profile_line(line: &str, name: &str, source: &Source) -> Option<CatalogStrategy> {
    if !(source.accepts_line)(line) {
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
        name: format!("{} {name}", source.label),
        args,
    })
}

/// Название для списка стратегий: только имя файла, без папки и расширения.
fn preset_display_name(path: &str) -> &str {
    let file = path.rsplit('/').next().unwrap_or(path);
    file.rsplit_once('.').map_or(file, |(stem, _)| stem)
}

/// Разные строки одного пресета дают разные наборы под одним названием. Для автоподбора это
/// безразлично, но стратегию теперь можно выбрать в настройках по названию - значит, названия
/// обязаны быть различимы, иначе выбор в списке и запуск разойдутся.
fn dedupe_names(strategies: &mut [CatalogStrategy]) {
    let mut used: HashSet<String> = HashSet::new();
    for strategy in strategies.iter_mut() {
        if used.insert(strategy.name.clone()) {
            continue;
        }
        for suffix in 2..=99 {
            let candidate = format!("{} {suffix}", strategy.name);
            if used.insert(candidate.clone()) {
                strategy.name = candidate;
                break;
            }
        }
    }
}

fn raw_url(repo: &str, revision: &str, name: &str) -> Result<reqwest::Url, String> {
    let mut url = reqwest::Url::parse(RAW_BASE).map_err(|error| error.to_string())?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Некорректный адрес GitHub".to_string())?;
        for part in repo.split('/') {
            segments.push(part);
        }
        segments.push(revision);
        for part in name.split('/') {
            segments.push(part);
        }
    }
    Ok(url)
}

/// Скачивает пресеты одного источника и возвращает его версию вместе с разобранными наборами.
async fn collect(
    client: &reqwest::Client,
    source: &Source,
) -> Result<(String, Vec<CatalogStrategy>), String> {
    let commit: serde_json::Value = client
        .get(format!("{API_BASE}{}/commits/{}", source.repo, source.branch))
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
        .get(format!(
            "{API_BASE}{}/git/trees/{revision}?recursive=1",
            source.repo
        ))
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
                && (source.is_preset)(name)
                && size as usize <= MAX_PRESET_BYTES)
                .then(|| name.to_string())
        })
        .collect();
    names.sort();
    names.truncate(MAX_PRESETS);

    let mut strategies = Vec::new();
    for name in names {
        let response = client
            .get(raw_url(source.repo, revision, &name)?)
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
        let display = preset_display_name(&name).to_string();
        for line in body.lines() {
            if let Some(strategy) = parse_profile_line(line, &display, source) {
                strategies.push(strategy);
            }
        }
    }
    Ok((revision.to_string(), strategies))
}

pub async fn refresh(path: &PathBuf) -> Result<usize, String> {
    let client = reqwest::Client::builder()
        .user_agent("LomifyNEXT SoundCloud strategy updater")
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| error.to_string())?;

    let mut repos: Vec<&str> = Vec::new();
    let mut revisions: Vec<String> = Vec::new();
    let mut strategies: Vec<CatalogStrategy> = Vec::new();
    let mut seen = HashSet::new();
    let mut failures: Vec<String> = Vec::new();
    // Недоступность одного источника не должна лишать человека второго: каталог собирается из
    // того, что удалось скачать, а неудачи попадают в текст ошибки только если не осталось
    // ничего.
    for source in &SOURCES {
        match collect(&client, source).await {
            Ok((revision, items)) => {
                let before = strategies.len();
                for strategy in items {
                    if seen.insert(strategy.args.join("\0")) {
                        strategies.push(strategy);
                    }
                }
                // Источник попадает в каталог только если из него действительно что-то взято:
                // иначе скрипт обхода сверял бы версию репозитория, не давшего ни одного набора.
                if strategies.len() > before {
                    repos.push(source.repo);
                    revisions.push(revision);
                }
            }
            Err(error) => failures.push(format!("{}: {error}", source.repo)),
        }
    }
    if strategies.is_empty() {
        return Err(if failures.is_empty() {
            "На GitHub не найдены подходящие HTTPS-стратегии".into()
        } else {
            failures.join("; ")
        });
    }
    dedupe_names(&mut strategies);

    let catalog = StrategyCatalog {
        source: repos.join(" + "),
        revision: revisions.join("+"),
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
            let delay = match tokio::time::timeout(Duration::from_secs(90), refresh(&path)).await {
                Ok(Ok(count)) => {
                    eprintln!("[soundcloud] loaded {count} catalog strategy variants");
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
    use super::{
        dedupe_names, parse_profile_line, preset_display_name, refresh, safe_arg, CatalogStrategy,
        StrategyCatalog, SOURCES,
    };

    #[test]
    fn imports_only_bounded_desync_options() {
        let line = r#"--filter-tcp=80,443 --hostlist="%LISTS%list-general.txt" --dpi-desync=fake,multisplit --dpi-desync-repeats=8 --dpi-desync-split-pos=1,midsld --dpi-desync-fake-tls="%BIN%payload.bin" --wf-tcp=* --new ^"#;
        let profile = parse_profile_line(line, "general (ALT)", &SOURCES[0]).unwrap();
        assert_eq!(profile.name, "Flowseal general (ALT)");
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
    fn imports_bolvan_preset_line() {
        let line = r#"--filter-tcp=443 --dpi-desync=fake,multidisorder --dpi-desync-split-pos=midsld --dpi-desync-repeats=6 --dpi-desync-fooling=badseq,md5sig --new ^"#;
        let profile = parse_profile_line(line, "preset1_example", &SOURCES[1]).unwrap();
        assert_eq!(profile.name, "Bol-van preset1_example");
        assert_eq!(
            profile.args,
            [
                "--dpi-desync=fake,multidisorder",
                "--dpi-desync-split-pos=midsld",
                "--dpi-desync-repeats=6",
                "--dpi-desync-fooling=badseq,md5sig",
            ]
        );
    }

    #[test]
    fn skips_lua_and_service_specific_lines() {
        // Вариант на Lua: ни одного переносимого ключа, значит и стратегии из него нет.
        let lua = r#"--filter-tcp=443 --filter-l7=tls --payload=tls_client_hello --lua-desync=fake:blob=fake_default_tls:repeats=6 --new ^"#;
        assert!(parse_profile_line(lua, "preset2_example", &SOURCES[1]).is_none());
        // Строка Flowseal под чужой сервис: для SoundCloud она ничего не обещает.
        let youtube = r#"--filter-tcp=443 --hostlist="%LISTS%list-youtube.txt" --dpi-desync=fake --new ^"#;
        assert!(parse_profile_line(youtube, "general", &SOURCES[0]).is_none());
    }

    #[test]
    fn rejects_untrusted_flags_and_shell_characters() {
        assert!(safe_arg("--wf-tcp=*").is_none());
        assert!(safe_arg("--dpi-desync=fake;Start-Process").is_none());
        assert!(safe_arg("--dpi-desync-fake-tls=\"%BIN%payload.bin\"").is_none());
    }

    #[test]
    fn preset_names_drop_folder_and_extension() {
        assert_eq!(
            preset_display_name("zapret-winws/preset1_example.cmd"),
            "preset1_example"
        );
        assert_eq!(preset_display_name("general (ALT2).bat"), "general (ALT2)");
    }

    #[test]
    fn duplicate_names_get_distinct_suffixes() {
        let mut strategies = vec![
            CatalogStrategy {
                name: "Bol-van preset1_example".into(),
                args: vec!["--dpi-desync=fake".into()],
            },
            CatalogStrategy {
                name: "Bol-van preset1_example".into(),
                args: vec!["--dpi-desync=multisplit".into()],
            },
        ];
        dedupe_names(&mut strategies);
        assert_eq!(strategies[0].name, "Bol-van preset1_example");
        assert_eq!(strategies[1].name, "Bol-van preset1_example 2");
    }

    #[tokio::test]
    #[ignore = "live GitHub request"]
    async fn refreshes_both_catalogs() {
        let path = std::env::temp_dir().join(format!(
            "lomify-soundcloud-strategies-test-{}.json",
            std::process::id()
        ));
        let count = refresh(&path).await.unwrap();
        let catalog: StrategyCatalog =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        println!("source: {}", catalog.source);
        for strategy in &catalog.strategies {
            println!("  {} -> {}", strategy.name, strategy.args.join(" "));
        }
        assert_eq!(catalog.strategies.len(), count);
        assert!(count > 0);
        // Оба источника действительно доходят до каталога, а не только первый.
        assert!(catalog
            .strategies
            .iter()
            .any(|strategy| strategy.name.starts_with("Flowseal ")));
        assert!(catalog
            .strategies
            .iter()
            .any(|strategy| strategy.name.starts_with("Bol-van ")));
        assert!(catalog.strategies.iter().all(|strategy| strategy
            .args
            .iter()
            .all(|arg| !arg.starts_with("--wf-") && !arg.starts_with("--hostlist"))));
        // Имена уникальны: иначе выбор стратегии в настройках был бы неоднозначным.
        let mut names: Vec<_> = catalog
            .strategies
            .iter()
            .map(|strategy| strategy.name.clone())
            .collect();
        names.sort();
        let total = names.len();
        names.dedup();
        assert_eq!(names.len(), total);
        std::fs::remove_file(path).unwrap();
    }
}
