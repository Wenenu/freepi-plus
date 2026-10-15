"""The Antseed provider profile: endpoint, catalog, USDC balance, auth wiring.

Antseed is P2P inference bought with USDC from a local buyer daemon
(``antseed buyer start`` → an OpenAI-compatible proxy on the buyer's machine), so
the things these tests pin are the ones a generic OpenAI-compatible profile would
get wrong:

``plugins/model-providers/antseed/__init__.py``   the profile itself — a loopback
    endpoint with no credential of its own, and the freepi catalog as its floor;
``plugins/model-providers/antseed/antseed.py``    the ported daemon contract: the
    ``antseed`` CLI reads (the USDC balance is on-chain state the HTTP proxy does
    not expose) and the one-line status text, character-for-character what
    freepi-plus renders, so a user running both clients reads one vocabulary;
``hermes_cli/auth.py``                            the registry row, the ``/v1``
    normalization and the no-auth placeholder that make the provider selectable
    at all.

Nothing here spawns the real CLI or reaches the network: the CLI boundary
(``subprocess.run``) and the liveness probe are monkeypatched, which is also how
the "no daemon running" paths get exercised deterministically.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest


# ── Fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def antseed_module():
    """The plugin's own module, loaded by path.

    Plugin directories are not importable packages (``plugins/model-providers/``
    is hyphenated and outside the package layout), so this loads the file the way
    Hermes' plugin loader does — including the ``sys.modules`` registration that
    ``dataclasses`` needs to resolve the module a class was defined in.
    """
    path = (
        Path(__file__).resolve().parents[3]
        / "plugins" / "model-providers" / "antseed" / "antseed.py"
    )
    spec = importlib.util.spec_from_file_location("antseed_plugin_under_test", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def antseed_env(tmp_path, monkeypatch):
    """Isolate every knob the profile reads, so a developer's own daemon and
    config on the machine cannot change what these tests see."""
    home = tmp_path / ".hermes"
    home.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(home))
    for var in ("ANTSEED_BASE_URL", "ANTSEED_API_KEY", "ANTSEED_CLI_COMMAND"):
        monkeypatch.delenv(var, raising=False)
    return home


@pytest.fixture
def antseed_profile(antseed_env):
    """The registered profile, resolved the way the CLI resolves it."""
    import model_tools  # noqa: F401  (registers the plugin loader path first)
    import providers

    profile = providers.get_provider_profile("antseed")
    assert profile is not None, "antseed provider profile must be registered"
    return profile


class _FakeCompleted:
    """Just enough of ``subprocess.CompletedProcess`` for the CLI reader."""

    def __init__(self, stdout: str, returncode: int = 0):
        self.stdout = stdout
        self.stderr = ""
        self.returncode = returncode


def _status_payload(**overrides) -> str:
    payload = {
        "walletAddress": "0x1111111111111111111111111111111111111111",
        "depositsAvailable": 0.45,
        "depositsReserved": 2.0,
        "connectionState": "connected",
        "activeChannels": 3,
    }
    payload.update(overrides)
    return json.dumps(payload)


# ── Registration and endpoint ─────────────────────────────────────────────────


class TestAntseedProfileRegistration:
    def test_registers_the_buyer_daemon_as_the_endpoint(self, antseed_profile):
        assert antseed_profile.name == "antseed"
        assert antseed_profile.display_name == "Antseed"
        assert antseed_profile.api_mode == "chat_completions"
        # The buyer proxy speaks OpenAI-compatible chat completions, so the
        # profile must not claim a transport of its own.
        assert antseed_profile.base_url == "http://127.0.0.1:8377/v1"
        assert antseed_profile.supports_model_listing is True

    def test_every_alias_resolves_to_the_one_profile(self, antseed_env):
        import model_tools  # noqa: F401
        import providers

        canonical = providers.get_provider_profile("antseed")
        for alias in ("antseed", "ant-seed", "antseed-p2p"):
            assert providers.get_provider_profile(alias) is canonical

    def test_endpoint_normalization_accepts_the_bare_host(self, antseed_module):
        """``antseed buyer start`` prints a bare host, and a user will paste it."""
        assert antseed_module.antseed_base_url({}) == "http://127.0.0.1:8377/v1"
        assert antseed_module.antseed_base_url(
            {"ANTSEED_BASE_URL": "http://10.0.0.5:9000/"}
        ) == "http://10.0.0.5:9000/v1"
        assert antseed_module.antseed_base_url(
            {"ANTSEED_BASE_URL": "http://10.0.0.5:9000/v1"}
        ) == "http://10.0.0.5:9000/v1"


# ── Catalog ───────────────────────────────────────────────────────────────────


class TestAntseedCatalog:
    def test_fallback_models_are_the_freepi_catalog(self, antseed_profile):
        models = tuple(antseed_profile.fallback_models)
        assert len(models) == 583, "the bundled freepi catalog is the picker's floor"
        assert "gpt-5.6-luna" in models
        assert "deepseek-v4-flash" in models

    def test_the_live_catalog_wins_when_the_daemon_answers(self, antseed_profile, monkeypatch):
        """``fetch_models()`` reads the buyer daemon's own ``/v1/models``: the
        catalog the peers currently advertise, not the bundled snapshot."""
        class _Response:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def read(self):
                return json.dumps(
                    {"data": [{"id": "deepseek-v4-flash"}, {"id": "gpt-5.6-luna"}]}
                ).encode()

        requested: list[str] = []

        def _open(request, timeout=None):
            requested.append(request.full_url)
            return _Response()

        monkeypatch.setattr("hermes_cli.urllib_security.open_credentialed_url", _open)

        models = antseed_profile.fetch_models(api_key="antseed-local")

        assert requested and requested[0].endswith("/v1/models")
        assert set(models or ()) >= {"deepseek-v4-flash", "gpt-5.6-luna"}


# ── Balance, through the real /usage dispatcher ───────────────────────────────


class TestAntseedBalance:
    def test_the_usage_hook_reports_the_usdc_deposit(self, antseed_profile, monkeypatch):
        from agent.account_usage import fetch_account_usage

        seen: list[str] = []

        def _run(command, **kwargs):
            seen.append(command)
            assert kwargs.get("timeout", 0) <= 8.0, "the read must fit the usage-hook deadline"
            return _FakeCompleted(_status_payload())

        monkeypatch.setattr(subprocess, "run", _run)

        snapshot = fetch_account_usage("antseed")

        assert snapshot is not None
        assert snapshot.provider == "antseed"
        assert snapshot.unavailable_reason is None
        assert any("0.45 USDC" in line for line in snapshot.details)
        assert any("reserved" in line for line in snapshot.details)
        assert any("connected" in line for line in snapshot.details)
        # The live daemon read is tried first, and only it can report the channel state.
        assert seen and "buyer status --json" in seen[0]

    def test_reserved_only_shows_when_something_is_committed(self, antseed_profile, monkeypatch):
        from agent.account_usage import fetch_account_usage

        monkeypatch.setattr(
            subprocess,
            "run",
            lambda command, **kwargs: _FakeCompleted(_status_payload(depositsReserved=0)),
        )

        snapshot = fetch_account_usage("antseed")

        assert snapshot is not None
        assert not any("reserved" in line for line in snapshot.details)

    def test_a_stopped_daemon_fails_open_with_something_to_run(
        self, antseed_profile, monkeypatch
    ):
        """The common case, and it must not read as a broken provider: /usage says
        what to start, and nothing raises."""
        from agent.account_usage import fetch_account_usage

        def _raise(command, **kwargs):
            raise FileNotFoundError("antseed")

        def _urlopen(*args, **kwargs):
            raise OSError("connection refused")

        monkeypatch.setattr(subprocess, "run", _raise)
        monkeypatch.setattr("urllib.request.urlopen", _urlopen)

        snapshot = fetch_account_usage("antseed")

        assert snapshot is not None
        assert snapshot.available is False
        assert "antseed buyer start" in (snapshot.unavailable_reason or "")

    def test_unreadable_output_fails_open(self, antseed_profile, monkeypatch):
        from agent.account_usage import fetch_account_usage

        monkeypatch.setattr(
            subprocess, "run", lambda command, **kwargs: _FakeCompleted("not json at all")
        )

        snapshot = fetch_account_usage("antseed")

        assert snapshot is not None
        assert snapshot.unavailable_reason is not None


# ── The ported display strings ────────────────────────────────────────────────


class TestAntseedStatusLine:
    def test_status_text_matches_freepi(self, antseed_module):
        balance = antseed_module.AntseedBalance(
            address="0x1111111111111111111111111111111111111111",
            available_usd=0.45,
            reserved_usd=2.0,
            connection_state="connected",
            active_channels=3,
        )
        assert antseed_module.format_usdc(0.45) == "$0.45"
        assert antseed_module.format_usdc(None) == "?"
        assert (
            antseed_module.short_model_id("6" * 40 + "@gpt-6.1-sol")
            == f"{'6' * 8}…@gpt-6.1-sol"
        )
        assert antseed_module.antseed_status_text("gpt-6.1-sol", balance) == (
            "[Antseed] gpt-6.1-sol · $0.45 USDC left · $2.00 reserved"
        )
        assert antseed_module.antseed_status_text("gpt-6.1-sol", None) == (
            "[Antseed] gpt-6.1-sol · balance unavailable"
        )

    def test_a_daemon_that_is_not_connected_says_so(self, antseed_module):
        balance = antseed_module.AntseedBalance(available_usd=0.45, connection_state="connecting")
        assert antseed_module.antseed_status_text("gpt-6.1-sol", balance) == (
            "[Antseed] gpt-6.1-sol · $0.45 USDC left · buyer connecting"
        )


# ── Auth wiring: selectable, credential-less, never auto-detected ─────────────


class TestAntseedAuthWiring:
    def test_registry_row_points_at_the_buyer_proxy(self, antseed_env):
        from hermes_cli.auth import PROVIDER_REGISTRY

        row = PROVIDER_REGISTRY["antseed"]
        assert row.name == "Antseed"
        assert row.inference_base_url == "http://127.0.0.1:8377/v1"
        assert row.auth_type == "api_key"

    def test_a_placeholder_key_makes_the_local_daemon_selectable(self, antseed_env):
        from hermes_cli.auth import resolve_api_key_provider_credentials
        from hermes_cli.auth_constants import ANTSEED_NOAUTH_PLACEHOLDER

        creds = resolve_api_key_provider_credentials("antseed")

        assert creds["api_key"] == ANTSEED_NOAUTH_PLACEHOLDER
        assert creds["base_url"] == "http://127.0.0.1:8377/v1"

    def test_env_key_and_base_url_win(self, antseed_env, monkeypatch):
        from hermes_cli.auth import resolve_api_key_provider_credentials

        monkeypatch.setenv("ANTSEED_API_KEY", "sk-real")
        monkeypatch.setenv("ANTSEED_BASE_URL", "http://10.0.0.5:9000")

        creds = resolve_api_key_provider_credentials("antseed")

        assert creds["api_key"] == "sk-real"
        # Normalized to the OpenAI-compatible suffix, exactly as the profile does.
        assert creds["base_url"] == "http://10.0.0.5:9000/v1"

    def test_never_auto_detected_from_the_environment(self, antseed_env):
        """An ANTSEED_API_KEY in the environment must not silently hijack
        inference: the daemon behind it may not even be running."""
        from hermes_cli.auth import _NO_AUTO_DETECT_PROVIDERS

        assert "antseed" in _NO_AUTO_DETECT_PROVIDERS
