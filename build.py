#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Скрипт сборки проекта Eclipse Studio с выбором типа и сохранением пути выгрузки

import os
import sys
import json
import shutil
import hashlib
import argparse
import subprocess
from pathlib import Path

# Корень проекта и конфигурация
ROOT_DIR = Path(__file__).resolve().parent
CONFIG_FILE = ROOT_DIR / "build_config.json"
TAURI_CONF = ROOT_DIR / "src-tauri" / "tauri.conf.json"

# Настройка UTF-8 для консоли Windows
if sys.platform.startswith("win"):
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Типы сборки
BUILD_TYPES = {
    "1": ("portable", "Portable EXE (портативная версия, cargo release)"),
    "2": ("nsis", "NSIS Setup (установщик Windows, tauri bundle)"),
    "3": ("all", "Полная сборка (Portable EXE + NSIS Setup)"),
    "4": ("debug", "Debug билд (быстрая компиляция для отладки)"),
}


def load_config() -> dict:
    # Загрузка сохранённых настроек сборщика
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_config(config: dict) -> None:
    # Сохранение настроек в build_config.json
    try:
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
            f.write("\n")
    except Exception as e:
        print(f"[!] Не удалось сохранить конфигурацию: {e}")


def get_project_version() -> str:
    # Чтение версии приложения
    if TAURI_CONF.exists():
        try:
            with open(TAURI_CONF, "r", encoding="utf-8") as f:
                data = json.load(f)
                return data.get("version", "6.0.0")
        except Exception:
            pass
    return "6.0.0"


def check_tool(name: str) -> bool:
    # Проверка наличия утилиты в PATH
    return shutil.which(name) is not None


def check_prerequisites(build_type: str) -> bool:
    # Проверка окружения перед сборкой
    print("[*] Проверка системного окружения...")
    ok = True

    if not check_tool("cargo") or not check_tool("rustc"):
        print("[-] Ошибка: Rust / Cargo не найдены в системном PATH.")
        print("    Установите Rust через https://rustup.rs/")
        ok = False

    if build_type in ("nsis", "all"):
        if not check_tool("npm") and not check_tool("node"):
            print("[-] Ошибка: Node.js / npm не найдены в PATH.")
            print("    Установите Node.js через https://nodejs.org/")
            ok = False

    # Проверка ключевых ассетов
    smokeapi_dll = ROOT_DIR / "SmokeAPI" / "SmokeAPI64.dll"
    creamapi_dll = ROOT_DIR / "CreamAPI" / "steam_api64.dll"
    millennium_dist = (
        ROOT_DIR
        / "src-tauri"
        / "src"
        / "assets"
        / "eclipse-manifest"
        / ".millennium"
        / "Dist"
        / "index.js"
    )

    if not smokeapi_dll.exists():
        print(f"[!] Предупреждение: не найден файл {smokeapi_dll}")
    if not creamapi_dll.exists():
        print(f"[!] Предупреждение: не найден файл {creamapi_dll}")
    if not millennium_dist.exists():
        print(f"[!] Предупреждение: не найден скрытый файл плагина {millennium_dist}")

    return ok


def select_build_type(args_type: str | None, last_type: str | None) -> str:
    # Выбор типа сборки (из аргументов или меню)
    if args_type:
        val = args_type.lower()
        valid = {"portable", "nsis", "all", "debug"}
        if val in valid:
            return val
        print(f"[!] Неизвестный тип сборки '{args_type}'. Используйте: {', '.join(valid)}")

    print("\nВыберите тип сборки:")
    default_key = "1"
    for k, (name, desc) in BUILD_TYPES.items():
        mark = " (по умолчанию)" if (last_type == name or (not last_type and k == default_key)) else ""
        print(f"  [{k}] {desc}{mark}")

    while True:
        try:
            choice = input("\nНомер варианта [1-4, Enter для выбора по умолчанию]: ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nОтменено.")
            sys.exit(0)

        if not choice:
            if last_type:
                for k, (name, _) in BUILD_TYPES.items():
                    if name == last_type:
                        return name
            return BUILD_TYPES[default_key][0]

        if choice in BUILD_TYPES:
            return BUILD_TYPES[choice][0]
        print("[-] Неверный выбор. Введите число от 1 до 4.")


def select_output_dir(args_out: str | None, saved_dir: str | None) -> Path:
    # Выбор директории для выгрузки готовых файлов
    if args_out:
        out_path = Path(args_out).resolve()
        out_path.mkdir(parents=True, exist_ok=True)
        return out_path

    print("\nРасположение для сохранения готовых файлов:")
    default_hint = saved_dir if saved_dir else str(ROOT_DIR / "dist")

    prompt = f"Укажите путь к папке [Enter для '{default_hint}']: "
    try:
        user_input = input(prompt).strip()
    except (KeyboardInterrupt, EOFError):
        print("\nОтменено.")
        sys.exit(0)

    target_str = user_input if user_input else default_hint
    target_path = Path(target_str).resolve()

    try:
        target_path.mkdir(parents=True, exist_ok=True)
    except Exception as e:
        print(f"[!] Ошибка при создании папки '{target_path}': {e}")
        print("    Используется папка по умолчанию: dist/")
        target_path = ROOT_DIR / "dist"
        target_path.mkdir(parents=True, exist_ok=True)

    return target_path


def compute_sha256(file_path: Path) -> str:
    # Расчет контрольной суммы SHA-256 с повторными попытками (на случай сканирования файла антивирусом)
    import time
    for attempt in range(10):
        try:
            hasher = hashlib.sha256()
            with open(file_path, "rb") as f:
                while chunk := f.read(65536):
                    hasher.update(chunk)
            return hasher.hexdigest()
        except PermissionError:
            time.sleep(0.5)
    hasher = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(65536):
            hasher.update(chunk)
    return hasher.hexdigest()


def format_size(bytes_count: int) -> str:
    # Человекочитаемый размер файла
    mb = bytes_count / (1024 * 1024)
    return f"{mb:.2f} МБ"


def run_command(cmd: list[str], cwd: Path) -> bool:
    # Запуск команды с прямым выводом в консоль
    cmd_str = " ".join(cmd)
    print(f"\n>> Запуск: {cmd_str}\n")
    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=sys.stdout,
            stderr=sys.stderr,
            shell=sys.platform.startswith("win"),
        )
        ret = proc.wait()
        return ret == 0
    except Exception as e:
        print(f"[-] Ошибка выполнения команды: {e}")
        return False


def build_portable(manifest_path: Path) -> bool:
    # Сборка портативного бинарника через Cargo release
    cmd = ["cargo", "build", "--release", "--manifest-path", str(manifest_path)]
    return run_command(cmd, ROOT_DIR)


def build_debug(manifest_path: Path) -> bool:
    # Сборка debug-бинарника через Cargo
    cmd = ["cargo", "build", "--manifest-path", str(manifest_path)]
    return run_command(cmd, ROOT_DIR)


def build_nsis() -> bool:
    # Сборка инсталлятора через Tauri CLI
    # Пробуем npx @tauri-apps/cli или npm run build
    cmd = ["npm", "run", "build", "--", "--bundles", "nsis"]
    return run_command(cmd, ROOT_DIR)


def collect_artifacts(build_type: str, version: str, out_dir: Path) -> list[dict]:
    # Поиск и копирование собранных файлов в целевую папку
    collected = []
    target_rel = ROOT_DIR / "src-tauri" / "target" / "release"
    target_deb = ROOT_DIR / "src-tauri" / "target" / "debug"

    # Портативный релизный EXE
    if build_type in ("portable", "all"):
        exe_src = target_rel / "eclipse-studio.exe"
        if exe_src.exists():
            dst_name = f"Eclipse-Studio-v{version}-Portable.exe"
            dst_path = out_dir / dst_name
            sha = compute_sha256(exe_src)
            shutil.copy2(exe_src, dst_path)
            collected.append({
                "type": "Portable EXE",
                "filename": dst_name,
                "path": dst_path,
                "size": format_size(exe_src.stat().st_size),
                "sha256": sha,
            })

    # NSIS инсталлятор
    if build_type in ("nsis", "all"):
        nsis_dir = target_rel / "bundle" / "nsis"
        if nsis_dir.exists():
            installers = list(nsis_dir.glob("*.exe"))
            for inst in installers:
                dst_name = f"Eclipse-Studio-v{version}-Setup.exe"
                dst_path = out_dir / dst_name
                sha = compute_sha256(inst)
                shutil.copy2(inst, dst_path)
                collected.append({
                    "type": "NSIS Setup",
                    "filename": dst_name,
                    "path": dst_path,
                    "size": format_size(inst.stat().st_size),
                    "sha256": sha,
                })

    # Debug EXE
    if build_type == "debug":
        exe_src = target_deb / "eclipse-studio.exe"
        if exe_src.exists():
            dst_name = f"Eclipse-Studio-v{version}-Debug.exe"
            dst_path = out_dir / dst_name
            shutil.copy2(exe_src, dst_path)
            collected.append({
                "type": "Debug EXE",
                "filename": dst_name,
                "path": dst_path,
                "size": format_size(dst_path.stat().st_size),
                "sha256": compute_sha256(dst_path),
            })

    return collected


def main() -> None:
    parser = argparse.ArgumentParser(description="Сборка проекта Eclipse Studio")
    parser.add_argument(
        "--type",
        "-t",
        choices=["portable", "nsis", "all", "debug"],
        help="Тип сборки (portable, nsis, all, debug)",
    )
    parser.add_argument(
        "--out",
        "-o",
        help="Папка для сохранения готовых файлов",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Очистить target перед сборкой (cargo clean)",
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="Не открывать проводник после завершения",
    )
    args = parser.parse_args()

    print("=" * 64)
    print("  🌒 Eclipse Studio — Автоматическая сборка проекта")
    print("=" * 64)

    config = load_config()
    version = get_project_version()
    print(f"Версия проекта: {version}")

    # Определение типа сборки и папки выгрузки
    build_type = select_build_type(args.type, config.get("last_build_type"))
    output_dir = select_output_dir(args.out, config.get("output_dir"))

    # Сохранение выбора
    config["output_dir"] = str(output_dir)
    config["last_build_type"] = build_type
    save_config(config)

    print(f"\n[+] Тип сборки:   {build_type.upper()}")
    print(f"[+] Папка выгрузки: {output_dir}")

    # Проверка инструментов
    if not check_prerequisites(build_type):
        print("\n[-] Сборка прервана из-за отсутствия обязательных компонентов.")
        sys.exit(1)

    # Очистка при необходимости
    manifest = ROOT_DIR / "src-tauri" / "Cargo.toml"
    if args.clean:
        print("\n[*] Очистка предыдущих артефактов (cargo clean)...")
        run_command(["cargo", "clean", "--manifest-path", str(manifest)], ROOT_DIR)

    # Запуск компиляции
    print(f"\n[*] Начало сборки ({build_type})... Это может занять некоторое время.")
    success = False

    if build_type == "portable":
        success = build_portable(manifest)
    elif build_type == "nsis":
        success = build_nsis()
    elif build_type == "all":
        print("\n[1/2] Сборка NSIS инсталлятора...")
        nsis_ok = build_nsis()
        print("\n[2/2] Сборка Portable EXE...")
        port_ok = build_portable(manifest)
        success = nsis_ok and port_ok
    elif build_type == "debug":
        success = build_debug(manifest)

    if not success:
        print("\n" + "!" * 64)
        print("[-] Ошибка: сборка завершилась с ошибкой.")
        print("!" * 64)
        sys.exit(1)

    # Копирование артефактов
    artifacts = collect_artifacts(build_type, version, output_dir)

    if not artifacts:
        print("\n[-] Предупреждение: сборка завершилась, но готовые бинарники не найдены.")
        print("    Проверьте папку src-tauri/target/release/")
        sys.exit(1)

    # Вывод результатов
    print("\n" + "=" * 64)
    print("  🎉 СБОРКА УСПЕШНО ЗАВЕРШЕНА!")
    print("=" * 64)
    for art in artifacts:
        print(f"\nФайл:     {art['filename']}")
        print(f"Тип:      {art['type']}")
        print(f"Размер:   {art['size']}")
        print(f"Путь:     {art['path']}")
        print(f"SHA-256:  {art['sha256']}")

    print("\n" + "-" * 64)
    print(f"Все файлы сохранены в: {output_dir}")
    print("-" * 64)

    # Открытие папки в проводнике Windows
    if not args.no_open and sys.platform.startswith("win"):
        try:
            open_folder = input("Открыть папку с файлами в Проводнике? [Y/n]: ").strip().lower()
            if open_folder in ("", "y", "yes", "д", "да"):
                os.startfile(str(output_dir))
        except (KeyboardInterrupt, EOFError):
            pass


if __name__ == "__main__":
    main()
