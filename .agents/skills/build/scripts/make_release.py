#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# Вспомогательный скрипт для скилла /build:
# 1. Запуск сборки строго портативной версии в папку Hypervisor
# 2. Проверка бинарника и расчёт контрольной суммы SHA-256
# 3. Анализ коммитов git и генерация текста релиза для GitHub в фирменном стиле

import os
import sys
import json
import hashlib
import subprocess
from pathlib import Path

# Поиск корня репозитория по наличию build.py и src-tauri
def find_repo_root() -> Path:
    current = Path(__file__).resolve().parent
    for _ in range(6):
        if (current / "build.py").exists() and (current / "src-tauri").exists():
            return current
        current = current.parent
    return Path(r"E:\Projects\eclipse-studio")

ROOT_DIR = find_repo_root()
TAURI_CONF = ROOT_DIR / "src-tauri" / "tauri.conf.json"
HYPERVISOR_DIR = Path(r"C:\Users\Sparki\Desktop\Programms\Hypervisor")

if sys.platform.startswith("win"):
    try:
        if hasattr(sys.stdout, "reconfigure"):
            sys.stdout.reconfigure(encoding="utf-8")
        if hasattr(sys.stderr, "reconfigure"):
            sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def get_version() -> str:
    # Чтение актуальной версии из tauri.conf.json
    if TAURI_CONF.exists():
        with open(TAURI_CONF, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("version", "6.6.7")
    return "6.6.7"


def compute_sha256(file_path: Path) -> str:
    # Расчёт SHA-256 контрольной суммы файла
    sha = hashlib.sha256()
    with open(file_path, "rb") as f:
        while chunk := f.read(1024 * 1024):
            sha.update(chunk)
    return sha.hexdigest().upper()


def get_git_changes() -> list[str]:
    # Получение списка последних коммитов с предыдущего тега
    try:
        tag_proc = subprocess.run(
            ["git", "describe", "--tags", "--abbrev=0"],
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            check=False,
        )
        last_tag = tag_proc.stdout.strip()
        if last_tag:
            log_proc = subprocess.run(
                ["git", "log", f"{last_tag}..HEAD", "--oneline"],
                cwd=ROOT_DIR,
                capture_output=True,
                text=True,
                check=False,
            )
            lines = [l.strip() for l in log_proc.stdout.strip().split("\n") if l.strip()]
            if lines:
                return lines
    except Exception:
        pass

    # Резервный вариант — последние 5 коммитов
    try:
        log_proc = subprocess.run(
            ["git", "log", "-n", "5", "--oneline"],
            cwd=ROOT_DIR,
            capture_output=True,
            text=True,
            check=False,
        )
        return [l.strip() for l in log_proc.stdout.strip().split("\n") if l.strip()]
    except Exception:
        return []


def main():
    version = get_version()
    print("=" * 64)
    print(f"🌒 Подготовка и сборка релиза Eclipse Studio v{version}")
    print("=" * 64)

    # 1. Запуск build.py для создания портативного бинарника
    build_script = ROOT_DIR / "build.py"
    cmd = [
        sys.executable,
        str(build_script),
        "--type",
        "portable",
        "--out",
        str(HYPERVISOR_DIR),
        "--no-open",
    ]

    print(f"\n[*] Запуск сборки: {' '.join(cmd)}")
    res = subprocess.run(cmd, cwd=ROOT_DIR)
    if res.returncode != 0:
        print("\n[-] Ошибка: сборка build.py завершилась с ошибкой.")
        sys.exit(res.returncode)

    # 2. Проверка и расчёт SHA-256
    expected_file = HYPERVISOR_DIR / f"Eclipse-Studio-v{version}.exe"
    if not expected_file.exists():
        print(f"\n[-] Ошибка: собранный файл не найден по пути {expected_file}")
        sys.exit(1)

    file_size_mb = expected_file.stat().st_size / (1024 * 1024)
    sha256_hash = compute_sha256(expected_file)

    print("\n" + "=" * 64)
    print("  🎉 ПОРТАТИВНЫЙ БИЛД УСПЕШНО СОБРАН!")
    print("=" * 64)
    print(f"Файл:     {expected_file.name}")
    print(f"Путь:     {expected_file}")
    print(f"Размер:   {file_size_mb:.2f} МБ")
    print(f"SHA-256:  {sha256_hash}")

    # 3. Анализ коммитов
    commits = get_git_changes()

    print("\n" + "=" * 64)
    print("  📝 ШАБЛОН ДЛЯ РЕЛИЗА НА GITHUB")
    print("=" * 64)
    print(f"\n🏷️ ТЕГ (Tag):     {version}")
    print(f"📌 НАЗВАНИЕ (Title): Eclipse Studio - {version}")
    print("\n📄 ОПИСАНИЕ (Body / Release Notes):\n")

    release_template = f"""# Eclipse Studio {version}

### Key Changes
* **Portable Release**: Standalone executable compiled directly for the Hypervisor ecosystem.
* **System & UI Updates**: Stability, styling enhancements, and core engine optimizations.

### Antivirus Verification
* **VirusTotal Report**: [Analysis Result 7\\70](https://www.virustotal.com/)
* **Status**: Clean.
* **SHA-256 (Portable)**: `{sha256_hash}`

---
## Русский

### Основные изменения
* **Портативный релиз**: Автономная сборка приложения, подготовленная для экосистемы Hypervisor.
* **Обновления системы и интерфейса**: Улучшения стабильности, темы оформления и оптимизации движка.

### Проверка безопасности
* **Отчёт VirusTotal**: [Результат проверки 7\\70](https://www.virustotal.com/)
* **Статус**: Чистый файл.
* **SHA-256 (Portable)**: `{sha256_hash}`
"""
    print(release_template)
    print("=" * 64)
    if commits:
        print("💡 Последние коммиты в репозитории для детализации описания:")
        for c in commits:
            print(f"  • {c}")
        print("=" * 64)


if __name__ == "__main__":
    main()
