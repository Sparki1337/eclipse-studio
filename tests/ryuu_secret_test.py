#!/usr/bin/env python3
"""Проверки приватной сборочной конфигурации; только фиктивные ключи."""

import contextlib
import getpass
import importlib.util
import io
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location(
    "set_ryuu_key", ROOT / "scripts" / "set_ryuu_key.py"
)
SETUP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SETUP)
FIXTURE = "test-only-private-key"


class ValidationTests(unittest.TestCase):
    def test_accepts_dummy_key(self):
        self.assertEqual(SETUP.validate_key(FIXTURE), FIXTURE)

    def test_trims_outer_whitespace(self):
        self.assertEqual(SETUP.validate_key(" \t" + FIXTURE + "\r\n"), FIXTURE)

    def test_rejects_empty_values(self):
        for value in ("", " ", "\r\n\t"):
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                SETUP.validate_key(value)

    def test_rejects_internal_whitespace(self):
        for char in (" ", "\t", "\n", "\r"):
            with self.subTest(char=repr(char)), self.assertRaises(ValueError):
                SETUP.validate_key("first" + char + "second")

    def test_rejects_control_characters(self):
        for char in ("\x00", "\x1b", "\x7f"):
            with self.subTest(char=repr(char)), self.assertRaises(ValueError):
                SETUP.validate_key("first" + char + "second")

    def test_rejects_non_ascii(self):
        for value in ("ключ", "test-\udcff-key"):
            with self.subTest(value=repr(value)), self.assertRaises(ValueError):
                SETUP.validate_key(value)

    def test_size_limit(self):
        self.assertEqual(len(SETUP.validate_key("a" * SETUP.MAX_KEY_BYTES)), SETUP.MAX_KEY_BYTES)
        with self.assertRaises(ValueError):
            SETUP.validate_key("a" * (SETUP.MAX_KEY_BYTES + 1))


class SaveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.destination = self.root / ".secrets" / "ryuu-key.txt"

    def test_writes_normalized_value_without_newline(self):
        SETUP.save_key(" " + FIXTURE + "\n", self.destination)
        self.assertEqual(self.destination.read_bytes(), FIXTURE.encode("ascii"))

    def test_overwrites_atomically_without_leaving_temporary_files(self):
        SETUP.save_key("test-only-old-key", self.destination)
        SETUP.save_key(FIXTURE, self.destination)
        self.assertEqual(self.destination.read_text(), FIXTURE)
        self.assertEqual([item.name for item in self.destination.parent.iterdir()], ["ryuu-key.txt"])

    def test_invalid_input_does_not_overwrite_existing_key(self):
        SETUP.save_key(FIXTURE, self.destination)
        with self.assertRaises(ValueError):
            SETUP.save_key("", self.destination)
        self.assertEqual(self.destination.read_text(), FIXTURE)

    @unittest.skipIf(os.name == "nt", "Windows использует ACL вместо POSIX-прав")
    def test_local_file_has_private_posix_permissions(self):
        SETUP.save_key(FIXTURE, self.destination)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.destination.parent.stat().st_mode), 0o700)

    def test_failed_replace_cleans_temporary_file(self):
        with mock.patch.object(SETUP.os, "replace", side_effect=OSError("test-only-error")):
            with self.assertRaises(OSError):
                SETUP.save_key(FIXTURE, self.destination)
        self.assertEqual(list(self.destination.parent.iterdir()), [])

    def run_main(self, args, value=None, error=None):
        output = io.StringIO()
        with (
            mock.patch.object(SETUP, "ROOT", self.root),
            mock.patch.object(SETUP.getpass, "getpass", return_value=value, side_effect=error),
            contextlib.redirect_stdout(output),
            contextlib.redirect_stderr(output),
        ):
            result = SETUP.main(args)
        self.assertNotIn(FIXTURE, output.getvalue())
        return result, output.getvalue()

    def test_interactive_setup_never_prints_key(self):
        result, output = self.run_main([], value=FIXTURE)
        self.assertEqual(result, 0)
        self.assertIn(".secrets/ryuu-key.txt", output)
        self.assertEqual(self.destination.read_text(), FIXTURE)

    def test_secret_is_not_accepted_as_argument(self):
        result, _ = self.run_main([FIXTURE])
        self.assertEqual(result, 2)
        self.assertFalse(self.destination.exists())

    def test_cancellation_does_not_create_key(self):
        result, _ = self.run_main([], error=KeyboardInterrupt())
        self.assertEqual(result, 1)
        self.assertFalse(self.destination.exists())

    def test_unavailable_hidden_input_does_not_create_key(self):
        result, _ = self.run_main([], error=getpass.GetPassWarning())
        self.assertEqual(result, 1)
        self.assertFalse(self.destination.exists())

    def test_invalid_input_is_not_echoed(self):
        result, _ = self.run_main([], value=FIXTURE + "\nother")
        self.assertEqual(result, 1)
        self.assertFalse(self.destination.exists())


@unittest.skipUnless(shutil.which("git"), "Для проверки .gitignore нужен Git")
class GitIgnoreTests(unittest.TestCase):
    def test_git_add_all_excludes_local_and_generated_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = Path(temporary)
            shutil.copyfile(ROOT / ".gitignore", repo / ".gitignore")
            paths = (
                ".secrets/ryuu-key.txt",
                ".secrets/.ryuu-key-temporary.tmp",
                "ryuu-builtin-key.txt",
                "src-tauri/target/debug/build/test/out/ryuu-builtin-key.txt",
                "src-tauri/src/public-example.rs",
            )
            for relative in paths:
                target = repo / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("// test-only-placeholder\n", encoding="utf-8")
            subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "add", "--all"], cwd=repo, check=True, capture_output=True)
            tracked = subprocess.check_output(["git", "ls-files"], cwd=repo, text=True).splitlines()
            self.assertEqual(tracked, [".gitignore", "src-tauri/src/public-example.rs"])


if __name__ == "__main__":
    unittest.main(verbosity=2)