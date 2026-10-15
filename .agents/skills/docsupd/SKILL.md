---
name: docsupd
description: Автоматическое фоновое обновление всех скриншотов интерфейса Eclipse Studio для каталога docs/ (docs/screenshots/ и docs/assets/compare-eclipse.png). Запускает headless-браузер без открытия окон и без помех пользователю с моком Tauri API и белым акцентным цветом. Также активируется через слэш-команду /docsupd.
---

# Автоматическое обновление скриншотов документации (/docsupd)

Данный скилл предназначен для автономного обновления всех скриншотов приложения в папке `docs/screenshots/` и файла сравнения `docs/assets/compare-eclipse.png`.

## 📌 Основные требования и параметры:
1. **Фоновый режим без помех**: браузер запускается строго в headless-режиме (`--headless=new`, `--disable-gpu`) через `puppeteer-core` с системным исполняемым файлом Edge (`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`). Окна не должны открываться, фокус ввода не перехватывается.
2. **Разрешение скриншотов**: ровно 1440×900 (`deviceScaleFactor: 1`).
3. **Оформление**:
   - Тема: `graphite` (основная тёмная тема).
   - Акцентный цвет: `white` (белый цвет подсветки, индикаторов и активных элементов).
   - Заставка: отключена (`localStorage.setItem('cgs-splash', '0')`).
4. **Список обновляемых файлов (13 штук)**:
   - `docs/screenshots/Главная.png` — Главный экран приложения
   - `docs/screenshots/Online_Fix.png` — Раздел Universal Online Fix
   - `docs/screenshots/Менеджер_сохранений.png` — Менеджер сохранений прогресса
   - `docs/screenshots/DLC_Unlocker.png` — Разблокировщик DLC (библиотека Steam с постерами)
   - `docs/screenshots/Eclipse_Manifest.png` — Менеджер манифестов и плагина Millennium
   - `docs/screenshots/Гипервизор.png` — Гипервизор (вкладка запуска игр)
   - `docs/screenshots/Античиты.png` — Гипервизор (вкладка аудита античитов)
   - `docs/screenshots/VBS.png` — Гипервизор (вкладка VBS, HVCI и Test Mode)
   - `docs/screenshots/Кряки.png` — Каталог Crack Vault с закреплёнными релизами
   - `docs/screenshots/Утилиты.png` — Хаб внешних утилит (Cirno, Sigma, Zapret2)
   - `docs/screenshots/Настройки.png` — Настройки со вкладками и акцентами
   - `docs/screenshots/Telegram_Каналы.png` — Модальное окно каналов сообщества
   - `docs/assets/compare-eclipse.png` — Изображение для слайдера сравнения «Было / Стало»

---

## 🚀 Порядок выполнения:

1. **Запуск скрипта захвата скриншотов**:
   Запустите Node.js скрипт из корня репозитория:
   ```powershell
   node tools/capture_all_screenshots.js
   ```

2. **Проверка результатов**:
   Убедитесь, что все 13 файлов созданы, не пусты и имеют правильное разрешение 1440×900:
   ```powershell
   node -e "
   const fs = require('fs');
   const path = require('path');
   function getDim(p) {
     const b = fs.readFileSync(p);
     return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), size: b.length };
   }
   const dir = path.join('docs', 'screenshots');
   for (const f of fs.readdirSync(dir)) {
     console.log(f, getDim(path.join(dir, f)));
   }
   console.log('compare-eclipse.png', getDim(path.join('docs', 'assets', 'compare-eclipse.png')));
   "
   ```

3. **Проверка целостности проекта**:
   - `cargo check --manifest-path src-tauri/Cargo.toml`
   - `git status`
