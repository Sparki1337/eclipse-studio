#!/usr/bin/env python3
"""Локальная настройка сборочного ключа Ryuu без аргументов и эха ввода."""

import getpass
import os
from pathlib import Path
import sys
import tempfile
import warnings


ROOT = Path(__file__).resolve().parent.parent
MAX_KEY_BYTES = 16 * 1024


def validate_key(value: str) -> str:
    key = value.strip()
    if (
        not key
        or any(not 33 <= ord(char) <= 126 for char in key)
        or len(value.encode("utf-8")) > MAX_KEY_BYTES
    ):
        raise ValueError(
            "Нужен непустой ASCII-ключ без внутренних пробелов; максимум 16384 байта."
        )
    return key


def save_key(value: str, destination: Path) -> Path:
    key = validate_key(value)
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(
        prefix=".ryuu-key-", suffix=".tmp", dir=destination.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
            output.write(key)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
    return destination


def main(argv=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args:
        print(
            "Запускайте скрипт без аргументов: ключ вводится скрыто, не в командной строке.",
            file=sys.stderr,
        )
        return 2
    try:
        # При отсутствии безопасного терминала не допускаем открытый ввод.
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            value = getpass.getpass("Сборочный ключ Ryuu (ввод скрыт): ")
        save_key(value, ROOT / ".secrets" / "ryuu-key.txt")
    except (EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        print("\nСкрытый ввод недоступен или отменён. Используйте обычный терминал.", file=sys.stderr)
        return 1
    except ValueError as error:
        print(f"Ключ не сохранён: {error}", file=sys.stderr)
        return 1
    except OSError:
        print("Не удалось записать локальный файл ключа. Проверьте права доступа.", file=sys.stderr)
        return 1
    print("Ключ сохранён локально: .secrets/ryuu-key.txt (Git игнорирует эту папку).")
    print("Теперь можно запускать обычную сборку. Значение ключа не выводится.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())