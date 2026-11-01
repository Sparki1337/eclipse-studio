# 🛠️ Руководство по сборке Eclipse Studio

Инструкция по подготовке окружения и компиляции релизной версии приложения из исходного кода.

> [!NOTE]
> **Обычным пользователям ничего из этого устанавливать не нужно!**  
> Если вы хотите просто использовать Eclipse Studio, скачайте готовый файл (`.exe` / инсталлятор) в разделе **Releases**.  
> Данное руководство нужно **только разработчикам**, которые хотят собрать приложение из исходного кода вручную.

---

## 📋 Системные требования для сборки

Для сборки проекта на Windows вам потребуются:

1. **Node.js** (версия `18.x` или новее) + менеджер пакетов `npm`.
   * [Скачать с официального сайта nodejs.org](https://nodejs.org/)
2. **Rust & Cargo** (актуальная стабильная версия x64):
   * Установите через [rustup.rs](https://rustup.rs/)
   * Целевая платформа по умолчанию: `x86_64-pc-windows-msvc`
3. **Visual Studio C++ Build Tools** (компоненты для сборки C++):
   * В Visual Studio Installer отметьте компонент: **«Разработка классических приложений на C++»** (MSVC v143+, Windows 10/11 SDK).

---

## ⚠️ Важные нюансы и файлы перед сборкой

Перед запуском компиляции убедитесь в наличии следующих компонентов:

### 1. Скрытые файлы плагина Millennium (`.millennium`)
В Rust-коде (`millennium.rs`) компилируются встроенные ресурсы плагина «Eclipse Manifest» (исходники плагина — в папке `eclipse-manifest/` в корне репозитория):
```text
eclipse-manifest/.millennium/Dist/index.js
eclipse-manifest/.millennium/Dist/webkit.js
```
> **Внимание:** В Windows папки, начинающиеся с точки (`.millennium`), считаются скрытыми системными директориями. При копировании файлов через некоторые архиваторы или проводник эта папка может не скопироваться.
> 
> **Решение:** Убедитесь, что в проводнике включено отображение скрытых элементов (`Вид → Показать → Скрытые элементы`) и папка `.millennium/Dist/` на месте. В `.gitignore` репозитория она уже добавлена в исключения, чтобы Git её не удалял.

### 2. Папки с библиотеками анлокеров (SmokeAPI и CreamAPI)
Все бинарные ресурсы приложения лежат в `src-tauri/resources/`. Для анлокеров должны быть на месте:
```text
src-tauri/resources/smokeapi/
├── SmokeAPI64.dll   (64-битная версия)
└── SmokeAPI86.dll   (32-битная версия)

src-tauri/resources/creamapi/
├── steam_api.dll    (32-битная версия)
└── steam_api64.dll  (64-битная версия)
```
Они компилируются в бинарник через макрос `include_bytes!`; библиотеки CreamAPI дополнительно кладутся рядом с установщиком как ресурсы Tauri (`bundle.resources` в `src-tauri/tauri.conf.json`).

### 3. Встроенные библиотеки OpenSteamTool (Версия 1 и Версия 2)
В каталогах `src-tauri/resources/opensteamtool/v1/` (стандартная версия, вместе с `opensteamtool.toml`) и `src-tauri/resources/opensteamtool/v2/` (версия совместимости) находятся хуки загрузчиков манифестов (`OpenSteamTool.dll`, `dwmapi.dll`, `xinput1_4.dll`), вшиваемые в исполняемый файл приложения.

### 4. Автономный лаунчер Eclipse-HV
В каталоге `eclipse-hv/` (отдельный Rust-крейт) находится исходный код автономного лаунчера Eclipse-HV для изолированного запуска игр с обходом DSE и поддержкой современных процессоров (AVX-512 / Zen 4 / Intel 12+). В приложение вшивается уже собранный файл `src-tauri/resources/hypervisor/Eclipse-HV.exe`, поэтому для обычной сборки компилировать лаунчер не нужно. Если вы меняли его код, пересоберите лаунчер и замените вшиваемый файл:
```powershell
cargo build --release --manifest-path eclipse-hv/Cargo.toml
Copy-Item eclipse-hv/target/release/eclipse-hv.exe src-tauri/resources/hypervisor/Eclipse-HV.exe
```
Файлы в `eclipse-hv/reference/` (`HV-Launcher.bat`, `HV-PlugNPlay.bat`, `kvc.exe`) — справочные, в сборку не входят.

---

## ⚡ Автоматическая сборка через Python (Рекомендуемый способ)

В папке `scripts/` есть готовые скрипты для быстрой подготовки релиза. Запускайте их из корня репозитория:

### 1. Обновление версии: `scripts/bump_version.py`
Запускается **перед сборкой**, если требуется изменить номер версии.
```powershell
# Интерактивный ввод версии:
python scripts/bump_version.py

# Или передача версии аргументом:
python scripts/bump_version.py 8.2.0
```
Скрипт автоматически:
* Обновляет `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json` и `package-lock.json`.
* Обновляет бейджи, заголовки и строки версии в `ui/index.html`, `ui/core/app.js` и `ui/core/i18n.js`.
* Обновляет `User-Agent` в сетевых модулях Rust (`dlc_catalog.rs`, `files.rs`).
* Обновляет тесты и документацию (`README.md`, `BUILD.md`, `docs/`), версии в скриптах `scripts/` и в `.agents/skills/build/SKILL.md`.
* Синхронизирует `src-tauri/Cargo.lock`.

---

### 2. Сборка проекта: `scripts/build.py`
Скрипт компилирует проект, проверяет окружение и сохраняет готовые файлы в выбранную папку.
```powershell
# Интерактивный запуск (рекомендуется):
python scripts/build.py
```
**Возможности скрипта:**
* **Выбор типа сборки:**
  * `[1] Portable EXE` — автономный переносимый файл (быстрая сборка через Cargo release).
  * `[2] NSIS Setup` — полноценный Windows-установщик (через Tauri bundle).
  * `[3] Полная сборка` — собирает и Portable EXE, и NSIS Setup.
  * `[4] Debug билд` — быстрая отладочная сборка без оптимизаций.
* **Запоминание папки выгрузки:** при первом запуске вы указываете путь, куда отправлять готовые файлы. Скрипт сохраняет его в локальный `scripts/build_config.json` (включён в `.gitignore`). При следующих запусках достаточно нажать `Enter`.
* **Расчёт контрольных сумм:** автоматически выводит размер файлов и SHA-256 для проверки релиза.
* **Открытие папки:** предлагает сразу открыть Проводник Windows с готовыми файлами.

**Запуск с флагами командной строки:**
```powershell
# Собрать Portable EXE в конкретную папку:
python scripts/build.py --type portable --out "D:\Releases"

# Собрать инсталлятор NSIS:
python scripts/build.py --type nsis

# Собрать оба варианта с предварительной очисткой:
python scripts/build.py --type all --clean
```

---

## 🚀 Ручная сборка (альтернативный способ)

Если вы предпочитаете собирать проект стандартными командами вручную:

### Шаг 1. Перейдите в корень проекта
Откройте терминал (PowerShell или CMD) в папке проекта:
```powershell
cd eclipse-studio
```

### Шаг 2. Установка зависимостей интерфейса
Установите зависимости фронтенда:
```powershell
npm install
```

### Шаг 3. Запуск в режиме разработки (по желанию)
Для проверки работы и отладки с горячей перезагрузкой (Hot-Reload):
```powershell
npm run dev
```

### Шаг 4. Компиляция релизного билда

Для сборки готового Windows-установщика (NSIS Setup):
```powershell
npm run build -- --bundles nsis
```
После завершения готовый инсталлятор появится в директории:
```text
src-tauri/target/release/bundle/nsis/
```

Если вам нужен переносимый Portable EXE файл без установщика:
```powershell
cargo build --release --manifest-path src-tauri/Cargo.toml
```
Готовый `eclipse-studio.exe` будет находиться в:
```text
src-tauri/target/release/eclipse-studio.exe
```

---

## 🔍 Решение возможных проблем

| Ошибка | Причина | Решение |
| :--- | :--- | :--- |
| `couldn't read ... .millennium/Dist/index.js` | Папка `.millennium` не скопировалась (скрытая папка) | Проверьте наличие `eclipse-manifest/.millennium/Dist/` (или пересоберите плагин: `npm run build:plugin`) |
| `couldn't read ... smokeapi/SmokeAPI64.dll` | Файлы анлокера переименованы или отсутствуют | Убедитесь, что есть `src-tauri/resources/smokeapi/SmokeAPI64.dll` и `SmokeAPI86.dll` |
| `couldn't read ... creamapi/steam_api64.dll` | Папка CreamAPI переименована или отсутствует | Убедитесь, что есть папка `src-tauri/resources/creamapi/` с `steam_api.dll` и `steam_api64.dll` |
| `couldn't read ... Eclipse-HV.exe` / `opensteamtool/...` | Ресурс удалён или лежит не в той папке | Сверьте структуру `src-tauri/resources/` с разделом выше; `npm run test:contracts` покажет все несуществующие пути |
| `link.exe not found` | Не установлены инструменты C++ | Установите Visual Studio C++ Build Tools с Windows SDK |
| Ошибка антивируса при сборке | Windows Defender блокирует временный exe | Добавьте папку проекта в исключения Защитника Windows |

---

## 🧪 Тесты

Полный набор, как в CI:
```powershell
npm test
```
* `tests/contracts.cjs` (`npm run test:contracts`) — статические проверки: все вызовы бэкенда из интерфейса зарегистрированы в `lib.rs`, `localStorage` используется только в `ui/core/storage.js`, id в разметке уникальны, а все пути из кода и конфигов существуют (`include_bytes!`, `tauri.conf.json`, подключения в `ui/index.html` и `ui/core/loader.js`, `url()` в CSS, npm-скрипты и CI).
* `tests/ui.test.js` (`npm run test:ui`) — тесты интерфейса: `ui/` запускается в Chromium с подменой бэкенда Tauri (`tests/tauri-mock.js`). Нужен пакет `playwright` (`npm i -D playwright && npx playwright install chromium`).

Переменные: `CHROMIUM` — путь к своему Chromium, `SCREENSHOTS` — папка для скриншотов.

---

<div align="center">
  <sub>Eclipse Studio v8.2.0 • Инструкция по сборке</sub>
</div>
