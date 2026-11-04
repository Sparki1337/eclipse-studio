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

## 🔐 Приватный ключ Ryuu перед сборкой

Значение встроенного ключа больше не хранится в репозитории. Если нужен режим
**Crocodile Gena Studio**, перед сборкой один раз выполните из корня проекта:

```powershell
python scripts/set_ryuu_key.py
```

Введите ключ в обычном терминале: ввод скрыт. Скрипт создаст локальный файл
`.secrets/ryuu-key.txt`; вся папка `.secrets/` исключена из Git. В публичном
архиве исходников этого файла нет. Ключ вводится отдельно, не аргументом команды.
Локальный сборочный файл — обычный текст: не отправляйте его другим людям.

Для CI вместо файла задайте переменную окружения `ECLIPSE_RYUU_BUILTIN_KEY`.
Она имеет приоритет над локальным файлом. В GitHub Actions сохраните значение
в **Settings → Secrets and variables → Actions → New repository secret**
под именем `RYUU_BUILTIN_KEY`, затем добавьте к существующему шагу сборки:

```yaml
env:
  ECLIPSE_RYUU_BUILTIN_KEY: ${{ secrets.RYUU_BUILTIN_KEY }}
```

Значение не записывается в YAML и не выводится нашим скриптом сборки. Не
печатайте окружение и не публикуйте сборочный кеш `target/` с секретом.
При изменении переменной или локального файла Cargo заново подготавливает ключ.
Пустое или неверное явно заданное значение вызывает ошибку сборки.

Без файла и переменной сборка разрешена: доступен **Свой ключ**, а выбор
встроенного режима выдаст понятную ошибку настройки. При наличии приватного
ключа он попадёт в EXE; извлечение из готового EXE всё ещё возможно.
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

### 5. Локальное облако (CloudRedirect)
Движок локального облака вшивается в EXE через `include_bytes!` (`src-tauri/src/local_cloud.rs`):
```text
src-tauri/resources/local-cloud/
├── cgs_cloud_redirect.dll   (CloudRedirect 2.6.6-cgs-local.1, x64)
└── LICENSE.txt              (лицензия MIT движка)
```
DLL взята из официального релиза Crocodile Gena Studio 5.6.3 без изменений
(SHA-256 `e45f409c417d4b77ed4741bfcd6b798351882aabd849ceb477938bb8afe4d871`), поэтому для обычной сборки C++-инструменты не нужны.
Исходники движка лежат в `third_party/cloudredirect` (MIT, upstream — [crghofficial/cloudredirect](https://github.com/crghofficial/cloudredirect),
зафиксированный коммит `4e81e492e4678c1d907fbeaef2625846f6afaad8`), список изменений — в `third_party/cloudredirect/CGS-INTEGRATION.md`.
Копия лицензии для интерфейса — `ui/assets/licenses/cloudredirect-MIT.txt`.

Если вы меняли код движка, пересоберите DLL из x64 Developer PowerShell для Visual Studio (нужны `cl.exe`, C++20 и Windows SDK; CMake и .NET не требуются):
```powershell
./scripts/build_local_cloud.ps1
```
Скрипт положит новую `cgs_cloud_redirect.dll` и `LICENSE.txt` в `src-tauri/resources/local-cloud/` и выведет SHA-256.
Своя сборка побайтово не совпадёт с официальной — это нормально: хеш встроенной DLL программа вычисляет сама.

---

## ⚡ Автоматическая сборка через Python (Рекомендуемый способ)

В папке `scripts/` есть готовые скрипты для быстрой подготовки релиза. Запускайте их из корня репозитория:

### 1. Обновление версии: `scripts/bump_version.py`
Запускается **перед сборкой**, если требуется изменить номер версии.
```powershell
# Интерактивный ввод версии:
python scripts/bump_version.py

# Или передача версии аргументом:
python scripts/bump_version.py 9.0.0
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

## 🔄 Обновление внутри программы (требования к релизу)

Кнопка «Обновить и перезапустить» скачивает новый EXE прямо из релиза GitHub и заменяет текущий файл на месте —
путь, имя файла и ярлыки сохраняются. Отдельной утилиты (как `CgsUpdater.exe` в оригинале) нет: роль помощника
выполняет копия текущего EXE, запущенная с ключом `--eclipse-update-helper`. Чтобы обновление работало, релиз должен соответствовать правилам:

1. **Файл релиза** — портативный x64 EXE с именем `Eclipse-Studio-v<версия>.exe` (именно его создаёт `scripts/build.py`).
   Если такого имени нет, берётся первый `.exe` со словом `eclipse` в имени, кроме `setup`/`installer`.
2. **Тег релиза** — `v<версия>`, при этом версия в ресурсах EXE (`FILEVERSION`) должна совпадать с тегом.
   Поэтому перед сборкой всегда выполняйте `python scripts/bump_version.py <версия>`.
3. **SHA-256** берётся из хеша `sha256:…`, который GitHub сам вычисляет и показывает у каждого загруженного файла релиза —
   вручную ничего публиковать не нужно. Если хеша нет, программа не станет ставить обновление и предложит только «Скачать EXE».

Как проходит установка:
* рядом с EXE создаётся временная папка `.eclipse-update-<nonce>` (`payload.exe`, `updater.exe`, `plan.json`, `helper.log`);
* файл скачивается (до 3 попыток при сетевых сбоях, с прогрессом, скоростью и отменой), затем проверяются SHA-256,
  разрядность, тип программы и версия файла;
* помощник получает SHA-256 `plan.json` в аргументах, ждёт команду `go` (до 600 с), закрытия программы (до 120 с)
  и подтверждения от новой версии, запущенной с ключом `--eclipse-update-probe` (до 90 с);
* если новая версия не запустилась или не подтвердила запуск, прежний EXE возвращается на место и сразу запускается
  с сообщением о причине (ключ `--eclipse-update-failed`);
* права администратора не запрашиваются: если в папку программы нельзя писать, обновление отказывается заранее
  с подсказкой запустить программу от имени администратора или перенести её в папку пользователя.

Проверки файловой транзакции, отката и разбора страницы релиза входят в `npm run test:safety` (`src-tauri/src/update_core.rs`).

---

## 🔍 Решение возможных проблем

| Ошибка | Причина | Решение |
| :--- | :--- | :--- |
| `couldn't read ... .millennium/Dist/index.js` | Папка `.millennium` не скопировалась (скрытая папка) | Проверьте наличие `eclipse-manifest/.millennium/Dist/` (или пересоберите плагин: `npm run build:plugin`) |
| `couldn't read ... smokeapi/SmokeAPI64.dll` | Файлы анлокера переименованы или отсутствуют | Убедитесь, что есть `src-tauri/resources/smokeapi/SmokeAPI64.dll` и `SmokeAPI86.dll` |
| `couldn't read ... creamapi/steam_api64.dll` | Папка CreamAPI переименована или отсутствует | Убедитесь, что есть папка `src-tauri/resources/creamapi/` с `steam_api.dll` и `steam_api64.dll` |
| `couldn't read ... local-cloud/cgs_cloud_redirect.dll` | Ресурс локального облака не скопирован | Верните `src-tauri/resources/local-cloud/` из репозитория или пересоберите DLL: `./scripts/build_local_cloud.ps1` |
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
  <sub>Eclipse Studio v9.0.0 • Инструкция по сборке</sub>
</div>
