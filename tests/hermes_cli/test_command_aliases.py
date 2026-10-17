"""``COMMAND_ALIASES``: freepi's ``anthermes`` is the same installation as ``hermes``.

The alias is a two-line forwarder naming a command inside the checkout — deliberately not a
third ``ENTRY_POINTS`` name — so the canonical commands stay the only ones every repair,
uninstall, sync and PATH path has to own, while any update that renews the canonical launcher
renews the alias's target with it. These tests pin the forwarder's shape, its argv/exit-code
passthrough on the host that runs it, and that a same-named command we did not write is never
taken over.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from hermes_cli import _launchers
from tests.hermes_cli.test_source_launcher_publication import BOOT_FILES

ROOT = Path(__file__).resolve().parents[2]
ALIAS = _launchers.COMMAND_ALIASES[0]


def alias_name() -> str:
    return f"{ALIAS}.cmd" if os.name == "nt" else ALIAS


@pytest.fixture
def checkout(tmp_path):
    root = tmp_path / "checkout"
    (root / ".hermes" / "bin").mkdir(parents=True)
    return root


@pytest.fixture
def out_dir(tmp_path):
    directory = tmp_path / "bin"
    directory.mkdir()
    return directory


def test_alias_records_the_command_it_forwards_to(checkout, out_dir):
    command = [str(checkout / "interpreter"), str(checkout / "hermes")]
    alias = _launchers.publish_command_alias(ALIAS, checkout, out_dir, command)
    assert alias is not None and alias.name == alias_name()
    assert _launchers._alias_command(alias) == command


@pytest.mark.platforms("windows")
def test_windows_alias_hands_argv_and_exit_code_to_its_command(checkout, out_dir, tmp_path):
    shim = tmp_path / "echo-args.cmd"
    shim.write_text("@echo off\r\necho args: %*\r\nexit /b 7\r\n", encoding="ascii")
    alias = _launchers.publish_command_alias(ALIAS, checkout, out_dir, [str(shim), "payload"])
    run = subprocess.run([os.environ.get("COMSPEC", "cmd.exe"), "/c", str(alias), "quoted argument"],
                         capture_output=True, text=True, encoding="utf-8", timeout=60, check=False)
    assert run.returncode == 7, run.stdout + run.stderr
    assert "payload" in run.stdout and "quoted argument" in run.stdout


@pytest.mark.platforms("posix")
def test_posix_alias_hands_argv_and_exit_code_to_its_command(checkout, out_dir, tmp_path):
    shim = tmp_path / "echo-args"
    shim.write_text('#!/bin/sh\nprintf "args: %s\\n" "$@"\nexit 7\n', encoding="utf-8")
    shim.chmod(0o755)
    alias = _launchers.publish_command_alias(ALIAS, checkout, out_dir, [str(shim), "payload"])
    assert alias is not None and os.access(alias, os.X_OK)
    run = subprocess.run([str(alias), "quoted argument"],
                         capture_output=True, text=True, encoding="utf-8", timeout=60, check=False)
    assert run.returncode == 7, run.stdout + run.stderr
    assert "payload" in run.stdout and "quoted argument" in run.stdout


@pytest.mark.platforms("windows", "posix")
def test_alias_never_takes_over_a_command_it_did_not_write(checkout, out_dir):
    """A command of that name from anywhere else is left exactly where it is.

    On Windows that is the ``.cmd`` — the shell twin is a *different* command for a
    different shell, so it stays ours to publish (the same split npm ships).
    """
    target = out_dir / alias_name()
    user_owned = "@echo off\r\nexit /b 19\r\n" if os.name == "nt" else "#!/bin/sh\nexit 19\n"
    target.write_bytes(user_owned.encode("utf-8"))
    published = _launchers.publish_command_alias(ALIAS, checkout, out_dir, [str(checkout / "hermes")])

    assert target.read_bytes() == user_owned.encode("utf-8")
    assert published is None if os.name != "nt" else published == out_dir / ALIAS


@pytest.mark.platforms("windows", "posix")
def test_alias_of_another_checkout_is_left_alone(checkout, out_dir):
    other = checkout.parent / "somewhere-else"
    (other / ".hermes" / "bin").mkdir(parents=True)
    theirs = [str(other / ".hermes" / "bin" / Path(alias_name()).stem)]
    assert _launchers.publish_command_alias(ALIAS, other, out_dir, theirs) is not None
    before = (out_dir / alias_name()).read_bytes()
    # Every token of the existing forwarder lives outside THIS checkout, so it is not ours.
    assert _launchers.publish_command_alias(ALIAS, checkout, out_dir, [str(checkout / "hermes")]) is None
    assert (out_dir / alias_name()).read_bytes() == before


@pytest.mark.platforms("windows")
def test_windows_alias_yields_to_an_exe_of_the_same_name(checkout, out_dir):
    (out_dir / f"{ALIAS}.exe").write_bytes(b"MZ")
    assert _launchers.publish_command_alias(ALIAS, checkout, out_dir, [str(checkout / "hermes")]) is None
    assert not (out_dir / f"{ALIAS}.cmd").exists()


def test_dev_mode_publishes_only_the_alias_bound_to_the_checkout(tmp_path):
    """A tree PM has not built has no durable launcher to name.

    ``--dev`` binds the alias to the checkout's own venv interpreter instead — the same
    pairing ``activate`` uses — and publishes nothing else, so an existing ``hermes``
    command of another installation is left exactly as it is.
    """
    repo = tmp_path / "checkout"
    for relative in BOOT_FILES:
        destination = repo / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / relative, destination)
    (repo / "hermes").write_text("", encoding="utf-8")
    python = repo / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
    python.parent.mkdir(parents=True)
    python.touch()
    out = tmp_path / "commands"
    run = subprocess.run([sys.executable, "-I", str(repo / "hermes_cli/_launchers.py"), str(out), "--dev"],
                         cwd=tmp_path, capture_output=True, text=True, encoding="utf-8", timeout=60, check=False)
    assert run.returncode == 0, run.stdout + run.stderr
    expected = {alias_name()} if os.name == "nt" else {ALIAS}
    if os.name == "nt":
        expected.add(ALIAS)  # plus the shell twin cmd.exe cannot run
    assert {path.name for path in out.iterdir()} == expected
    for name in expected:
        assert _launchers._alias_command(out / name) == [str(python), str(repo / "hermes")]
