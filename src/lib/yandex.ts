/**
 * Яндекс Музыка. Порт логики из `noverplay-tui-main/src/provider/yandex/*`.
 *
 * Что там на самом деле происходит — важно, потому что слово «OAuth» вводит в заблуждение.
 * Никакого интерактивного OAuth-флоу (окно браузера → redirect_uri → code → token) в
 * noverplay нет вообще. В `credentials.rs` Yandex заведён как обычное текстовое поле:
 *
 *     CredentialKind::YandexToken => "Вставь OAuth из расширения yandex-music-token,
 *                                     токен останется только локально"
 *
 * то есть токен человек добывает сам (расширение `yandex-music-token` вытаскивает его из
 * cookie music.yandex.ru) и вставляет строкой. Всё, что делает `provider/yandex/client.rs` —
 * нормализует её и строит клиент:
 *
 *     token.trim().strip_prefix("OAuth ").unwrap_or(token.trim()).trim()
 *
 * Дальше это заголовок `Authorization: OAuth <token>` к `api.music.yandex.net` — но НЕ он
 * один: рядом обязаны идти заголовки клиента, иначе API отвечает 403 «session-expired» на
 * любой токен (подробности у `authHeaders`). В noverplay их ставит сам крейт
 * `yandex-music-rust`, поэтому в его коде их и не видно — отсюда и взялось ложное
 * представление, что достаточно `Authorization`.
 * Модуль `account/` в noverplay с ed25519-подписями и `api.noverplay.space` к Яндексу
 * отношения не имеет — он добывает SoundCloud client_id, это отдельная история.
 *
 * Соответствие файлов:
 *   client.rs        → normalizeYandexToken + ymJson (заголовок и нормализация)
 *   search.rs        → searchYandex
 *   mapping.rs       → mapYandexTrack + ymCover
 *   playback.rs      → getYandexStreamUrl (+ выбор потока и отбрасывание превью)
 *   related.rs       → getYandexSimilar
 *   playlist*.rs     → getYandexLikes (та же схема: список id → гидрация чанками)
 *
 * Почему запросы идут не через `safeFetch` из api.ts: у того последним шагом стоит
 * `corsproxy.io`. Для публичного SoundCloud API это нормально, а здесь в заголовке лежит
 * OAuth-токен от аккаунта Яндекса — отправлять его на чужой прокси нельзя ни при каких
 * обстоятельствах. Поэтому свой fetch — Tauri-клиент, который и так ходит в сеть мимо CORS
 * и, в отличие от `window.fetch`, умеет выставить `User-Agent` (см. `ymFetch`).
 */

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import md5 from 'md5';

const API = 'https://api.music.yandex.net';

/**
 * Порт `normalizovat_token`, доведённый до того, что люди реально вставляют. Регистр
 * префикса не проверяем: вставляют и «oauth ».
 *
 * Остальные три шага добавлены по разбору отказов. Токен — это строка из
 * `[A-Za-z0-9_-]`, пробелов и переводов строки в нём не бывает НИКОГДА, поэтому
 * внутренние пробелы можно молча выбросить: они попадают в строку при копировании из
 * расширения, где токен показан с переносом, — и дают 403 (заголовок с пробелом внутри
 * Яндекс просто не опознаёт), из которого причину не видно. То же с кавычками (копируют
 * значение из JSON) и с адресом страницы: OAuth-редирект отдаёт токен во фрагменте
 * `#access_token=…&token_type=bearer`, и вставляют иногда весь адрес целиком.
 */
export function normalizeYandexToken(raw: string | null | undefined): string {
  let text = (raw ?? '').trim();

  // Адрес с фрагментом редиректа — вынимаем сам токен. Ищем по всей строке, а не парсим
  // URL: вставляют и обрезанный хвост вида «access_token=…&token_type=bearer».
  const fromUrl = /access_token=([^&\s"'#]+)/i.exec(text);
  if (fromUrl) text = fromUrl[1];

  // Кавычки и обратные апострофы по краям — след копирования из JSON или из кода.
  text = text.replace(/^["'`]+|["'`]+$/g, '').trim();

  if (/^oauth\s+/i.test(text)) text = text.replace(/^oauth\s+/i, '');

  // Любые пробельные символы внутри, включая переносы строк.
  return text.replace(/\s+/g, '');
}

/**
 * Что не так с вставленной строкой, если это видно ещё до запроса. `null` — ничего не
 * видно, надо спрашивать у Яндекса.
 *
 * Проверка нужна не вместо запроса, а перед ним, и ровно по одной причине: сеть на такие
 * строки отвечает 403 без тела, то есть кодом «запрос не опознан как клиент». Текст отказа
 * тогда честно говорит про периметр и VPN — и уводит от настоящей причины, которая всё это
 * время лежала в буфере обмена. Отсекаем только то, что заведомо не может быть токеном:
 * сомнительное (например, отсутствие префикса `y0_` — у старых токенов его и нет) отправляем
 * в сеть, пусть решает Яндекс.
 */
export function describeYandexTokenShape(token: string): string | null {
  if (!token) return 'Токен пустой. Скопируйте строку из расширения yandex-music-token.';

  const alien = token.replace(/[A-Za-z0-9_.-]/g, '');
  if (alien) {
    return (
      `В токене есть посторонние символы (${[...new Set(alien)].slice(0, 6).join(' ')}). ` +
      'Похоже, вставился не токен, а JSON, cookie или строка из кода — нужна только сама ' +
      'строка токена.'
    );
  }

  // Порог заведомо ниже любого настоящего токена (те начинаются от полусотни символов), так
  // что ложных отказов он не даёт, а обрезанную при копировании строку ловит.
  if (token.length < 30) {
    return (
      `Токен слишком короткий (${token.length} символов) — скорее всего скопировался не ` +
      'целиком. Возьмите строку заново, полностью.'
    );
  }

  return null;
}

/**
 * Идентификатор клиента. Ровно то значение, которое зашито в `yandex-music` (крейт, на
 * котором работает noverplay — эталон, с которого портирован модуль):
 *
 *     pub const DEFAULT_CLIENT_ID: &str = "YandexMusicAndroid/24023621";
 *
 * Это не косметика: API сверяет строку со своим списком. Без неё `api.music.yandex.net`
 * отвечает 403 и телом `{"error":{"name":"session-expired","message":"Session expired"}}` —
 * с любым токеном, включая выданный минуту назад. Дальше это поднималось наверх как «токен
 * истёк», человек шёл за новым токеном, получал тот же 403 — и так по кругу.
 */
const CLIENT_ID = 'YandexMusicAndroid/24023621';

/**
 * `User-Agent`, которым представляется питоновская `yandex-music` — самая массово
 * используемая обвязка к этому API. Нужен только как один из вариантов, см. `HeaderProfile`.
 */
const LIBRARY_UA = 'Yandex-Music-API';

/**
 * `User-Agent` официального клиента. У Android-приложения Яндекс Музыки он совпадает со
 * строкой клиента — то же `YandexMusicAndroid/<версия>`, что и в `X-Yandex-Music-Client`.
 */
const ANDROID_UA = CLIENT_ID;

/** Обычный десктопный браузер. Нужен для набора `browser`, разбор ниже. */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36';

/**
 * Описание устройства. Официальный Android-клиент присылает его всегда, и это не
 * формальность: набор «клиент Android + никакого устройства» внутренне противоречив, а
 * именно на такие несоответствия и смотрит защита периметра. Значения фиксированные — им
 * важна стабильность, а не правдоподобие конкретной модели.
 */
const DEVICE_INFO =
  'os=Android; os_version=13; manufacturer=Xiaomi; model=Redmi Note 8 Pro; ' +
  'clid=; device_id=lomifynext0000001; uuid=lomifynext0000002';

/**
 * Наборы заголовков, которые перебирает `ymFetch`. Их три, и каждый отвечает за свой
 * сценарий отказа — гадать, какой примут, смысла нет, поэтому пробуем по порядку.
 *
 *   `android` — как официальный клиент: `Authorization`, `X-Yandex-Music-Client`,
 *               совпадающий с ним `User-Agent` и описание устройства. Первый, потому что
 *               это единственный внутренне непротиворечивый набор.
 *   `browser` — тот же токен и та же строка клиента, но `User-Agent` обычного Chrome.
 *               Нужен ровно для того случая, который мы и наблюдаем: 403 БЕЗ JSON-конверта
 *               `{"error":{...}}`. Так отвечает не API, а периметр перед ним, и отсекает он
 *               по `User-Agent` — API до такого запроса вообще не доходит, поэтому и
 *               описания ошибки в ответе нет.
 *   `library` — `User-Agent: Yandex-Music-API` питоновской обвязки. Массово используемая
 *               строка, и ровно поэтому её отсекают первой; оставлена последней, потому что
 *               на части методов она исторически работает.
 *
 * Раньше здесь было два набора, и первый из них не ставил `User-Agent` ВООБЩЕ (так делает
 * крейт `yandex-music`: `reqwest` своего значения по умолчанию не подставляет). Запрос без
 * `User-Agent` периметр Яндекса не пропускает — это и был первый из двух отказов, а второй
 * приходил на библиотечную строку. Отсюда «Яндекс Музыка ответила HTTP 403» на исправном
 * токене: оба набора отваливались до API.
 *
 * Сработавший набор запоминается на сессию — как и `workingRoute` ниже.
 */
type HeaderProfile = 'android' | 'browser' | 'library';

const PROFILE_ORDER: HeaderProfile[] = ['android', 'browser', 'library'];

/** Какой набор заголовков API принял в этой сессии. */
let workingProfile: HeaderProfile | null = null;

/** Набор, которым ушёл последний запрос. Нужен только для диагностики в консоли. */
let lastProfile: HeaderProfile | null = null;

function authHeaders(token: string, profile: HeaderProfile): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `OAuth ${token}`,
    'X-Yandex-Music-Client': CLIENT_ID,
    Accept: '*/*',
    'Accept-Language': 'ru',
  };
  if (profile === 'android') {
    headers['User-Agent'] = ANDROID_UA;
    headers['X-Yandex-Music-Device'] = DEVICE_INFO;
  } else if (profile === 'browser') {
    headers['User-Agent'] = BROWSER_UA;
  } else {
    headers['User-Agent'] = LIBRARY_UA;
  }
  return headers;
}

/**
 * Запрос идёт только через Tauri-клиент, и это не предпочтение, а требование.
 * `User-Agent` входит в список forbidden header names: конструктор `Request` в браузере
 * молча выбрасывает его из набора заголовков, без ошибки и без предупреждения. То есть
 * через `window.fetch` заголовок клиента до Яндекса не доедет НИКОГДА, и любой токен там
 * получит тот самый 403 `session-expired`. Плагин `plugin-http` собирает список заголовков
 * из самостоятельного `new Headers(...)` (guard «none») и передаёт его в Rust как есть,
 * поэтому в приложении заголовок уходит целиком.
 *
 * Раньше здесь стоял `window.fetch` как «чтобы модуль не падал в браузерном vite dev». Он и
 * не падал — он честно ходил в сеть и получал отказ, который интерфейс показывал как
 * «токен истёк». Лучше сказать правду про окружение, чем солгать про токен.
 */
/**
 * Похожа ли ошибка отправки на мёртвый системный прокси.
 *
 * Ошибка приходит из `reqwest` через `plugin-http` строкой, поэтому смотрим на текст. Признак
 * туннеля или упоминание прокси — достаточное основание; коды Windows (10061 «отвергнуто»,
 * 10060 «таймаут») берём в расчёт только вместе со стадией установки соединения, иначе под
 * обход прокси попал бы и просто недоступный сервер. Тот же разбор в Rust —
 * `src-tauri/src/shared/net.rs`, и держать их согласованными приходится руками: одно и то же
 * решение принимается по обе стороны границы (аудио грузит Rust, API — фронт).
 */
function looksLikeProxyFailure(message: string): boolean {
  const msg = message.toLowerCase();
  if (msg.includes('tunnel') || msg.includes('proxy')) return true;
  const connectStage = msg.includes('error trying to connect') || msg.includes('connect error');
  return (
    connectStage &&
    (msg.includes('os error 10061') ||
      msg.includes('os error 10060') ||
      msg.includes('os error 10065'))
  );
}

/**
 * Каким путём ушёл запрос.
 *
 *   `plugin` — `plugin-http`, то есть `reqwest` с настройками прокси из системы.
 *   `direct` — команда `net_fetch_direct`, тот же запрос с `.no_proxy()`.
 *
 * Второй путь появился по разбору отказа, который выглядел как проблема с токеном. В Windows
 * галка «использовать прокси-сервер» остаётся включённой после того, как VPN выключен, и
 * `plugin-http` честно уходит в мёртвый CONNECT-туннель: в логе приложения это
 * `tunnel error … os error 10061`, а до Музыки запрос не доходит вовсе. Тот же адрес с тем же
 * токеном напрямую отвечает нормально — значит лечится это не новым токеном, а обходом прокси.
 */
type Transport = 'plugin' | 'direct';

/** Минимум от `Response`, которым пользуется модуль: два транспорта дают разные объекты. */
interface YmResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** Путь, которым в этой сессии удалось дойти до API. Как и `workingProfile`, помнится. */
let workingTransport: Transport = 'plugin';

/** Путь последнего запроса — нужен диагностике: он решает, что писать про прокси. */
let lastTransport: Transport = 'plugin';

async function sendVia(
  transport: Transport,
  url: string,
  headers: Record<string, string>,
  init: Record<string, any>
): Promise<YmResponse> {
  lastTransport = transport;

  if (transport === 'plugin') {
    return (await tauriFetch(url, { ...init, headers } as any)) as YmResponse;
  }

  const { invoke } = await import('@tauri-apps/api/core');
  // Команда ходит только к хостам Яндекса — см. src-tauri/src/network/direct_fetch.rs.
  // Токен уходит в собственный бэкенд приложения, а не на сторонний прокси.
  // Метод и тело передаём явно: без них POST-отметки «Моей волны» ушли бы этим путём как
  // GET — молча, потому что команда раньше умела только GET и лишние поля игнорировала.
  const res = await invoke<{ status: number; body: string }>('net_fetch_direct', {
    args: {
      url,
      headers,
      method: typeof init.method === 'string' ? init.method : 'GET',
      body: typeof init.body === 'string' ? init.body : null,
    },
  });
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    text: async () => res.body,
  };
}

async function ymFetch(
  url: string,
  token: string,
  init: Record<string, any> = {}
): Promise<YmResponse> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    throw new Error(
      'Яндекс Музыка доступна только в приложении: браузер не даёт выставить заголовки ' +
        'клиента, без которых API отклоняет любой токен.'
    );
  }

  // Сработавший набор — первым, остальные в порядке по умолчанию и без повторов.
  const order: HeaderProfile[] = workingProfile
    ? [workingProfile, ...PROFILE_ORDER.filter((p) => p !== workingProfile)]
    : PROFILE_ORDER;

  let last: YmResponse | null = null;
  // Обход прокси пробуем один раз на вызов, а не на каждый набор заголовков: три лишних
  // запроса ничего не выяснят — путь либо работает, либо нет, от `User-Agent` это не зависит.
  let triedDirect = workingTransport === 'direct';

  for (const profile of order) {
    const headers = { ...authHeaders(token, profile), ...(init.headers ?? {}) };
    let res: YmResponse;

    try {
      res = await sendVia(workingTransport, url, headers, init);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Запрос не удалось даже отправить. Если похоже на мёртвый прокси — идём в обход;
      // иначе это настоящая сетевая проблема, и молчать о ней нельзя.
      if (!triedDirect && looksLikeProxyFailure(message)) {
        triedDirect = true;
        console.warn('[yandex] системный прокси не отвечает, пробую напрямую', message);
        res = await sendVia('direct', url, headers, init);
        if (res.ok) workingTransport = 'direct';
      } else {
        throw e;
      }
    }

    lastProfile = profile;

    if (res.ok) {
      workingProfile = profile;
      return res;
    }

    // 403 без разбора мог прийти и от периметра, который видит не наш адрес, а прокси.
    // Проверяем это ровно одним запросом в обход — и, если он проходит, остаёмся на нём.
    if (res.status === 403 && !triedDirect) {
      triedDirect = true;
      const direct = await sendVia('direct', url, headers, init).catch((e) => {
        console.warn('[yandex] прямой запрос тоже не прошёл', e);
        return null;
      });
      if (direct?.ok) {
        workingTransport = 'direct';
        workingProfile = profile;
        return direct;
      }
      // Ответ прямого пути информативнее: по нему видно, что прокси тут не при чём.
      if (direct) res = direct;
      else lastTransport = 'plugin';
    }

    // Следующий набор пробуем только на 403: это единственный код, которым отвечают
    // «запрос не опознан как клиент» — и API (`session-expired`), и периметр перед ним.
    // 401 — про токен, 404/429/5xx — про метод и лимиты, и повторять их с другим
    // `User-Agent` бессмысленно (и вредно: лишний запрос в лимит).
    // Тело не читаем — иначе на выходе окажется уже вычитанный `Response`.
    if (res.status !== 403) return res;
    last = res;
  }
  return last!;
}

/**
 * На что похоже тело ответа. Нужно ровно для одного различения, но принципиального: API
 * Яндекс Музыки всегда отвечает JSON-конвертом, в том числе на ошибках. Если конверта нет,
 * значит отвечал не API, а что-то перед ним, и причину надо искать не в токене.
 */
function bodyShape(raw: string): string {
  const text = raw.trim();
  if (!text) return 'тело ответа пустое';
  if (/captcha/i.test(text)) return 'в ответе страница с капчей';
  if (/^<(!doctype|html)/i.test(text)) return 'в ответе HTML-страница, а не JSON';
  return `в ответе не JSON: ${text.slice(0, 60)}`;
}

/**
 * Текст ошибки по ответу API. Разделение здесь принципиально: «токен истёк» — сильное
 * утверждение, после которого человек идёт добывать новый токен. Говорить это можно только
 * когда про токен сказал сам Яндекс, а не когда мы угадали по коду ответа.
 *
 * Прежняя версия сваливала 401 и 403 в одну ветку с текстом «скорее всего истёк». 403 у
 * этого API означает совсем другое — запрос не опознан как клиент Яндекс Музыки, — и
 * получался замкнутый круг: свежий токен объявлялся истёкшим, новый токен давал тот же 403.
 */
function describeYmError(status: number, name: string, message: string, raw = ''): string {
  const code = name.toLowerCase();

  if (status === 401 || code.includes('invalid-oauth-token') || code.includes('not-authorized')) {
    return 'Яндекс Музыка не приняла токен: он недействителен или отозван. Получите токен заново и вставьте снова.';
  }
  if (code.includes('session-expired')) {
    // Имя ошибки врёт про срок: истекла не сессия токена, а доверие к клиенту.
    return 'Яндекс Музыка не опознала запрос как свой клиент (session-expired). К сроку токена это отношения не имеет — менять его не нужно.';
  }
  if (status === 429) {
    return 'Яндекс Музыка ограничила частоту запросов, попробуйте через минуту.';
  }
  // 403 без JSON-конверта — это отказ ДО API, и различить его важно: раньше здесь
  // печаталось просто «ответила HTTP 403», из чего следовал единственный доступный вывод
  // «дело в токене» — и человек шёл менять исправный токен по кругу.
  if (status === 403 && !name && !message) {
    // К этому моменту прямой запрос (в обход системного прокси) уже пробовался — см.
    // `ymFetch`. Поэтому про прокси говорим не догадкой, а по факту: если отказ пришёл и
    // напрямую, версия с прокси и VPN закрыта, и остаётся адрес либо права токена.
    const route =
      lastTransport === 'direct'
        ? 'Запрос уходил напрямую, минуя системный прокси, — дело не в прокси и не в VPN. ' +
          'Остаются две причины: адрес, с которого идёт запрос, Яндексу не нравится, либо ' +
          'токен выдан приложению без доступа к Музыке — возьмите токен расширением ' +
          'yandex-music-token.'
        : 'Обычные причины: адрес, с которого идёт запрос (VPN или сервер), либо токен ' +
          'выдан приложению без доступа к Музыке. Попробуйте выключить VPN и взять токен ' +
          'расширением yandex-music-token.';
    return (
      `Яндекс отклонил запрос до самой Музыки (HTTP 403, ${bodyShape(raw)}). ` +
      `Токен здесь ни при чём — до его проверки дело не дошло. ${route}`
    );
  }
  if (message || name) return message || name;
  // Кода ответа в тексте нет только у ошибки при HTTP 200 — там он ничего не объясняет.
  return status === 200
    ? 'Яндекс Музыка вернула ошибку без описания'
    : `Яндекс Музыка ответила HTTP ${status}`;
}

/**
 * Все ответы API завёрнуты в `{ invocationInfo, result }`, а ошибки — в `{ error }`, причём
 * `error` бывает и строкой, и объектом `{ name, message }`. Разворачиваем в одном месте,
 * чтобы выше по стеку иметь либо данные, либо человеческий текст ошибки.
 */
async function ymJson(url: string, token: string, init?: Record<string, any>): Promise<any> {
  const res = await ymFetch(url, token, init);
  const raw = await res.text();

  let body: any = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    // Не JSON — значит либо капча, либо страница-заглушка. Текст в ошибку не тащим.
  }

  if (!res.ok) {
    const err = body?.error;
    const name = typeof err === 'string' ? err : err?.name ?? '';
    const message = typeof err === 'string' ? err : err?.message ?? '';
    // В консоль — то, чего нет в тексте уведомления и без чего причину не найти: какой
    // метод, каким набором заголовков и что именно ответил Яндекс. Сам токен не пишем
    // никогда, только его длину: по ней видно обрезанную при копировании строку, а
    // воспользоваться ею нельзя.
    console.warn('[yandex] отказ', {
      url,
      status: res.status,
      profile: lastProfile,
      transport: lastTransport,
      tokenLength: token.length,
      body: raw.slice(0, 300),
    });
    throw new Error(describeYmError(res.status, name, message, raw));
  }

  if (body?.error) {
    // Ошибка при HTTP 200 бывает у отдельных методов. Код статуса тут неинформативен,
    // поэтому передаём 200 и разбираемся по имени ошибки.
    const err = body.error;
    const name = typeof err === 'string' ? err : err?.name ?? '';
    const message = typeof err === 'string' ? err : err?.message ?? '';
    throw new Error(describeYmError(200, name, message));
  }

  return body?.result ?? null;
}

/**
 * Порт `cover_url` из mapping.rs: `%%` в шаблоне — место под размер, схемы в ответе нет.
 * Размер 400×400 вместо тысячного из noverplay: у нас обложка живёт в плитке ~200px, а
 * тысячная картинка на полке из шести десятков плиток — это лишние мегабайты трафика.
 */
function ymCover(uri: string | null | undefined, size = '400x400'): string {
  const raw = (uri ?? '').trim();
  if (!raw) return '';
  const sized = raw.replace('%%', size);
  return sized.startsWith('http') ? sized : `https://${sized}`;
}

/**
 * Порт `normalizovat_track`. Возвращает трек в том же виде, что `searchSoundCloud` — иначе
 * плеер, полки, лайки и кэш пришлось бы учить второму формату. `null` — карточка, которой
 * в списке быть не должно (реклама, пустышка без id).
 */
export function mapYandexTrack(raw: any): any | null {
  if (!raw) return null;
  // В плейлистах и лайках трек приходит завёрнутым: `{ id, track: {...} }`.
  const t = raw.track ?? raw;
  const id = t.id ?? t.realId ?? t.trackId;
  if (id === undefined || id === null || `${id}`.trim() === '') return null;

  const artists: string[] = Array.isArray(t.artists)
    ? t.artists.map((a: any) => (a?.name ?? '').trim()).filter(Boolean)
    : [];
  const album = Array.isArray(t.albums) && t.albums.length > 0 ? t.albums[0] : null;
  const artistGenres = (Array.isArray(t.artists) ? t.artists : [])
    .flatMap((artist: any) => [
      artist?.genre,
      ...(Array.isArray(artist?.genres) ? artist.genres : [])
    ])
    .map((genre: any) => `${genre ?? ''}`.trim())
    .filter(Boolean);
  const albumGenres = (Array.isArray(t.albums) ? t.albums : [])
    .flatMap((item: any) => [
      item?.genre,
      ...(Array.isArray(item?.genres) ? item.genres : [])
    ])
    .map((genre: any) => `${genre ?? ''}`.trim())
    .filter(Boolean);
  const genres = Array.from(new Set([...albumGenres, ...artistGenres]));

  const baseTitle = (t.title ?? '').trim() || 'Без названия';
  const title = t.version ? `${baseTitle} (${t.version})` : baseTitle;

  return {
    id: `${id}`,
    title,
    artist: artists.join(', ') || 'Неизвестный исполнитель',
    // Тот же список отдельно, а не только склеенной строкой. Нужен для сверки «этот трек
    // этого артиста?»: у трека вдвоём поле `artist` выглядит как «А, Б», и сравнение с
    // именем «А» по равенству строк не проходит — из-за этого на странице артиста
    // отваливались все совместные вещи, а их у иных половина дискографии.
    artists,
    coverUrl: ymCover(t.coverUri || t.ogImage || album?.coverUri),
    artistAvatarUrl: ymCover(t.artists?.[0]?.cover?.uri, '200x200'),
    permalinkUrl: album?.id
      ? `https://music.yandex.ru/album/${album.id}/track/${id}`
      : `https://music.yandex.ru/track/${id}`,
    genre: album?.genre ?? artistGenres[0] ?? '',
    // Один и тот же трек может быть в сингле, альбоме и сборнике с разными жанровыми
    // метками. Фильтр волны учитывает их все, а `genre` оставляем для старых потребителей.
    genres,
    // Rotor и поиск отдают один и тот же `lyricsInfo`. Храним сам факт наличия текста,
    // чтобы фильтр волны не делал отдельный сетевой запрос для каждого кандидата.
    lyricsAvailable: Boolean(
      t.lyricsInfo?.hasAvailableSyncLyrics ||
      t.lyricsInfo?.hasAvailableTextLyrics ||
      t.lyricsInfo?.hasAvailableLyrics ||
      t.hasLyrics
    ),
    // `null`, а не ноль. Счётчиков прослушиваний и лайков по трекам API Музыки не отдаёт
    // вовсе, а ноль — это утверждение «трек не слушали ни разу», и интерфейс честно его
    // печатал: «Прослушиваний SC: 0» на треке из Яндекса. Интерфейс проверяет `!= null` и с
    // `null` просто не показывает строку — а сколько слушают артиста, видно в шапке его
    // страницы (`yandexArtistProfile`, «слушателей за месяц»).
    playbackCount: null,
    likesCount: null,
    releaseDate: album?.releaseDate || (album?.year ? `${album.year}-01-01` : ''),
    duration: Number(t.durationMs) || 0,
    // Ссылка на поток живёт минуты и подписана — держать её в объекте трека бессмысленно.
    // Её берёт `getAudioUrl` в момент запуска (см. api.ts).
    audioUrl: null,
    transcodings: [],
    source: 'yandex',
    isBanned: t.available === false,
  };
}

export interface YandexAccount {
  uid: number;
  login: string;
  displayName: string;
  hasPlus: boolean;
}

/**
 * Проверка токена и одновременно «кто вошёл». Другого способа убедиться, что строка
 * действительно рабочая, нет — так же поступает `ym_import_start` в Rust, беря отсюда uid.
 */
export async function yandexAccountStatus(rawToken: string): Promise<YandexAccount> {
  const token = normalizeYandexToken(rawToken);
  // Заведомо испорченную строку в сеть не отправляем: на неё приходит 403 без тела, и текст
  // отказа увёл бы к периметру и VPN вместо буфера обмена (разбор у `describeYandexTokenShape`).
  const problem = describeYandexTokenShape(token);
  if (problem) throw new Error(problem);

  const result = await ymJson(`${API}/account/status`, token);
  const account = result?.account ?? {};
  return {
    uid: Number(account.uid) || 0,
    login: account.login ?? '',
    displayName: account.displayName || account.fullName || account.login || 'Яндекс Музыка',
    hasPlus: Boolean(result?.plus?.hasPlus),
  };
}

/**
 * Аватар аккаунта Яндекса — ссылка на картинку или пустая строка.
 *
 * Музыкальный API аватар не отдаёт вообще: в `/account/status` есть имя, логин и признак
 * Плюса, а картинки нет ни в одном поле. Аватар живёт в Паспорте, и узнать его
 * идентификатор можно только методом `login.yandex.ru/info` — тем же, которым пользуются
 * все клиенты Яндекса. Дальше идентификатор подставляется в адрес раздачи `get-yapic`.
 *
 * Отказ здесь — не ошибка и наверх не поднимается. Методу нужно право `login:info`, а
 * токен из расширения `yandex-music-token` выдан музыкальному клиенту, и этого права у
 * него может не быть. Человек в такой ситуации не сделал ничего неправильного и починить
 * ничего не может, поэтому вместо уведомления просто нет картинки — профиль покажет букву.
 *
 * Заголовки минимальные: набор музыкального клиента (`X-Yandex-Music-Client`, описание
 * устройства) Паспорту не нужен, а перебирать три `User-Agent` тут нечего — метод либо
 * разрешён токену, либо нет.
 */
export async function yandexAvatarUrl(rawToken: string): Promise<string> {
  const token = normalizeYandexToken(rawToken);
  if (!token || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return '';

  const headers: Record<string, string> = {
    Authorization: `OAuth ${token}`,
    Accept: 'application/json',
    'User-Agent': BROWSER_UA,
  };
  // Хост из списка разрешённых для `net_fetch_direct` (`.yandex.ru`), так что путь в обход
  // системного прокси доступен и здесь — а он нужен по той же причине, что и в `ymFetch`.
  const url = 'https://login.yandex.ru/info?format=json';

  let res: YmResponse;
  try {
    res = await sendVia(workingTransport, url, headers, {});
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (workingTransport === 'direct' || !looksLikeProxyFailure(message)) {
      console.warn('[yandex] аватар не получен', message);
      return '';
    }
    res = await sendVia('direct', url, headers, {}).catch(() => null as any);
    if (!res) return '';
  }

  if (!res.ok) {
    // Ни `status`, ни тело в интерфейс не идут — только в консоль: см. разбор выше.
    console.warn('[yandex] Паспорт не отдал профиль', { status: res.status });
    return '';
  }

  try {
    const body = JSON.parse(await res.text());
    // `is_avatar_empty` — это «аватара нет», а не «не смогли узнать». В таком случае
    // `default_avatar_id` всё равно приходит и ведёт на серую заглушку Яндекса; своя буква
    // на цветной подложке лучше чужой заглушки.
    if (body?.is_avatar_empty) return '';
    const id = `${body?.default_avatar_id ?? ''}`.trim();
    // `islands-200` — самый крупный из непрозрачных размеров раздачи. В шапке профиля
    // аватар около 112px, но на экране с плотностью 2 меньший размер заметно мылит.
    return id ? `https://avatars.yandex.net/get-yapic/${id}/islands-200` : '';
  } catch (e) {
    console.warn('[yandex] профиль Паспорта не разобрался', e);
    return '';
  }
}

/**
 * Порт search.rs. `page` — с какой страницы выдачи начинать: пагинация у API постраничная,
 * не курсорная.
 *
 * Страница выдачи у Музыки — около двадцати треков, поэтому `limit = 50` одним запросом
 * недостижим: раньше функция брала ровно `page` и молча отдавала двадцать, сколько бы ни
 * попросили. Первую страницу ждём, чтобы узнать `total` и размер страницы, остальные тянем
 * разом — иначе поиск стоил бы трёх последовательных обращений вместо двух.
 */
export async function searchYandex(rawToken: string, query: string, limit = 50, page = 0) {
  const token = normalizeYandexToken(rawToken);
  const text = query.trim();
  if (!token || !text) return [];

  const ask = (p: number) =>
    ymJson(`${API}/search?text=${encodeURIComponent(text)}&type=track&page=${p}&nocorrect=false`, token);

  const first = await ask(page);
  const found: any[] = first?.tracks?.results ?? [];
  if (found.length === 0) return [];

  const perPage = Number(first?.tracks?.perPage) || found.length;
  const total = Number(first?.tracks?.total);
  // Сколько страниц ещё имеет смысл спрашивать: не больше, чем осталось до `limit`, и не
  // больше, чем есть в выдаче. Верхний предел в четыре страницы — от опечатки в `limit`.
  const want = Math.min(Math.ceil(limit / perPage), 4);
  const have = Number.isFinite(total) ? Math.ceil(total / perPage) : want;
  const extra: number[] = [];
  for (let p = page + 1; p < page + want && p < page + have; p++) extra.push(p);

  if (extra.length > 0) {
    const rest = await Promise.all(
      // Отказ по одной странице не должен ронять всю выдачу: что пришло, то и показываем.
      extra.map((p) => ask(p).catch(() => null))
    );
    for (const r of rest) found.push(...((r as any)?.tracks?.results ?? []));
  }

  return found.map(mapYandexTrack).filter(Boolean).slice(0, limit);
}

/** Порт related.rs — на нём держится автоплей, когда очередь закончилась. */
export async function getYandexSimilar(rawToken: string, trackId: string | number, limit = 15) {
  const token = normalizeYandexToken(rawToken);
  if (!token || !trackId) return [];
  const result = await ymJson(`${API}/tracks/${trackId}/similar`, token);
  const similar = result?.similarTracks ?? [];
  return similar.map(mapYandexTrack).filter(Boolean).slice(0, limit);
}

/* ── Текст из Яндекс Музыки ───────────────────────────────────────────────────
   Современный метод отдаёт не сам текст, а подписанную ссылку на LRC/TEXT. Подпись совпадает
   с официальным Android-клиентом и формируется локально; OAuth-токен на файловую раздачу не
   уходит. Если новый метод недоступен для конкретного трека, старый `supplement` остаётся
   запасным источником простого текста. */

const YANDEX_LYRICS_SIGN_KEY = 'p93jhgh689SBReK6ghtw62';

async function yandexLyricsSign(trackId: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(YANDEX_LYRICS_SIGN_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${trackId}${timestamp}`)
  );
  let binary = '';
  for (const byte of new Uint8Array(signed)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function fetchYandexLyricsAsset(url: string): Promise<string | null> {
  const headers = { Accept: 'text/plain, application/octet-stream;q=0.9, */*;q=0.8' };
  let res: YmResponse;
  try {
    res = await sendVia(workingTransport, url, headers, {});
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (workingTransport === 'direct' || !looksLikeProxyFailure(message)) throw e;
    res = await sendVia('direct', url, headers, {});
  }
  if (!res.ok) return null;
  const text = (await res.text()).replace(/^\uFEFF/, '').trim();
  return text || null;
}

/** Получить LRC (предпочтительно) или простой текст непосредственно из Яндекс Музыки. */
export async function getYandexLyrics(
  rawToken: string,
  rawTrackId: string | number
): Promise<string | null> {
  const token = normalizeYandexToken(rawToken);
  const trackId = `${rawTrackId ?? ''}`.split(':')[0].trim();
  if (!token || !/^\d+$/.test(trackId)) return null;

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const sign = await yandexLyricsSign(trackId, timestamp);

    for (const format of ['LRC', 'TEXT'] as const) {
      const params = new URLSearchParams({
        format,
        timeStamp: `${timestamp}`,
        sign,
      });
      try {
        const info = await ymJson(`${API}/tracks/${trackId}/lyrics?${params}`, token);
        const downloadUrl = `${info?.downloadUrl ?? info?.download_url ?? ''}`.trim();
        if (!downloadUrl) continue;
        const text = await fetchYandexLyricsAsset(downloadUrl);
        if (text) return text;
      } catch {
        // У трека может быть только один из форматов; второй пробуем без уведомления.
      }
    }

    const supplement = await ymJson(`${API}/tracks/${trackId}/supplement`, token).catch(() => null);
    const legacy = `${
      supplement?.lyrics?.fullLyrics ??
      supplement?.lyrics?.full_lyrics ??
      supplement?.lyrics?.lyrics ??
      ''
    }`.trim();
    return legacy || null;
  } catch (e) {
    console.warn('[yandex] текст трека не получен', e);
    return null;
  }
}

/* ── «Моя волна» ──────────────────────────────────────────────────────────────
   Станция — не плейлист и не выдача поиска: у неё нет конца и нет содержимого,
   которое можно было бы «загрузить». Есть только порции по несколько треков
   (`/rotor/station/{station}/tracks`) и отметки о том, что со треками происходит
   (`feedback`). Порция выдаётся с `batchId`, и отметку надо присылать с тем же
   `batchId`, в котором трек приехал, — иначе станция не понимает, о чём речь.

   Отметки — не телеметрия и не «на всякий случай»: именно из них волна и состоит.
   Пропущенный трек (`skip`) станция учитывает сразу и следующую порцию собирает
   иначе, дослушанный (`trackFinished`) — наоборот. Без отметок остаётся просто
   бесконечная лента похожей музыки, которая ни на что не реагирует, и разница
   между ней и «Моей волной» в приложении Яндекса именно в этом.

   В noverplay этого нет вовсе — там радио не портировали, так что здесь порт не с
   чего делать; методы взяты из того же публичного API, что и всё остальное в
   модуле, и совпадают с тем, что зовут официальные клиенты. */

/** Идентификатор станции «Моя волна». Персональная, привязана к аккаунту токена. */
export const WAVE_STATION = 'user:onyourwave';

/**
 * Откуда включили — станция пишет это себе в статистику. Значение взято у веб-клиента,
 * своё («lomifynext-…») здесь ставить не стоит: строка попадает в чужую аналитику как
 * идентификатор клиента, а не как свободный текст, и незнакомую станция вправе отклонить.
 */
const WAVE_FROM = 'radio-web-user_onyourwave-default';

export type YandexWaveEvent = 'radioStarted' | 'trackStarted' | 'trackFinished' | 'skip';

export interface YandexWaveBatch {
  /** Идентификатор порции. Уходит обратно в отметках о треках из неё. */
  batchId: string;
  tracks: any[];
}

/**
 * Очередная порция «Моей волны».
 *
 * `prevTrackId` — трек, после которого продолжаем: без него станция начинает сначала и
 * присылает то же, что в первый раз. Именно так волна и получается бесконечной — новая
 * порция запрашивается по хвосту предыдущей.
 *
 * `settings2=true` — не украшение: без него станция отвечает по старой схеме, в которой у
 * порции нет `batchId`, и отметки становится некуда привязывать.
 */
export async function yandexWaveBatch(
  rawToken: string,
  prevTrackId?: string | number | null
): Promise<YandexWaveBatch> {
  const token = normalizeYandexToken(rawToken);
  if (!token) throw new Error('Яндекс Музыка не подключена — вставьте токен в настройках.');

  const params = new URLSearchParams({ settings2: 'true' });
  const tail = `${prevTrackId ?? ''}`.trim();
  if (tail) params.set('queue', tail);

  const result = await ymJson(`${API}/rotor/station/${WAVE_STATION}/tracks?${params}`, token);

  // Порция приходит как `sequence: [{ type, track, liked }]`; `mapYandexTrack` умеет
  // разворачивать такую обёртку сам (в лайках и плейлистах она такая же).
  const sequence: any[] = Array.isArray(result?.sequence) ? result.sequence : [];
  const tracks = sequence
    .map(mapYandexTrack)
    .filter(Boolean)
    // Недоступный трек в волне — редкость, но включать его нечем: поток по нему не выдадут,
    // и плеер показал бы отказ вместо музыки.
    .filter((t: any) => !t.isBanned);

  return { batchId: `${result?.batchId ?? ''}`.trim(), tracks };
}

/**
 * Отметка о том, что случилось с треком волны.
 *
 * Никогда не бросает и ничего не возвращает: это сообщение станции, а не запрос данных.
 * Сорвавшаяся отметка означает лишь, что волна на один трек хуже подстроится, и превращать
 * её в ошибку посреди воспроизведения нельзя — музыка при этом играет как ни в чём не бывало.
 */
export async function yandexWaveFeedback(
  rawToken: string,
  event: YandexWaveEvent,
  opts: { batchId?: string; trackId?: string | number; playedSeconds?: number } = {}
): Promise<void> {
  const token = normalizeYandexToken(rawToken);
  if (!token) return;

  const body: Record<string, any> = { type: event, timestamp: new Date().toISOString() };
  if (event === 'radioStarted') body.from = WAVE_FROM;
  const trackId = `${opts.trackId ?? ''}`.trim();
  if (trackId) body.trackId = trackId;
  if (opts.playedSeconds != null && Number.isFinite(opts.playedSeconds)) {
    body.totalPlayedSeconds = Math.max(0, Math.round(opts.playedSeconds));
  }

  // Идентификатор порции — в строке запроса и именно через дефис (`batch-id`), тело здесь
  // ни при чём. Это не наша прихоть, а форма метода.
  const query = opts.batchId ? `?batch-id=${encodeURIComponent(opts.batchId)}` : '';

  try {
    await ymJson(`${API}/rotor/station/${WAVE_STATION}/feedback${query}`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn('[yandex] станция не приняла отметку', event, e);
  }
}

/** Имя артиста как ключ сравнения: регистр и знаки между сервисами не совпадают. */
function artistKey(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * Артист в Яндекс Музыке: фото, шапка и «слушателей за месяц».
 *
 * Зачем вообще: страница артиста до сих пор брала всё из SoundCloud, поэтому у человека с
 * выбранным Яндексом в шапке стояли подписчики чужого сервиса, а строка «Прослушиваний SC»
 * у каждого трека показывала ноль — Музыка счётчиков прослушиваний по трекам не отдаёт
 * вовсе, и ноль был не данными, а заглушкой (см. `mapYandexTrack`).
 *
 * Что Музыка отдаёт на самом деле — статистику по АРТИСТУ: `stats.lastMonthListeners`, то
 * самое число «слушателей за месяц», которое показывает и веб-клиент. Это и есть честный
 * ответ на «показывай прослушивания из Яндекса»: по трекам таких данных нет ни у кого.
 *
 * Два запроса, потому что иначе никак: поиск даёт id артиста, но ни статистики, ни описания
 * в выдаче нет — они живут только в `brief-info`. Провал второго запроса не отменяет
 * первого: имя и id уже известны, страница просто останется без числа.
 *
 * Фото и шапка — только при точном совпадении имени, как и у SoundCloud
 * (см. `getArtistProfile` в api.ts): поиск по имени легко приводит к однофамильцу, и чужое
 * лицо в шапке — заметная и стыдная ошибка, в отличие от отсутствующей картинки.
 */
export interface YandexArtistProfile {
  id: string;
  username: string;
  avatarUrl: string;
  bannerUrl: string;
  followersCount: number;
  listenersCount: number;
  /**
   * Сколько людей добавили артиста в избранное (`artist.likesCount`).
   *
   * Прослушиваний по треку Музыка не отдаёт нигде: проверено и `/tracks/{id}`, и
   * `/tracks/{id}/supplement` — счётчиков в ответе нет вовсе. Числа слушателей по конкретному
   * треку есть только внутри чарта (`/landing3/chart/russia` → `chart.listeners`), то есть у
   * сотни песен из ста. Так что по артисту всё, что вообще существует, — слушатели за месяц и
   * это поле.
   */
  likesCount: number;
  description: string;
  city: string;
  country: string;
  permalink: string;
  verified: boolean;
  isExactMatch: boolean;
  source: 'yandex';
  /**
   * Сколько всего у артиста треков и релизов — по данным самой Музыки (`artist.counts`), а не
   * по длине того списка, который удалось загрузить. Разница важна: пока страница знала об
   * артисте только по выдаче поиска, в шапке стояло «6 треков» у человека с сотней.
   */
  trackCount: number;
  albumCount: number;
  /**
   * Десятка популярных из `brief-info`. Лежит в том же ответе, за который мы уже заплатили
   * запросом, поэтому список показывается сразу — не дожидаясь полной дискографии.
   */
  popularTracks: any[];
}


export async function yandexArtistProfile(
  rawToken: string,
  artistName: string
): Promise<YandexArtistProfile | null> {
  const token = normalizeYandexToken(rawToken);
  const name = (artistName ?? '').trim();
  if (!token || !name) return null;

  const search = await ymJson(
    `${API}/search?text=${encodeURIComponent(name)}&type=artist&page=0&nocorrect=false`,
    token
  );
  const candidates: any[] = search?.artists?.results ?? [];
  if (candidates.length === 0) return null;

  const wanted = artistKey(name);
  const exact = candidates.find((a: any) => artistKey(a?.name) === wanted);
  const hit = exact ?? candidates[0];
  const id = `${hit?.id ?? ''}`.trim();
  if (!id) return null;

  let brief: any = null;
  try {
    brief = await ymJson(`${API}/artists/${id}/brief-info`, token);
  } catch (e) {
    console.warn('[yandex] подробности об артисте не получены', e);
  }
  const artist = brief?.artist ?? hit;
  const counts = artist?.counts ?? {};

  return {
    id,
    username: artist?.name || name,
    avatarUrl: exact ? ymCover(artist?.cover?.uri, '400x400') : '',
    // `ogImage` — картинка страницы артиста, единственная широкая из всего, что отдаёт API.
    bannerUrl: exact ? ymCover(artist?.ogImage, '1000x1000') : '',
    // Подписчиков у артиста в Музыке нет: `likesCount` — это лайки, и выдавать их за
    // подписчиков значило бы поставить в шапку число не о том. Пусто.
    followersCount: 0,
    // Только `stats.lastMonthListeners`. Запасным путём здесь стояло `ratings.month` — это
    // ошибка: `ratings` не число слушателей, а МЕСТО в рейтинге Музыки. Проверено на трёх
    // артистах: у «Трёх дней дождя» 5 125 091 слушателей и `ratings.month = 69`, у «Валентина
    // Стрыкало» 20 820 слушателей и `ratings.month = 45 491`. То есть чем артист крупнее, тем
    // число МЕНЬШЕ, и в подписи «слушателей за месяц» оно превращалось в чистую выдумку.
    // Нет `stats` — нет и числа: пустая строка честнее подставленной.
    listenersCount: Number(brief?.stats?.lastMonthListeners) || 0,
    // Сколько людей держат артиста в избранном. Единственный счётчик «популярности» помимо
    // слушателей, который Музыка отдаёт по артисту, — и он не про прослушивания, поэтому
    // лежит отдельным полем со своей подписью, а не подмешивается к остальным.
    likesCount: Number(artist?.likesCount) || 0,
    description: `${artist?.description?.text ?? ''}`.trim(),
    city: '',
    country: '',
    permalink: `https://music.yandex.ru/artist/${id}`,
    verified: false,
    isExactMatch: Boolean(exact),
    source: 'yandex',
    trackCount: Number(counts?.tracks) || 0,
    albumCount: Number(counts?.directAlbums) || 0,
    popularTracks: ((brief?.popularTracks ?? []) as any[]).map(mapYandexTrack).filter(Boolean),
  };
}

/**
 * Вся дискография артиста, по сотне за запрос.
 *
 * Ради этого метода всё и затевалось. До него страница артиста показывала не треки артиста, а
 * выдачу поиска по его имени — одну страницу, около двадцати карточек, из которых половина
 * отваливалась на сверке имени. У «Трёх дней дождя» на экране оставалось шесть треков при 97
 * в каталоге; проверено запросом, `pager.total = 97`.
 *
 * Порядок ответа — по популярности: сверено с `/artists/{id}/track-ids-by-rating`, списки
 * совпадают до последнего id. Поэтому заголовок «Популярные треки» на странице остаётся
 * правдой, и отдельный запрос за рейтингом не нужен.
 *
 * `limit` — предохранитель, а не желаемое число: у иных артистов в каталоге тысячи позиций
 * (сборники, ремиксы, «музыка для сна»), и тянуть их все в память страницы незачем.
 */
export async function yandexArtistTracks(
  rawToken: string,
  artistId: string | number,
  limit = 300
): Promise<any[]> {
  const token = normalizeYandexToken(rawToken);
  if (!token || !artistId) return [];

  const PER_PAGE = 100;
  const out: any[] = [];

  for (let page = 0; out.length < limit; page++) {
    const result = await ymJson(
      `${API}/artists/${artistId}/tracks?page=${page}&page-size=${PER_PAGE}`,
      token
    );
    const chunk: any[] = result?.tracks ?? [];
    out.push(...chunk.map(mapYandexTrack).filter(Boolean));

    // Конец списка виден по двум признакам, и проверять надо оба: `pager` у части ответов
    // приходит без `total`, а короткая порция бывает и в середине — если в ней встретились
    // карточки без id, которые выбросил `mapYandexTrack`.
    const total = Number(result?.pager?.total);
    const done = chunk.length < PER_PAGE || (Number.isFinite(total) && (page + 1) * PER_PAGE >= total);
    if (done) break;
    // Страховка от бесконечного цикла, если API однажды перестанет уменьшать порцию.
    if (page > 40) break;
  }

  return out.slice(0, limit);
}

/**
 * Релизы артиста — те, что его собственные (`direct-albums`), а не сборники с его участием.
 *
 * Треков внутри ответ не содержит вовсе, только `trackCount`, — поэтому содержимое каждого
 * альбома догружается по требованию (`yandexAlbumTracks`), когда карточку раскрывают. Тянуть
 * тридцать девять альбомов целиком ради сетки обложек значило бы тридцать девять запросов на
 * открытие страницы.
 */
export async function yandexArtistAlbums(
  rawToken: string,
  artistId: string | number,
  limit = 100
): Promise<any[]> {
  const token = normalizeYandexToken(rawToken);
  if (!token || !artistId) return [];

  const result = await ymJson(
    `${API}/artists/${artistId}/direct-albums?page=0&page-size=${limit}&sort-by=year`,
    token
  );
  const albums: any[] = result?.albums ?? [];

  return albums
    .filter((a) => a && a.id != null)
    .map((a) => ({
      // Префикс — чтобы id альбома Яндекса не столкнулся с id альбома SoundCloud в одном
      // списке (`expandedAlbum` хранит именно строку id).
      id: `ym_album_${a.id}`,
      albumId: `${a.id}`,
      title: a.title || 'Без названия',
      coverUrl: ymCover(a.coverUri || a.ogImage),
      trackCount: Number(a.trackCount) || 0,
      year: Number(a.year) || 0,
      // `single`/`compilation`/`podcast` — то, что Музыка про релиз утверждает сама. Всё
      // остальное на странице зовётся альбомом: угадывать «EP» по числу треков значило бы
      // выдавать догадку за данные источника.
      albumType: `${a.type ?? ''}`,
      releaseDate: a.releaseDate || (a.year ? `${a.year}-01-01` : ''),
      likesCount: Number(a.likesCount) || 0,
      genre: a.genre || '',
      // Заполняется при раскрытии карточки; пустой массив, а не `undefined`, чтобы разметке
      // не приходилось различать «ещё не грузили» и «сломалось».
      tracks: [] as any[],
      source: 'yandex',
    }));
}

/** Содержимое альбома. `volumes` — это диски: у сборников их бывает несколько. */
export async function yandexAlbumTracks(rawToken: string, albumId: string | number): Promise<any[]> {
  const token = normalizeYandexToken(rawToken);
  if (!token || !albumId) return [];

  const result = await ymJson(`${API}/albums/${albumId}/with-tracks`, token);
  const volumes: any[][] = result?.volumes ?? [];
  return volumes.flat().map(mapYandexTrack).filter(Boolean);
}


/**
 * uid аккаунта, один раз за сессию.
 *
 * Другого способа узнать его нет — только `/account/status`, — а нужен он теперь не одному
 * методу, а каждому обращению к лайкам: и чтению, и двум отметкам. Без кеша синхронизация
 * при запуске стоила бы четыре одинаковых запроса вместо одного, причём каждый из них —
 * лишний повод получить 429 на ровном месте.
 *
 * Ключ — сам токен: сменили аккаунт, значит и uid надо спрашивать заново.
 */
let cachedUid: { token: string; uid: number } | null = null;

async function accountUid(token: string): Promise<number> {
  if (cachedUid && cachedUid.token === token) return cachedUid.uid;
  const account = await yandexAccountStatus(token);
  if (!account.uid) throw new Error('не удалось определить аккаунт Яндекс Музыки');
  cachedUid = { token, uid: account.uid };
  return account.uid;
}

/**
 * Поставить или снять лайки на треках аккаунта.
 *
 * Обратная сторона `getYandexLikes`: без неё лайк, поставленный в приложении, оставался
 * только здесь, и следующее же чтение лайков аккаунта возвращало прежнее состояние —
 * отметка выглядела как потерянная, хотя терялась она не при чтении, а потому что её никто
 * не отправлял.
 *
 * Форма запроса — не JSON, а `track-ids` в теле формы: этот метод API принимает только её.
 * Ответ содержательного ничего не несёт (`{ result: { revision } }`), поэтому и не читаем:
 * важно лишь, что он не ошибка — этим займётся `ymJson`.
 *
 * Чанк 100 — как при чтении: список отметок приходит из очереди и может накопиться за время
 * без сети, а длина строки запроса не бесконечна.
 */
export async function yandexSetLikes(
  rawToken: string,
  trackIds: (string | number)[],
  liked: boolean
): Promise<void> {
  const token = normalizeYandexToken(rawToken);
  const ids = trackIds.map((id) => `${id ?? ''}`.trim()).filter(Boolean);
  if (!token || ids.length === 0) return;

  const uid = await accountUid(token);
  const action = liked ? 'add-multiple' : 'remove';

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    await ymJson(`${API}/users/${uid}/likes/tracks/${action}`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ 'track-ids': chunk.join(',') }).toString(),
    });
  }
}

/** Метаданные лайков на эту сессию: фоновой сверке обычно нужны только новые id. */
let likesTrackCache: { token: string; tracks: Map<string, any> } | null = null;

/**
 * Лайки аккаунта. Схема — та же, что у импорта плейлистов в noverplay
 * (`playlist_tracks.rs`): сначала список идентификаторов, потом гидрация чанками, потому
 * что `/likes/tracks` отдаёт только id, а не сами треки. Чанк 100 — как в оригинале.
 *
 * `complete` — доехал ли список целиком, и это не мелочь для отчётности. Список лайков
 * аккаунта используется как эталон при сверке (см. `$lib/likes`): «трека нет в ответе»
 * означает там «лайк сняли», и локальная копия отметки после этого удаляется. Сорвавшийся
 * чанк выглядит в ответе ровно так же, как снятые сто лайков, — поэтому о неполноте надо
 * сообщать явно, иначе один таймаут посреди загрузки стирал бы часть библиотеки.
 */
export async function getYandexLikes(
  rawToken: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ tracks: any[]; complete: boolean }> {
  const token = normalizeYandexToken(rawToken);
  const uid = await accountUid(token);

  const library = await ymJson(`${API}/users/${uid}/likes/tracks`, token);
  const ids: string[] = (library?.library?.tracks ?? [])
    .map((t: any) => `${t?.id ?? ''}`.trim())
    .filter(Boolean);

  if (!likesTrackCache || likesTrackCache.token !== token) {
    likesTrackCache = { token, tracks: new Map() };
  }
  const cache = likesTrackCache.tracks;
  const missingIds = ids.filter((id) => !cache.has(id));
  const chunks: string[][] = [];
  for (let i = 0; i < missingIds.length; i += 100) chunks.push(missingIds.slice(i, i + 100));

  // Гидрация больших библиотек больше не ждёт каждый чанк по очереди. Три одновременных
  // запроса заметно ускоряют запуск, но оставляют запас под лимиты API и не меняют качество
  // данных: результат собирается в исходном порядке, а любая ошибка делает ответ partial.
  const results: Array<{ tracks: any[]; ok: boolean; size: number }> = [];
  for (let start = 0; start < chunks.length; start += 3) {
    const group = chunks.slice(start, start + 3);
    const settled = await Promise.all(
      group.map(async (chunk) => {
        try {
          const batch = await ymJson(`${API}/tracks?trackIds=${chunk.join(',')}`, token);
          return {
            tracks: Array.isArray(batch) ? batch.map(mapYandexTrack).filter(Boolean) : [],
            ok: Array.isArray(batch),
            size: chunk.length,
          };
        } catch (e) {
          // Один сорвавшийся чанк не повод терять остальные полторы тысячи лайков.
          console.warn('[yandex] чанк лайков не загрузился', e);
          return { tracks: [], ok: false, size: chunk.length };
        }
      })
    );
    results.push(...settled);
    onProgress?.(
      Math.min(ids.length - missingIds.length + results.reduce((sum, result) => sum + result.size, 0), ids.length),
      ids.length
    );
  }

  for (const result of results) {
    for (const track of result.tracks) {
      const id = `${track?.id ?? ''}`.trim();
      if (id) cache.set(id, track);
    }
  }
  if (missingIds.length === 0) onProgress?.(ids.length, ids.length);

  return {
    tracks: ids.map((id) => cache.get(id)).filter(Boolean),
    complete: results.every((result) => result.ok),
  };
}

/* ── Ссылка на поток ──────────────────────────────────────────────────────────
   Порт playback.rs. В noverplay это один вызов крейта:

       client.get_file_info(&GetFileInfoOptions::new(&track.id)
           .quality(Quality::Normal)
           .codecs([Codec::Mp3, Codec::Aac, Codec::AacMp4])
           .is_encrypted(false))

   Внутри крейта — подписанный запрос к `/get-file-info`. Мы его повторяем руками, а рядом
   держим второй, исторический путь (`/tracks/{id}/download-info` + XML + md5). Причина не в
   перестраховке ради перестраховки: подпись `/get-file-info` — недокументированная деталь
   чужого API, ключ и порядок полей в ней Яндекс менял. Если она перестанет проходить,
   без второго пути музыка просто не играет; со вторым — играет, только без lossless.
   Сработавший путь запоминается, так что «лишний» запрос делается один раз за сессию.

   `is_encrypted(false)` в оригинале — принципиальный момент: DRM-потоки не берём вообще,
   расшифровать их нечем. Поэтому и кодеки только те, что умеет наш декодер (rodio собран с
   mp3/aac/isomp4/ogg — flac в списке features нет, просить lossless бессмысленно). */

/** Ключ подписи `/get-file-info`. Ровно тот, что зашит в клиентах Яндекс Музыки. */
const SIGN_KEY = 'p93jhgh689SBReK6ghtw62';

/** Соль исторического `download-info`. Не менялась много лет. */
const LEGACY_SALT = 'XGRlBW9FXlekgbPrRHuSiA';

/** Какой путь сработал в этой сессии: не гоняем заведомо мёртвый запрос на каждом треке. */
let workingRoute: 'v2' | 'legacy' | null = null;

/**
 * Порт `vybrat_url_potoka`: берём первую ссылку, которая похожа на настоящий поток.
 * Превью и сниппеты отбрасываем явно — с ними трек «играет» 30 секунд и это выглядит как
 * баг плеера, а не как ограничение источника.
 */
function pickStreamUrl(candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    const url = (candidate ?? '').trim();
    if (!url) continue;
    const lower = url.toLowerCase();
    if (lower.includes('preview') || lower.includes('snippet')) continue;
    const normalized = url.startsWith('//') ? `https:${url}` : url;
    if (!/^https?:\/\//i.test(normalized)) continue;
    return normalized;
  }
  return null;
}

async function signFileInfo(
  ts: number,
  trackId: string,
  quality: string,
  codecs: string[],
  transports: string[]
): Promise<string> {
  const message = `${ts}${trackId}${quality}${codecs.join('')}${transports.join('')}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(SIGN_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const bytes = new Uint8Array(signature);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // Последний символ base64 отбрасывается — так подпись формируют официальные клиенты.
  return btoa(binary).slice(0, -1);
}

async function streamUrlV2(trackId: string, token: string): Promise<string | null> {
  const ts = Math.floor(Date.now() / 1000);
  const quality = 'nq'; // Quality::Normal из оригинала (`Display for Quality` → "nq")
  // Ровно тот список, что просит эталон: `[Codec::Mp3, Codec::Aac, Codec::AacMp4]`.
  // Строки взяты из `Display for Codec` в крейте — `"mp3"`, `"aac"`, `"aac-mp4"`.
  // Здесь раньше стоял `he-aac`, и это была ошибка с двумя последствиями сразу: он входит
  // в подписываемую строку, так что менялась и сама подпись, а в ответ приходил поток в
  // кодеке, которого нет в нашем декодере. `aac-mp4` — это AAC в контейнере MP4, его rodio
  // c фичей `isomp4` читает.
  const codecs = ['mp3', 'aac', 'aac-mp4'];
  // `is_encrypted(false)` из оригинала: "encraw" — это DRM, расшифровать его нечем.
  const transports = ['raw'];
  const sign = await signFileInfo(ts, trackId, quality, codecs, transports);

  const url =
    `${API}/get-file-info?ts=${ts}&trackId=${encodeURIComponent(trackId)}` +
    `&quality=${quality}&codecs=${codecs.join(',')}&transports=${transports.join(',')}` +
    `&sign=${encodeURIComponent(sign)}`;

  const result = await ymJson(url, token);
  const info = result?.downloadInfo ?? result;
  if (!info) return null;
  return pickStreamUrl([...(Array.isArray(info.urls) ? info.urls : []), info.url]);
}

/** Значение одного тега из ответа `download-info` — XML там плоский, парсер не нужен. */
function xmlTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
  return match ? match[1].trim() : '';
}

async function streamUrlLegacy(trackId: string, token: string): Promise<string | null> {
  const variants = await ymJson(`${API}/tracks/${trackId}/download-info`, token);
  if (!Array.isArray(variants)) return null;

  const usable = variants
    .filter((v: any) => v?.downloadInfoUrl && v.preview !== true)
    // mp3 вперёд: он декодируется гарантированно. Внутри кодека — по битрейту вниз.
    .sort((a: any, b: any) => {
      const codecRank = (v: any) => (v.codec === 'mp3' ? 0 : 1);
      return codecRank(a) - codecRank(b) || (b.bitrateInKbps ?? 0) - (a.bitrateInKbps ?? 0);
    });
  if (usable.length === 0) return null;

  for (const variant of usable) {
    try {
      const res = await ymFetch(variant.downloadInfoUrl, token);
      if (!res.ok) continue;
      const xml = await res.text();
      const host = xmlTag(xml, 'host');
      const path = xmlTag(xml, 'path');
      const ts = xmlTag(xml, 'ts');
      const s = xmlTag(xml, 's');
      if (!host || !path || !ts || !s) continue;
      const sign = md5(LEGACY_SALT + path.slice(1) + s);
      const url = pickStreamUrl([`https://${host}/get-mp3/${sign}/${ts}${path}`]);
      if (url) return url;
    } catch (e) {
      console.warn('[yandex] download-info не отдал поток', e);
    }
  }
  return null;
}

/**
 * Готовая ссылка на аудио для трека Яндекс Музыки — то, что уходит в `audio_load_url`.
 * Заголовков к ней не нужно: ссылка подписана и живёт сама (в noverplay `PlaybackSource`
 * тоже отдаётся с пустыми headers).
 *
 * Различие между «сбоем» и «нет потока» здесь не формальность, а причина одного из самых
 * дорогих багов в приложении. Раньше функция в обоих случаях возвращала `null`, и плеер,
 * не имея возможности отличить одно от другого, трактовал любой `null` как «трек
 * заблокирован в регионе» — и записывал этот вывод в лайки и в базу навсегда. Один
 * сетевой сбой или один 403 из-за заголовков превращал живой трек в мёртвую строку,
 * которая после перезапуска приложения так и оставалась мёртвой.
 *
 * Поэтому: сбой — исключение с человеческим текстом (его видно в уведомлении, и он не
 * ведёт ни к каким пометкам), отсутствие потока при исправном ответе API — `null`.
 */
export async function getYandexStreamUrl(
  rawToken: string,
  trackId: string | number
): Promise<string | null> {
  const token = normalizeYandexToken(rawToken);
  const id = `${trackId ?? ''}`.trim();
  if (!token || !id) return null;

  const routes: Array<'v2' | 'legacy'> =
    workingRoute === 'legacy' ? ['legacy', 'v2'] : ['v2', 'legacy'];

  let lastError: unknown = null;
  for (const route of routes) {
    try {
      const url = route === 'v2' ? await streamUrlV2(id, token) : await streamUrlLegacy(id, token);
      if (url) {
        workingRoute = route;
        return url;
      }
    } catch (e) {
      lastError = e;
      console.warn(`[yandex] поток через ${route} не получен`, e);
    }
  }
  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
  return null;
}
