//! Мелкие сетевые утилиты, общие на всё приложение.

/// Похожа ли ошибка транспорта на сбой системного прокси, а не на проблему с самим адресом.
///
/// Зачем это нужно: в Windows галка «использовать прокси-сервер» остаётся включённой и после
/// того, как VPN-клиент выключен или упал. `reqwest` читает системные настройки, честно идёт
/// в CONNECT-туннель по мёртвому адресу и получает `tunnel error … os error 10061`
/// (соединение отвергнуто). Снаружи это выглядело как «трек не грузится» и «Яндекс отклонил
/// запрос» — при том что сеть в порядке и прямой запрос проходит.
///
/// Отличать такой сбой важно, потому что лечится он единственным способом — повтором в обход
/// прокси. Повторять по тому же маршруту бессмысленно: пока прокси не поднимут, отказ будет
/// приходить на каждой попытке.
pub fn looks_like_proxy_failure(message: &str) -> bool {
    let msg = message.to_ascii_lowercase();
    if msg.contains("tunnel") || msg.contains("proxy") {
        return true;
    }
    // Windows: 10061 — connection refused, 10060 — timed out, 10065 — host unreachable.
    // Сами по себе они значат лишь «не дозвонились», поэтому берём их в расчёт только
    // вместе с признаком установки соединения — иначе под фоллбэк попал бы и честно
    // недоступный CDN.
    let connect_stage = msg.contains("error trying to connect") || msg.contains("connect error");
    connect_stage
        && (msg.contains("os error 10061")
            || msg.contains("os error 10060")
            || msg.contains("os error 10065"))
}

#[cfg(test)]
mod tests {
    use super::looks_like_proxy_failure;

    #[test]
    fn dead_system_proxy_is_recognised() {
        // Ровно то, что писал лог приложения при выключенном VPN и включённой галке прокси.
        assert!(looks_like_proxy_failure(
            "error trying to connect: tunnel error: unsuccessful tunnel: \
             tcp connect error: No connection could be made because the target machine \
             actively refused it. (os error 10061)"
        ));
        assert!(looks_like_proxy_failure(
            "error trying to connect: tcp connect error: (os error 10061)"
        ));
    }

    #[test]
    fn ordinary_failures_are_not_blamed_on_the_proxy() {
        assert!(!looks_like_proxy_failure("HTTP 403"));
        assert!(!looks_like_proxy_failure("operation timed out"));
        assert!(!looks_like_proxy_failure("dns error: failed to lookup address"));
        // Отказ на уровне TLS — не про прокси, повтор напрямую тут ничего не изменит.
        assert!(!looks_like_proxy_failure(
            "error trying to connect: invalid peer certificate: Expired"
        ));
    }
}
