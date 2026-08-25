# LomifyNEXT

[![Release](https://img.shields.io/github/v/release/FnaferGou777/LomifyNEXT?color=ff5500)](https://github.com/FnaferGou777/LomifyNEXT/releases)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)

<p align="center">
  <img src="static/lomifystart.png" alt="LomifyNEXT Logo" width="160" />
</p>

## О проекте

**LomifyNEXT** — это легковесный десктопный аудиоплеер с акцентом на визуал и удобство, объединяющий медиатеки **Яндекс Музыки** и **SoundCloud** в одном приложении.

> [!NOTE]
> **Для пользователей из РФ:**  
> Для стабильного воспроизведения треков из **SoundCloud** требуется включенный VPN или настроенный zapret, так как без средств обхода блокировок аудиопотоки СК в России не отдаются.

> [!CAUTION]
> Интеграция с Яндекс Музыкой НЕ даёт возможность слушать музыку без авторизации и активной подписки Яндекс Плюс.

---

## Возможности

* **Два сервиса в одном окне:** Бесшовный поиск и воспроизведение треков как из SoundCloud, так и из Яндекс Музыки.
* **Тексты песен:** Просмотр синхронизированных слов прямо во время воспроизведения.
* **Система лайков:** Сохранение любимых треков в избранное в один клик.
* **Глубокая кастомизация:** Тонкая настройка тем, интерфейса, параметров звука и встроенного эквалайзера.
* **Производительность:** Нативный легковесный движок на базе Tauri и Svelte с минимальным потреблением ресурсов.

---

## Разработка

Проект построен на стеке **Tauri + SvelteKit + TypeScript (Vite)**.

### Рекомендуемое окружение (IDE Setup)

* [VS Code](https://code.visualstudio.com/)
* Расширения:
  * [Svelte for VS Code](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode)
  * [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode)
  * [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

### Сборка из исходников

Предварительно установите **Node.js** (18+) и **Rust** (cargo, rustup).

```bash
# 1. Клонирование репозитория
git clone [https://github.com/FnaferGou777/LomifyNEXT.git](https://github.com/FnaferGou777/LomifyNEXT.git)
cd LomifyNEXT

# 2. Установка зависимостей
npm install

# 3. Запуск в режиме разработки
npm run tauri dev

# 4. Сборка релизной версии
npm run tauri build