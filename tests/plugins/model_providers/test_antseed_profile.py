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
import time
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
    for var in ("ANTSEED_BASE_URL", "ANTSEED_API_KEY", "ANTSEED_CLI_COMMAND",
                "ANTSEED_IDENTITY_HEX", "ANTSEED_AUTOSTART"):
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


def _loaded_plugin_module(profile):
    """The ``antseed.py`` instance the loaded profile actually calls into.

    The ``antseed_module`` fixture loads the file *by path*, which is a second module object
    with its own caches and launch bookkeeping; the profile resolves its relative import
    through the plugin loader, so patching the fixture's copy would patch nothing. Resolved
    through a symbol defined in the sibling (the profile's own module is the package).
    """
    in_sibling = type(profile).status_bar_segment.__globals__["ensure_antseed_daemon"]
    return sys.modules[in_sibling.__globals__["__name__"]]


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
    """The display strings, and the footer line they are rendered through.

    The footer line renders the last reading (or says it is checking) and lets a thread do
    the work: a reading is a CLI spawn plus an on-chain round trip, so it must never block a
    repaint — freepi-plus' contract.
    """

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


    @staticmethod
    def _seed(module, at, text):
        module._STATUS_CACHE.update({"at": at, "text": text, "in_flight": False})

    @staticmethod
    def _settle(module, timeout: float = 5.0):
        """Wait for a spawned refresh to land.

        ``in_flight`` is set by the calling thread and cleared in the same update that stores
        the reading, so waiting for it to clear is exactly waiting for a consistent cache —
        and it keeps one test's background thread from writing over the next test's seed.
        """
        deadline = time.monotonic() + timeout
        while module._STATUS_CACHE.get("in_flight") and time.monotonic() < deadline:
            time.sleep(0.005)
        assert not module._STATUS_CACHE.get("in_flight"), "background refresh never finished"

    def test_first_reading_says_so_then_caches_the_result(self, antseed_module):
        self._seed(antseed_module, 0.0, "")
        reading = lambda: "[Antseed] gpt-6.1-sol · $0.45 USDC left"

        first = antseed_module.antseed_status_line("gpt-6.1-sol", refresh=reading)

        assert first == "[Antseed] gpt-6.1-sol · checking balance…"
        self._settle(antseed_module)
        calls = []
        second = antseed_module.antseed_status_line(
            "gpt-6.1-sol", refresh=lambda: calls.append(1) or "")
        assert second == "[Antseed] gpt-6.1-sol · $0.45 USDC left"
        assert calls == []  # a fresh reading is not read again

    def test_a_stale_reading_refreshes_without_blocking_the_footer(self, antseed_module):
        self._seed(antseed_module, 100.0, "[Antseed] m · $0.45 USDC left")

        line = antseed_module.antseed_status_line(
            "m", clock=lambda: 200.0, refresh=lambda: "[Antseed] m · $0.30 USDC left")

        assert line == "[Antseed] m · $0.45 USDC left"  # the last reading, rendered now
        self._settle(antseed_module)
        assert antseed_module.antseed_status_line("m", clock=lambda: 201.0,
                                                 refresh=lambda: "nope") == "[Antseed] m · $0.30 USDC left"

    def test_a_failed_read_is_retried_after_the_shorter_ttl(self, antseed_module):
        self._seed(antseed_module, 100.0, "")
        calls = []

        inside = antseed_module.antseed_status_line(
            "m", clock=lambda: 105.0, refresh=lambda: calls.append(1) or "")

        assert inside == "[Antseed] m · checking balance…"
        assert calls == []  # inside the failure window: a daemon started now is not hammered
        antseed_module.antseed_status_line(
            "m", clock=lambda: 120.0, refresh=lambda: "[Antseed] m · $0.45 USDC left")
        self._settle(antseed_module)
        assert antseed_module._STATUS_CACHE["text"] == "[Antseed] m · $0.45 USDC left"

    def test_the_profile_serves_the_footer_line_from_its_cache(self, antseed_profile):
        """The real plugin feeds the bar through the profile hook, with no CLI spawn."""
        module = _loaded_plugin_module(antseed_profile)
        self._seed(module, time.monotonic(), "[Antseed] cached · $0.45 USDC left")
        assert antseed_profile.status_bar_segment(model_id="m") == "[Antseed] cached · $0.45 USDC left"
        assert not module._STATUS_CACHE["in_flight"]  # served from cache, no refresh


# ── The buyer identity Hermes reports but never reads ────────────────────────


class TestAntseedIdentity:
    """The daemon owns the wallet key; Hermes only ever says where it found it.

    Antseed's own lookup order is the environment variable, then ``identity.key``
    in the data directory — the Local proxy authenticates by the daemon's on-chain
    identity, so a client credential is not what is missing when inference fails.
    """

    def test_reports_the_key_file_the_daemon_will_use(self, antseed_module, tmp_path, monkeypatch):
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        monkeypatch.delenv("ANTSEED_IDENTITY_HEX", raising=False)
        assert antseed_module.antseed_identity_source() is None

        key = tmp_path / ".antseed" / "identity.key"
        key.parent.mkdir()
        key.write_text("0x" + "ab" * 32, encoding="utf-8")

        assert antseed_module.antseed_identity_source() == str(key)

    def test_environment_wins_and_the_key_itself_is_never_returned(
        self, antseed_module, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        secret = "0x" + "cd" * 32
        monkeypatch.setenv("ANTSEED_IDENTITY_HEX", secret)

        source = antseed_module.antseed_identity_source()

        assert source == "$ANTSEED_IDENTITY_HEX"
        assert secret not in source  # the name of the variable, never its value

    def test_usage_names_the_identity_and_a_missing_one(
        self, antseed_module, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(Path, "home", lambda: tmp_path)
        monkeypatch.delenv("ANTSEED_IDENTITY_HEX", raising=False)
        balance = antseed_module.AntseedBalance(available_usd=0.45, connection_state="connected")

        # Nowhere to read one from: the reason says which two places to put it.
        reason = antseed_module.antseed_unavailable_reason(daemon_reachable=False)
        assert "antseed buyer start" in reason
        assert "identity.key" in reason and "ANTSEED_IDENTITY_HEX" in reason
        assert not any("buyer identity" in line
                       for line in antseed_module.antseed_balance_details(balance))

        key = tmp_path / ".antseed" / "identity.key"
        key.parent.mkdir()
        key.write_text("present", encoding="utf-8")

        assert f"buyer identity: {key}" in antseed_module.antseed_balance_details(balance)
        # And a daemon that is merely stopped is no longer blamed for it.
        assert "identity" not in antseed_module.antseed_unavailable_reason(daemon_reachable=False)


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


# ── Starting the daemon: the one manual step Hermes now covers ───────────────


class TestAntseedDaemonAutostart:
    """``antseed buyer start`` is manual, and its absence does not read as a missing step.

    It reads as a broken provider: the proxy address refuses the connection and the turn
    spends its retries on a daemon that was never there. So Hermes launches one. No test here
    can leave a real daemon behind — the launch seam is injected and the default one refuses
    inside a test process (asserted below).
    """

    @pytest.fixture(autouse=True)
    def _fresh_launch_window(self, antseed_module):
        """A launch in one test must not throttle the next."""
        antseed_module._AUTOSTART.update({"attempted_at": 0.0, "started_at": 0.0})
        yield

    @staticmethod
    def _recorder(launched, ok=True):
        def spawn(command: str) -> bool:
            launched.append(command)
            return ok
        return spawn

    def test_launches_the_daemon_when_nothing_answers(self, antseed_module):
        launched = []
        result = antseed_module.ensure_antseed_daemon(
            probe=lambda _url: False, spawn=self._recorder(launched), env={})

        # False = nothing answers *yet*: the launch deliberately does not wait for the proxy
        # to bind (10+ s on the machine this was built on) — it binds while the refused
        # request is already backing off, which is what turns the first turn into an answer.
        assert result is False
        assert launched == ["antseed buyer start --port 8377"]

    def test_a_proxy_that_answers_is_left_running(self, antseed_module):
        launched = []

        assert antseed_module.ensure_antseed_daemon(
            probe=lambda _url: True, spawn=self._recorder(launched), env={}) is True
        assert launched == []

    def test_a_remote_proxy_never_gets_a_local_daemon(self, antseed_module):
        probed, launched = [], []

        result = antseed_module.ensure_antseed_daemon(
            probe=lambda url: probed.append(url) or False,
            spawn=self._recorder(launched),
            env={"ANTSEED_BASE_URL": "http://10.0.0.5:9000"},
        )

        assert result is False and launched == []
        assert probed == []  # not even asked: somebody else's proxy is not ours to start

    def test_the_daemon_starts_where_the_profile_will_dial(self, antseed_module):
        launched = []

        antseed_module.ensure_antseed_daemon(
            probe=lambda _url: False,
            spawn=self._recorder(launched),
            env={"ANTSEED_BASE_URL": "http://127.0.0.1:9999"},
        )

        assert launched == ["antseed buyer start --port 9999"]

    def test_the_opt_out_keeps_the_manual_step_manual(self, antseed_module):
        launched = []

        assert antseed_module.ensure_antseed_daemon(
            probe=lambda _url: False, spawn=self._recorder(launched),
            env={"ANTSEED_AUTOSTART": "0"}) is False
        assert launched == []
        assert antseed_module.antseed_autostart_enabled({}) is True
        assert antseed_module.antseed_autostart_enabled({"ANTSEED_AUTOSTART": "false"}) is False

    def test_the_cli_ladder_is_the_one_the_balance_read_uses(self, antseed_module):
        """A machine with Node but no global install starts through npx, and
        ``ANTSEED_CLI_COMMAND`` — the same override the balance read honors — wins over both."""
        launched = []

        antseed_module.ensure_antseed_daemon(
            probe=lambda _url: False, spawn=self._recorder(launched, ok=False), env={})

        assert launched == [
            "antseed buyer start --port 8377",
            "npx -y @antseed/cli buyer start --port 8377",
        ]

        launched.clear()
        antseed_module._AUTOSTART["attempted_at"] = 0.0  # the failed pair above throttles
        antseed_module.ensure_antseed_daemon(
            probe=lambda _url: False,
            spawn=self._recorder(launched),
            env={"ANTSEED_CLI_COMMAND": "/opt/antseed/bin/antseed"},
        )

        assert launched == ["/opt/antseed/bin/antseed buyer start --port 8377"]
        assert antseed_module.antseed_cli_commands({}) == ("antseed", "npx -y @antseed/cli")
        assert antseed_module.antseed_cli_commands({"ANTSEED_CLI_COMMAND": " x "}) == ("x",)

    def test_one_launch_per_window_so_the_askers_cannot_storm(self, antseed_module):
        """Client construction and the footer's refresh both ask; the daemon gets one try."""
        launched = []
        spawn = self._recorder(launched)
        now = [100.0]
        later = antseed_module.AUTOSTART_MIN_INTERVAL_S + 0.1

        first = antseed_module.ensure_antseed_daemon(
            probe=lambda _url: False, spawn=spawn, clock=lambda: now[0], env={})
        again = antseed_module.ensure_antseed_daemon(
            probe=lambda _url: False, spawn=spawn, clock=lambda: now[0], env={})
        after = antseed_module.ensure_antseed_daemon(
            probe=lambda _url: False, spawn=spawn, clock=lambda: now[0] + later, env={})

        assert (first, again, after) == (False, False, False)
        assert len(launched) == 2  # the burst collapsed; a daemon still down is retried

    def test_a_launched_daemon_reads_as_starting_rather_than_absent(self, antseed_module):
        balance = antseed_module.AntseedBalance(available_usd=4.55, connection_state="idle")

        assert antseed_module.antseed_status_text("m", balance, daemon_reachable=False) == (
            "[Antseed] m · $4.55 USDC left · daemon down"
        )

        antseed_module.ensure_antseed_daemon(
            probe=lambda _url: False, spawn=self._recorder([]), env={})

        assert antseed_module.antseed_daemon_starting() is True
        assert antseed_module.antseed_status_text("m", balance, daemon_reachable=False) == (
            "[Antseed] m · $4.55 USDC left · starting daemon…"
        )
        # A live daemon's own word for what it is doing, and only then (idle means "no peer
        # pinned yet", which is not a problem worth the pixels while the port is closed).
        assert antseed_module.antseed_status_text("m", balance, daemon_reachable=True) == (
            "[Antseed] m · $4.55 USDC left · buyer idle"
        )

    def test_the_footer_refresh_brings_back_a_daemon_closed_mid_session(
        self, antseed_module, monkeypatch
    ):
        """The status refresh is the one thing that repeats all session, so it is the one
        place that can notice a daemon the user closed and put it back."""
        balance = antseed_module.AntseedBalance(available_usd=4.55, connection_state="idle")
        launched = []
        monkeypatch.setattr(antseed_module, "is_antseed_reachable", lambda *_a, **_k: False)
        monkeypatch.setattr(antseed_module, "fetch_antseed_balance", lambda **_k: balance)
        monkeypatch.setattr(antseed_module, "_spawn_detached",
                            lambda command: launched.append(command) or True)
        TestAntseedStatusLine._seed(antseed_module, 0.0, "")

        line = antseed_module.antseed_status_line("m")  # no injected refresh: the real one

        assert line == "[Antseed] m · checking balance…"
        TestAntseedStatusLine._settle(antseed_module)
        assert launched == ["antseed buyer start --port 8377"]
        assert antseed_module._STATUS_CACHE["text"] == (
            "[Antseed] m · $4.55 USDC left · starting daemon…"
        )

    def test_a_test_process_cannot_launch_a_daemon(self, antseed_module, monkeypatch):
        spawned = []
        monkeypatch.setattr(antseed_module.subprocess, "Popen",
                            lambda *args, **kwargs: spawned.append(args) or None)

        assert antseed_module.ensure_antseed_daemon(probe=lambda _url: False, env={}) is False

        assert not any("buyer start" in str(args) for args in spawned)
        assert antseed_module._AUTOSTART["started_at"] == 0.0  # nothing to report as starting

    def test_building_the_client_is_what_starts_it(self, antseed_profile, monkeypatch):
        """Client construction is the last moment before the first request, once per session."""
        module = _loaded_plugin_module(antseed_profile)
        launched = []
        module._AUTOSTART.update({"attempted_at": 0.0, "started_at": 0.0})
        monkeypatch.setattr(module, "is_antseed_reachable", lambda *_a, **_k: False)
        monkeypatch.setattr(module, "_spawn_detached",
                            lambda command: launched.append(command) or True)

        # None: the profile owns no transport, so the core builds the standard client next.
        assert antseed_profile.create_client(
            api_key="x", base_url="http://127.0.0.1:8377/v1") is None

        assert launched == ["antseed buyer start --port 8377"]

    def test_a_base_url_elsewhere_builds_the_client_without_touching_this_machine(
        self, antseed_profile, monkeypatch
    ):
        module = _loaded_plugin_module(antseed_profile)
        launched = []
        module._AUTOSTART.update({"attempted_at": 0.0, "started_at": 0.0})
        monkeypatch.setattr(module, "_spawn_detached",
                            lambda command: launched.append(command) or True)

        assert antseed_profile.create_client(
            api_key="x", base_url="http://10.0.0.5:9000/v1") is None
        assert launched == []
