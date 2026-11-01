---
name: build
description: Сборка строго портативной версии Eclipse Studio в целевую папку Hypervisor по правилам AGENTS.md, проверка целостности, расчёт контрольной суммы SHA-256 и формирование готового описания релиза для GitHub в фирменном двуязычном стиле. Также активируется через слэш-команду /build.
---

# Автоматическая сборка релиза и подготовка публикации (/build)

Данный скилл автоматизирует процесс создания строго портативной сборки **Eclipse Studio**, валидацию полученного исполняемого файла в каталоге Hypervisor и генерацию полного шаблона релиза для GitHub (тег, название, двуязычное описание, хэш SHA-256).

---

## 📌 Строгие правила и ограничения (из AGENTS.md):

1. **Тип сборки**:
   - **ИСКЛЮЧИТЕЛЬНО PORTABLE** (`--type portable` или `cargo build --release`).
   - Запрещено собирать установщики NSIS, инсталляторы, debug-сборки или multi-target сборки без прямого указания пользователя.
2. **Папка назначения**:
   - **СТРОГО** `C:\Users\Sparki\Desktop\Programms\Hypervisor` (папка Hypervisor).
   - Запрещено сохранять бинарники в другие папки или на рабочий стол напрямую.
3. **Имя выходного файла**:
   - **СТРОГО** `Eclipse-Studio-vX.X.X.exe` (где `X.X.X` — актуальная версия из `tauri.conf.json`, например `Eclipse-Studio-v8.2.0.exe`).
   - Запрещено использовать суффиксы `-Portable`, `-Setup` и любые другие.
4. **Протокол безопасности Git**:
   - **НИКОГДА** не выполнять `git commit` или `git push` без явного подтверждения пользователя.
   - Запрещено выполнять деструктивные команды (`git reset --hard`, `git checkout .`, `git clean -fd`).

---

## 🚀 Порядок выполнения сборки:

### Вариант 1. Автоматический запуск (рекомендуется)
Выполните вспомогательный скрипт релиза:
```powershell
python scripts/release.py
```
*Скрипт автоматически:*
1. Определит текущую версию из `src-tauri/tauri.conf.json`.
2. Запустит `scripts/build.py --type portable --out "C:\Users\Sparki\Desktop\Programms\Hypervisor" --no-open`.
3. Проверит создание файла `C:\Users\Sparki\Desktop\Programms\Hypervisor\Eclipse-Studio-vX.X.X.exe`.
4. Вычислит точную контрольную сумму SHA-256.
5. Проанализирует недавние git-коммиты и сгенерирует готовый блок релиза для GitHub.

---

### Вариант 2. Ручной пошаговый запуск

1. **Предварительная проверка кода бэкенда**:
   ```powershell
   cargo check --manifest-path src-tauri/Cargo.toml
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

2. **Запуск сборщика scripts/build.py**:
   ```powershell
   python scripts/build.py --type portable --out "C:\Users\Sparki\Desktop\Programms\Hypervisor" --no-open
   ```

3. **Проверка выходного файла и расчёт SHA-256**:
   ```powershell
   Get-FileHash -Algorithm SHA256 "C:\Users\Sparki\Desktop\Programms\Hypervisor\Eclipse-Studio-v*.exe"
   ```

4. **Формирование релиза GitHub**:
   - **Tag**: `X.X.X` (например `8.2.0`)
   - **Title**: `Eclipse Studio - X.X.X`
   - **Release Notes**:
     ```markdown
     # Eclipse Studio X.X.X

     ### Key Changes
     * **Feature / Fix**: English description of changes

     ### Antivirus Verification
     * **VirusTotal Report**: [Analysis Result 7\70](https://www.virustotal.com/)
     * **Status**: Clean.
     * **SHA-256 (Portable)**: `<SHA256_HASH>`

     ---
     ## Русский

     ### Основные изменения
     * **Фича / Исправление**: Описание изменений на русском языке

     ### Проверка безопасности
     * **Отчёт VirusTotal**: [Результат проверки 7\70](https://www.virustotal.com/)
     * **Статус**: Чистый файл.
     * **SHA-256 (Portable)**: `<SHA256_HASH>`
     ```

5. **Предоставление отчёта пользователю**:
   - Вывести путь к готовому файлу, его размер и хэш SHA-256.
   - Показать готовый текст для создания GitHub Release.
   - Запросить у пользователя подтверждение, если планируется коммит или тегирование в git.
