#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Скрипт синхронизации и обновления версии проекта во всех файлах репозитория

import re
import sys
import json
import subprocess
from pathlib import Path

# Корень репозитория (скрипт лежит в scripts/)
SCRIPTS_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPTS_DIR.parent

# Настройка вывода UTF-8 для консоли Windows
if sys.platform.startswith("win"):
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Основные файлы проекта
TAURI_CONF = ROOT_DIR / "src-tauri" / "tauri.conf.json"
CARGO_TOML = ROOT_DIR / "src-tauri" / "Cargo.toml"
PACKAGE_JSON = ROOT_DIR / "package.json"
PACKAGE_LOCK = ROOT_DIR / "package-lock.json"
INDEX_HTML = ROOT_DIR / "ui" / "index.html"
APP_JS = ROOT_DIR / "ui" / "core" / "app.js"
I18N_JS = ROOT_DIR / "ui" / "core" / "i18n.js"
DLC_CATALOG_RS = ROOT_DIR / "src-tauri" / "src" / "dlc_catalog.rs"
FILES_RS = ROOT_DIR / "src-tauri" / "src" / "files.rs"
TAURI_MOCK_JS = ROOT_DIR / "tests" / "tauri-mock.js"
UI_TEST_JS = ROOT_DIR / "tests" / "ui.test.js"
README_MD = ROOT_DIR / "README.md"
BUILD_MD = ROOT_DIR / "BUILD.md"
DOCS_INDEX_HTML = ROOT_DIR / "docs" / "index.html"
DOCS_APP_JS = ROOT_DIR / "docs" / "app.js"
# Скрипты разработки (scripts/)
BUILD_PY = SCRIPTS_DIR / "build.py"
RELEASE_PY = SCRIPTS_DIR / "release.py"
CAPTURE_JS = SCRIPTS_DIR / "capture_all_screenshots.js"
UI_DEV_JS = SCRIPTS_DIR / "ui_dev_server.js"

# Описание скилла сборки (.agents/skills)
SKILL_BUILD_MD = ROOT_DIR / ".agents" / "skills" / "build" / "SKILL.md"


def get_current_version() -> str:
    # Чтение текущей версии из tauri.conf.json или Cargo.toml
    if TAURI_CONF.exists():
        try:
            with open(TAURI_CONF, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("version", "0.0.0")
        except Exception:
            pass
    if CARGO_TOML.exists():
        try:
            content = CARGO_TOML.read_text(encoding="utf-8")
            match = re.search(r'(?m)^\s*version\s*=\s*"([^"]+)"', content)
            if match:
                return match.group(1)
        except Exception:
            pass
    return "0.0.0"


def validate_version(ver: str) -> bool:
    # Проверка формата semver (например, 8.0.0, 8.0.1-beta.1)
    pattern = r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$"
    return bool(re.match(pattern, ver))


def update_json_version(path: Path, new_ver: str) -> bool:
    # Обновление поля version в JSON-файле
    if not path.exists():
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        data["version"] = new_ver
        if path == PACKAGE_LOCK and "packages" in data and "" in data["packages"]:
            data["packages"][""]["version"] = new_ver
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        return True
    except Exception as e:
        print(f"[!] Ошибка при обновлении {path.name}: {e}")
        return False


def update_cargo_toml(new_ver: str) -> bool:
    # Обновление версии в Cargo.toml
    if not CARGO_TOML.exists():
        return False
    try:
        content = CARGO_TOML.read_text(encoding="utf-8")
        updated = re.sub(
            r'(?m)^(\s*version\s*=\s*")[^"]+(")',
            rf'\g<1>{new_ver}\g<2>',
            content,
            count=1,
        )
        CARGO_TOML.write_text(updated, encoding="utf-8")
        return True
    except Exception as e:
        print(f"[!] Ошибка при обновлении Cargo.toml: {e}")
        return False


def update_html(old_ver: str, new_ver: str) -> bool:
    # Обновление версий в UI index.html
    if not INDEX_HTML.exists():
        return False
    try:
        content = INDEX_HTML.read_text(encoding="utf-8")
        # Бейдж в шапке окна
        content = re.sub(
            r'(<span class="titlebar-version"[^>]*>)[^<]+(</span>)',
            rf"\g<1>{new_ver}\g<2>",
            content,
        )
        # Кикер в секции обновления/героя
        content = re.sub(
            r'(<span class="hero-kicker">ECLIPSE STUDIO\s*)[^<]+(</span>)',
            rf"\g<1>{new_ver}\g<2>",
            content,
        )
        # Текущая версия в блоке обновлений
        content = re.sub(
            r'(<b id="update-current-version">)[^<]+(</b>)',
            rf"\g<1>{new_ver}\g<2>",
            content,
        )
        # Карточка "О программе"
        content = re.sub(
            r'(<span>Версия</span><b>)[^<]+(</b>)',
            rf"\g<1>{new_ver}\g<2>",
            content,
        )
        INDEX_HTML.write_text(content, encoding="utf-8")
        return True
    except Exception as e:
        print(f"[!] Ошибка при обновлении index.html: {e}")
        return False


def update_js_files(old_ver: str, new_ver: str) -> bool:
    # Обновление логов и строк в app.js и i18n.js
    success = True
    if APP_JS.exists():
        try:
            content = APP_JS.read_text(encoding="utf-8")
            content = re.sub(
                r'Eclipse Studio [0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)? инициализирован',
                f"Eclipse Studio {new_ver} инициализирован",
                content,
            )
            APP_JS.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении app.js: {e}")
            success = False

    if I18N_JS.exists():
        try:
            content = I18N_JS.read_text(encoding="utf-8")
            content = content.replace(
                f"Eclipse Studio {old_ver} инициализирован",
                f"Eclipse Studio {new_ver} инициализирован",
            )
            content = content.replace(
                f"Eclipse Studio {old_ver} initialized",
                f"Eclipse Studio {new_ver} initialized",
            )
            I18N_JS.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении i18n.js: {e}")
            success = False

    return success


def update_rust_sources(old_ver: str, new_ver: str) -> bool:
    # Обновление User-Agent в сетевых модулях Rust
    success = True
    for file_path in [DLC_CATALOG_RS, FILES_RS]:
        if file_path.exists():
            try:
                content = file_path.read_text(encoding="utf-8")
                content = re.sub(
                    r'\.user_agent\("EclipseStudio/[^"]+"\)',
                    f'.user_agent("EclipseStudio/{new_ver}")',
                    content,
                )
                file_path.write_text(content, encoding="utf-8")
            except Exception as e:
                print(f"[!] Ошибка при обновлении {file_path.name}: {e}")
                success = False
    return success


def update_tests(old_ver: str, new_ver: str) -> bool:
    # Обновление тестовых фикстур
    success = True
    if TAURI_MOCK_JS.exists():
        try:
            content = TAURI_MOCK_JS.read_text(encoding="utf-8")
            content = content.replace(f'"{old_ver}"', f'"{new_ver}"')
            TAURI_MOCK_JS.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении tauri-mock.js: {e}")
            success = False

    if UI_TEST_JS.exists():
        try:
            content = UI_TEST_JS.read_text(encoding="utf-8")
            content = content.replace(old_ver, new_ver)
            UI_TEST_JS.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении ui.test.js: {e}")
            success = False

    return success


def update_docs(old_ver: str, new_ver: str) -> bool:
    # Обновление документации README.md и BUILD.md
    success = True
    if README_MD.exists():
        try:
            content = README_MD.read_text(encoding="utf-8")
            # Обновление щитов/бейджей версий
            content = re.sub(
                r'Версия-[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?-63f5c2',
                f"Версия-{new_ver}-63f5c2",
                content,
            )
            # Обновление футера и текстовых упоминаний
            content = re.sub(
                r'\*\*Eclipse Studio v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\*\*',
                f"**Eclipse Studio v{new_ver}**",
                content,
            )
            # Обновление имени портативного файла
            content = re.sub(
                r'Eclipse-Studio-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\.exe',
                f"Eclipse-Studio-v{new_ver}.exe",
                content,
            )
            # Обновление ссылок на скачивание
            content = re.sub(
                r'/(?:releases/)?download/v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?/',
                f'/download/v{new_ver}/',
                content,
            )
            README_MD.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении README.md: {e}")
            success = False

    if BUILD_MD.exists():
        try:
            content = BUILD_MD.read_text(encoding="utf-8")
            content = re.sub(
                r'Eclipse Studio v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?',
                f"Eclipse Studio v{new_ver}",
                content,
            )
            content = re.sub(
                r'Eclipse-Studio-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\.exe',
                f"Eclipse-Studio-v{new_ver}.exe",
                content,
            )
            content = re.sub(
                r'(python (?:scripts[\\/])?bump_version\.py\s+)[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?',
                rf"\g<1>{new_ver}",
                content,
            )
            BUILD_MD.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении BUILD.md: {e}")
            success = False

    return success


def update_website(old_ver: str, new_ver: str) -> bool:
    # Обновление версий на промо-сайте docs/index.html и docs/app.js
    success = True
    if DOCS_INDEX_HTML.exists():
        try:
            content = DOCS_INDEX_HTML.read_text(encoding="utf-8")
            # Обновление версий стилей и скриптов в параметрах запроса
            content = re.sub(
                r'(style\.css\?v=)[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?',
                rf'\g<1>{new_ver}',
                content,
            )
            content = re.sub(
                r'(app\.js\?v=)[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?',
                rf'\g<1>{new_ver}',
                content,
            )
            # Бейджи версий в шапке, герое и карточке
            content = re.sub(
                r'(<span class="brand-ver" data-version>v)[^<]+(</span>)',
                rf'\g<1>{new_ver}\g<2>',
                content,
            )
            content = re.sub(
                r'(<span class="mono" data-version>v)[^<]+(</span>)',
                rf'\g<1>{new_ver}\g<2>',
                content,
            )
            content = re.sub(
                r'(<span data-version>v)[^<]+(</span>)',
                rf'\g<1>{new_ver}\g<2>',
                content,
            )
            content = re.sub(
                r'(<span class="badge mono" id="eclipseVersion"[^>]*>v)[^<]+(</span>)',
                rf'\g<1>{new_ver}\g<2>',
                content,
            )
            content = re.sub(
                r'(<strong>Eclipse Studio <span data-version>v)[^<]+(</span></strong>)',
                rf'\g<1>{new_ver}\g<2>',
                content,
            )
            DOCS_INDEX_HTML.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении docs/index.html: {e}")
            success = False

    if DOCS_APP_JS.exists():
        try:
            content = DOCS_APP_JS.read_text(encoding="utf-8")
            content = re.sub(
                r'(\$\{FALLBACK_URL\}\?v=)[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?',
                rf'\g<1>{new_ver}',
                content,
            )
            DOCS_APP_JS.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении docs/app.js: {e}")
            success = False

    return success


def update_capture_tools(old_ver: str, new_ver: str) -> bool:
    # Обновление скриптов снятия скриншотов
    success = True
    for file_path in [CAPTURE_JS]:
        if not file_path.exists():
            continue
        try:
            content = file_path.read_text(encoding="utf-8")
            content = re.sub(
                r'build:\s*"Build\s+[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?"',
                f'build: "Build {new_ver}"',
                content,
            )
            content = re.sub(
                r'Eclipse-Studio-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\.exe',
                f'Eclipse-Studio-v{new_ver}.exe',
                content,
            )
            content = re.sub(
                r'/(?:releases/)?download/v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?/',
                f'/download/v{new_ver}/',
                content,
            )
            content = re.sub(
                r'(current_version|latest_version|currentVersion|latestVersion):\s*"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?"',
                rf'\g<1>: "{new_ver}"',
                content,
            )
            file_path.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении {file_path.name}: {e}")
            success = False
    return success


def update_dev_servers(old_ver: str, new_ver: str) -> bool:
    # Обновление тестовых серверов разработки UI
    success = True
    for file_path in [UI_DEV_JS]:
        if not file_path.exists():
            continue
        try:
            content = file_path.read_text(encoding="utf-8")
            content = re.sub(
                r'build:\s*"Build\s+[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?"',
                f'build: "Build {new_ver}"',
                content,
            )
            content = re.sub(
                r'Eclipse-Studio-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\.exe',
                f'Eclipse-Studio-v{new_ver}.exe',
                content,
            )
            content = re.sub(
                r'/(?:releases/)?download/v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?/',
                f'/download/v{new_ver}/',
                content,
            )
            content = re.sub(
                r'(current_version|latest_version|currentVersion|latestVersion):\s*"[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?"',
                rf'\g<1>: "{new_ver}"',
                content,
            )
            content = re.sub(
                r'title:\s*"Eclipse Studio\s+[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?"',
                f'title: "Eclipse Studio {new_ver}"',
                content,
            )
            file_path.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении {file_path.name}: {e}")
            success = False
    return success


def update_build_helpers(old_ver: str, new_ver: str) -> bool:
    # Обновление скриптов сборки и хелперов релиза
    success = True

    # 1. build.py
    if BUILD_PY.exists():
        try:
            content = BUILD_PY.read_text(encoding="utf-8")
            content = re.sub(
                r'(data\.get\("version",\s*")[^"]+("\))',
                rf'\g<1>{new_ver}\g<2>',
                content,
            )
            content = re.sub(
                r'(return\s*")[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?("\s*#.*Чтение версии)',
                rf'\g<1>{new_ver}\g<3>',
                content,
            )
            BUILD_PY.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении build.py: {e}")
            success = False

    # 2. release.py
    for file_path in [RELEASE_PY]:
        if not file_path.exists():
            continue
        try:
            content = file_path.read_text(encoding="utf-8")
            content = re.sub(
                r'(data\.get\("version",\s*")[^"]+("\))',
                rf'\g<1>{new_ver}\g<2>',
                content,
            )
            content = re.sub(
                r'(return\s*")[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(")',
                rf'\g<1>{new_ver}\g<3>',
                content,
            )
            file_path.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении {file_path.name}: {e}")
            success = False

    # 3. .agents/skills/build/SKILL.md
    if SKILL_BUILD_MD.exists():
        try:
            content = SKILL_BUILD_MD.read_text(encoding="utf-8")
            content = re.sub(
                r'Eclipse-Studio-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\.exe',
                f'Eclipse-Studio-v{new_ver}.exe',
                content,
            )
            content = re.sub(
                r'например `[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?`',
                f'например `{new_ver}`',
                content,
            )
            SKILL_BUILD_MD.write_text(content, encoding="utf-8")
        except Exception as e:
            print(f"[!] Ошибка при обновлении SKILL.md: {e}")
            success = False

    return success


def sync_cargo_lock() -> None:
    # Синхронизация Cargo.lock через cargo check
    print("[*] Синхронизация Cargo.lock...")
    try:
        subprocess.run(
            ["cargo", "check", "--manifest-path", str(CARGO_TOML)],
            cwd=ROOT_DIR,
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        print("[+] Cargo.lock успешно синхронизирован")
    except Exception:
        # Если cargo недоступен в окружении, это не фатально
        pass


def main() -> None:
    print("=" * 60)
    print("  Eclipse Studio — Обновление версии проекта")
    print("=" * 60)

    current_ver = get_current_version()
    print(f"Текущая версия проекта: {current_ver}\n")

    # Получение новой версии из аргументов или интерактивно
    if len(sys.argv) > 1:
        new_ver = sys.argv[1].strip()
    else:
        try:
            new_ver = input("Введите новую версию (например, 8.0.1 или 8.1.0): ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nОтменено.")
            sys.exit(0)

    if not new_ver:
        print("[-] Версия не указана. Отмена.")
        sys.exit(1)

    if not validate_version(new_ver):
        print(f"[-] Некорректный формат версии: '{new_ver}'. Ожидается semver (например, 8.0.1).")
        sys.exit(1)

    if new_ver == current_ver:
        print(f"[-] Версия уже равна {current_ver}. Изменения не требуются.")
        sys.exit(0)

    print(f"\nПрименение новой версии: {current_ver} -> {new_ver}...")

    # Выполнение обновлений всех файлов проекта
    updated_files = []

    if update_json_version(TAURI_CONF, new_ver):
        updated_files.append("src-tauri/tauri.conf.json")
    if update_cargo_toml(new_ver):
        updated_files.append("src-tauri/Cargo.toml")
    if update_json_version(PACKAGE_JSON, new_ver):
        updated_files.append("package.json")
    if PACKAGE_LOCK.exists() and update_json_version(PACKAGE_LOCK, new_ver):
        updated_files.append("package-lock.json")
    if update_html(current_ver, new_ver):
        updated_files.append("ui/index.html")
    if update_js_files(current_ver, new_ver):
        updated_files.append("ui/core/app.js & ui/core/i18n.js")
    if update_rust_sources(current_ver, new_ver):
        updated_files.append("Rust sources (User-Agent)")
    if update_tests(current_ver, new_ver):
        updated_files.append("tests/tauri-mock.js & ui.test.js")
    if update_docs(current_ver, new_ver):
        updated_files.append("README.md & BUILD.md")
    if update_website(current_ver, new_ver):
        updated_files.append("docs/index.html & docs/app.js")
    if update_capture_tools(current_ver, new_ver):
        updated_files.append("scripts/capture_all_screenshots.js")
    if update_dev_servers(current_ver, new_ver):
        updated_files.append("scripts/ui_dev_server.js")
    if update_build_helpers(current_ver, new_ver):
        updated_files.append("scripts/build.py, scripts/release.py & .agents/skills/build/SKILL.md")

    # Синхронизация Cargo.lock
    sync_cargo_lock()
    if (ROOT_DIR / "src-tauri" / "Cargo.lock").exists():
        updated_files.append("src-tauri/Cargo.lock")

    print("\n" + "-" * 60)
    print(f"[+] Версия успешно обновлена с {current_ver} до {new_ver}!")
    print("Обновлённые файлы:")
    for f in updated_files:
        print(f"  • {f}")
    print("-" * 60)
    print("Теперь можно запускать сборку через: python scripts/build.py")


if __name__ == "__main__":
    main()
