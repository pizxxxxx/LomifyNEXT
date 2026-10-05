import './style.css';
import brandImage from '../NewIconPPP.png';
import { parseShareLink, platformTrackLink, toDeepLink, SHARE_PAGE_URL } from '../src/lib/shareLinksCore';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
element<HTMLImageElement>('brand-background').src = brandImage;
let launchTimer: ReturnType<typeof setTimeout> | undefined;

element('open-app').addEventListener('click', () => {
  clearTimeout(launchTimer);
  element('launch-help').hidden = true;
  element('launch-status').textContent = 'Разреши браузеру открыть Lomify, если появится запрос.';
  launchTimer = setTimeout(() => {
    if (document.visibilityState === 'visible') {
      element('launch-help').hidden = false;
      element('launch-status').textContent = 'Если приложение не открылось, попробуй шаги ниже.';
    }
  }, 1800);
});
element('copy-app-link').addEventListener('click', async () => {
  const link = toDeepLink(`${SHARE_PAGE_URL}${location.hash}`);
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
    element('launch-status').textContent = 'Ссылка для приложения скопирована.';
  } catch { element('launch-status').textContent = 'Браузер не разрешил копирование. Попробуй открыть ссылку снова.'; }
});

function render() {
  clearTimeout(launchTimer);
  element('launch-status').textContent = '';
  element('launch-help').hidden = true;
  // Validate the fragment identically in production and the isolated local preview.
  const raw = `${SHARE_PAGE_URL}${location.hash}`;
  const selection = parseShareLink(raw);
  const deepLink = toDeepLink(raw);
  const title = element('title'), subtitle = element('subtitle');
  element('actions').hidden = true;
  element('tracks').hidden = true;
  element('track-list').replaceChildren();
  if (!selection || !deepLink) {
    document.title = 'Музыка в LomifyNEXT';
    element('eyebrow').textContent = 'МУЗЫКОЙ ПОДЕЛИЛИСЬ С ТОБОЙ';
    title.textContent = location.hash ? 'Ссылка не распознана' : 'Музыка в Lomify';
    subtitle.textContent = location.hash ? 'Попроси отправителя снова нажать «Поделиться» в приложении.' : 'Открой ссылку на трек или подборку из приложения.';
    return;
  }
  title.textContent = selection.mix.title;
  document.title = `${selection.mix.title} | LomifyNEXT`;
  subtitle.textContent = selection.sharedTrack ? selection.mix.description : `${selection.source === 'yandex' ? 'Яндекс Музыка' : 'SoundCloud'} · ${new Date(`${selection.mix.day}T12:00:00`).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}`;
  element('eyebrow').textContent = selection.sharedTrack ? 'ТЕБЕ ПРИСЛАЛИ ТРЕК' : 'ТЕБЕ ПРИСЛАЛИ ПОДБОРКУ';
  element<HTMLAnchorElement>('open-app').href = deepLink;
  element<HTMLAnchorElement>('open-service').href = platformTrackLink(selection.mix.tracks[0]);
  element('open-service').textContent = selection.source === 'yandex' ? 'Открыть в Яндекс Музыке' : 'Найти на SoundCloud';
  element('open-service').hidden = !selection.sharedTrack;
  element('actions').hidden = false;
  element('help').textContent = 'Запусти LomifyNEXT версии 9.5.2 или новее. Он подключит музыкальные ссылки к Windows. Вернись сюда, нажми «Открыть в Lomify» и разреши браузеру запустить приложение. Для Яндекс Музыки нужен вход в аккаунт.';
  if (selection.sharedTrack) return;
  element('tracks').hidden = false;
  element('count').textContent = `${selection.mix.tracks.length} треков`;
  for (const track of selection.mix.tracks) {
    const row = document.createElement('li'), link = document.createElement('a');
    const name = document.createElement('strong'), artist = document.createElement('span');
    name.textContent = track.title; artist.textContent = track.artist;
    link.href = platformTrackLink(track); link.target = '_blank'; link.rel = 'noopener noreferrer';
    link.append(name, artist); row.append(link); element('track-list').append(row);
  }
}
render();
window.addEventListener('hashchange', render);
