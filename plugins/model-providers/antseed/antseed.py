"""Antseed: P2P inference paid in USDC, served by a local buyer daemon.

Antseed (https://antseed.com) is a decentralized inference network on Base L2: a
buyer deposits USDC, and `antseed buyer start` runs an OpenAI-compatible proxy on
``127.0.0.1:8377`` that forwards requests to peers and meters them against that
deposit. The proxy is an ordinary OpenAI-compatible server, so Antseed needs no
transport of its own — this module is what a generic OpenAI-compatible profile
cannot know on its own:

  * where the endpoint lives, and that it is loopback and frequently *not
    running* (``antseed buyer start`` is a manual step), and
  * how much inference it can still pay for, which only the ``antseed`` CLI can
    read (the balance is on-chain state the HTTP endpoint does not expose).

This is a port of freepi-plus' ``src/antseed.ts`` and ``src/antseed-status.ts``,
so both clients speak the same daemon contract:

    antseed buyer status --json    → depositsAvailable, depositsReserved,
                                     walletAddress, connectionState, activeChannels
    antseed buyer balance --json   → depositsAvailable, depositsReserved,
                                     address, walletUSDC

``status`` reads the running daemon's live state; ``balance`` is the dedicated
daemonless read, used when ``status`` yields no balance or the CLI refuses to run.
The CLI itself resolves as ``antseed``, then ``npx -y @antseed/cli``;
``ANTSEED_CLI_COMMAND`` overrides both (a non-PATH install, and the seam tests use
to stay hermetic).

Every read here FAILS OPEN — a missing CLI, a stopped daemon, a timeout or
malformed output all resolve to ``None``/``False`` so a caller can render
"unavailable" instead of taking the session down over a decorative balance line.

Hermes also *starts* the daemon (``ensure_antseed_daemon``): ``antseed buyer start``
is the one manual step in this provider, and a stopped daemon does not look like a
missing step — it looks like a broken provider, because the proxy address refuses the
connection and the turn spends its retries on a daemon that was never there. The
identity the daemon needs is already on the machine, so a session that finds nothing
listening launches one itself (``ANTSEED_AUTOSTART=0`` opts out; the launch never waits,
see ``ensure_antseed_daemon``).
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

logger = logging.getLogger(__name__)

# The buyer proxy's default address. freepi-plus calls this ANTSEED_DEFAULT_BASE_URL.
ANTSEED_DEFAULT_BASE_URL = "http://127.0.0.1:8377"

# The buyer proxy authenticates by the on-chain buyer identity key, so it ignores
# an API key — but the runtime treats a provider with no credential as
# "unconfigured" and refuses to select it. This literal placeholder is what makes
# the provider usable out of the box (and keeps `hermes doctor` honest about the
# daemon, which is the check that actually matters here).
ANTSEED_LOCAL_API_KEY = "antseed-local"

#: CLI invocations tried in order. The npx form is for machines with no global
#: install; `npx` ships with Node, which Antseed's tooling already needs.
ANTSEED_CLI_COMMANDS: tuple[str, ...] = ("antseed", "npx -y @antseed/cli")

DEFAULT_TIMEOUT_MS = 5_000

#: Total time a balance read may spend across every CLI and command it tries.
#: The usage-hook deadline that calls this is 10 s (agent/account_usage.py,
#: PLUGIN_USAGE_HOOK_DEADLINE_S) and a missed deadline shows the user *nothing*,
#: so the budget deliberately sits under it: an unreachable daemon then reads as
#: "unavailable" rather than as a silent empty panel.
DEFAULT_BUDGET_MS = 8_000

#: A liveness probe, not a read: the daemon answers in milliseconds or not at all.
DEFAULT_PROBE_TIMEOUT = 1.5

#: Set to 0/false/no/off to keep Hermes from ever starting the daemon itself — for a user
#: who runs it under their own supervisor, and for whom the manual step is deliberate.
ANTSEED_AUTOSTART_ENV = "ANTSEED_AUTOSTART"

#: `antseed buyer start` is a whole process launch (Electron on the machine this was built
#: on: 12.9 s to bind the proxy), so a launch is never waited on and never repeated inside
#: this window — the calls that ask are per-session and periodic, not one-shot.
AUTOSTART_MIN_INTERVAL_S = 10.0

#: How long a launched daemon is still described as coming up rather than as absent.
AUTOSTART_STARTING_S = 30.0

#: A daemon console left to grow forever is a problem; 5 MB is weeks of it.
DAEMON_LOG_MAX_BYTES = 5 * 1024 * 1024

#: Launch bookkeeping, deliberately not part of ``_STATUS_CACHE`` (which is display state):
#: ``attempted_at`` throttles launches, ``started_at`` is what a reading calls "starting".
_AUTOSTART: dict[str, float] = {"attempted_at": 0.0, "started_at": 0.0}

#: The catalog freepi-plus ships, generated from https://antseedstats.com/network.
#: Used as the provider's `fallback_models`: the live list comes from the buyer
#: daemon's `/v1/models`, and this is what the picker shows when the daemon is not
#: running or is between peers.
CATALOG_PATH = Path(__file__).with_name("antseed_models.json")

_CATALOG_CACHE: tuple[dict[str, str], ...] | None = None


@dataclass(frozen=True)
class AntseedBalance:
    """The buyer's on-chain deposit account, as the antseed CLI reports it.

    ``available_usd`` is spendable right now; ``reserved_usd`` is already
    committed to open payment channels and comes back when a channel closes — so
    "how much is left" is available + reserved, which is why the status line
    shows the two separately rather than as one misleading total. ``wallet_usd``
    is the hot wallet's USDC, not the inference balance, and is context only.
    """

    address: str | None = None
    available_usd: float | None = None
    reserved_usd: float | None = None
    wallet_usd: float | None = None
    connection_state: str | None = None
    active_channels: int | None = None


# ── Endpoint ──────────────────────────────────────────────────────────────────


def antseed_base_url(env: dict[str, str] | None = None) -> str:
    """The buyer proxy's OpenAI-compatible base URL, with its ``/v1`` suffix.

    ``ANTSEED_BASE_URL`` points at a buyer proxy on another host (or a different
    port); freepi-plus normalizes the same way — a trailing slash trimmed and
    ``/v1`` appended unless the value already carries it — so a user migrating
    between the two clients can keep one value in their environment.
    """
    environ = env if env is not None else _environ()
    raw = str(environ.get("ANTSEED_BASE_URL") or "").strip() or ANTSEED_DEFAULT_BASE_URL
    trimmed = raw.rstrip("/")
    return trimmed if trimmed.endswith("/v1") else trimmed + "/v1"


def is_antseed_reachable(
    base_url: str | None = None, timeout: float = DEFAULT_PROBE_TIMEOUT
) -> bool:
    """Whether something that looks like the buyer proxy answers on its address.

    A cheap liveness probe for wording an unavailable balance ("the daemon is not
    running") as opposed to "the daemon is up but the CLI could not report a
    balance". Never raises.
    """
    root = (base_url or antseed_base_url()).rstrip("/")
    for path in ("/health", "/"):
        try:
            with urllib.request.urlopen(root + path, timeout=timeout):
                return True
        except urllib.error.HTTPError:
            # An HTTP error still means a server is listening (a 404 on /health
            # is a proxy that does not implement the alias).
            return True
        except Exception:
            continue
    return False


def is_loopback_url(url: str) -> bool:
    """Whether ``url`` points at this machine — the only place ``buyer start`` applies.

    A non-loopback address is somebody else's proxy, or a tunnel to one: starting a local
    daemon for it would be wrong, and silently so.
    """
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    return host in {"localhost", "127.0.0.1", "::1"} or host.startswith("127.")


def proxy_port(url: str) -> int | None:
    """The explicit port in ``url``, or ``None`` where it carries none."""
    try:
        return urllib.parse.urlparse(url).port
    except ValueError:  # a malformed port is not a port
        return None


# ── Starting the daemon ───────────────────────────────────────────────────────


def antseed_autostart_enabled(env: dict[str, str] | None = None) -> bool:
    """Whether Hermes may start the buyer daemon itself — on unless explicitly turned off."""
    value = str((env if env is not None else _environ()).get(ANTSEED_AUTOSTART_ENV) or "").strip().lower()
    return value not in {"0", "false", "no", "off"}


def antseed_cli_commands(
    env: dict[str, str] | None = None, command: str | None = None
) -> tuple[str, ...]:
    """The CLI invocations to try, in order.

    ``command`` (an explicit caller override) wins, then ``ANTSEED_CLI_COMMAND``, then the
    shared ladder: the global ``antseed`` binary before ``npx -y @antseed/cli``, for the
    machine that has Node but no global install. One definition for the balance read and the
    daemon launch, so both find the same CLI.
    """
    if command:
        return (command,)
    override = str((env if env is not None else _environ()).get("ANTSEED_CLI_COMMAND") or "").strip()
    return (override,) if override else ANTSEED_CLI_COMMANDS


def antseed_start_command(cli: str, *, base_url: str | None = None) -> str:
    """``<cli> buyer start --port <port>`` — the daemon, as the launch command line.

    The port is spelled out from the address this profile will dial, so a non-default
    ``ANTSEED_BASE_URL`` (a second profile, a moved port) starts the daemon where it is
    about to be looked for rather than at the CLI's own default.
    """
    port = proxy_port(base_url or antseed_base_url())
    return f"{cli} buyer start --port {port}" if port else f"{cli} buyer start"


def _daemon_log_path() -> Path:
    """Where a launched daemon's console goes (``~/.antseed/buyer-daemon.log``).

    Not discarded, because the daemon's console is where its peer and handshake failures are
    legible — the diagnostics that explain a proxy that is up but not answering. Truncated
    past :data:`DAEMON_LOG_MAX_BYTES` so it cannot grow without bound.
    """
    return antseed_data_dir() / "buyer-daemon.log"


def _spawn_detached(command: str) -> bool:
    """Run ``command`` in a session of its own so it outlives Hermes. Never raises.

    ``shell=True`` for the same reason the balance read uses it: the fallback invocation is
    the two-word ``npx -y @antseed/cli``, and on Windows the CLI resolves through a ``.cmd``
    shim. A launched daemon that died with the CLI would be pointless, hence the detached
    process group; on Windows it must also not steal the console the TUI is drawing on.

    A test process never launches a real daemon (the repo's convention) — tests that cover
    this path inject their own ``spawn``.
    """
    import os

    if os.environ.get("PYTEST_CURRENT_TEST") or "pytest" in sys.modules:
        logger.debug("antseed: not launching a daemon inside a test process")
        return False

    kwargs: dict[str, Any] = {"shell": True, "stdin": subprocess.DEVNULL}
    if sys.platform == "win32":  # pragma: no cover - platform flag only
        kwargs["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0x00000008) | getattr(
            subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200
        )
    else:
        kwargs["start_new_session"] = True
    try:
        log_path = _daemon_log_path()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        if log_path.is_file() and log_path.stat().st_size > DAEMON_LOG_MAX_BYTES:
            log_path.unlink()
        with log_path.open("ab") as log:
            subprocess.Popen(command, stdout=log, stderr=log, **kwargs)
    except Exception as exc:  # no CLI, no permission, no data dir — all "cannot start"
        logger.debug("antseed: could not launch %r: %s", command, exc)
        return False
    logger.info("antseed: launched the buyer daemon (%s)", command)
    return True


def antseed_daemon_starting(clock: Callable[[], float] | None = None) -> bool:
    """Whether a daemon Hermes launched is still expected to be binding its proxy."""
    started = float(_AUTOSTART.get("started_at") or 0.0)
    return bool(started) and (clock or time.monotonic)() - started < AUTOSTART_STARTING_S


def ensure_antseed_daemon(
    *,
    base_url: str | None = None,
    env: dict[str, str] | None = None,
    probe: Callable[[str], bool] | None = None,
    spawn: Callable[[str], bool] | None = None,
    clock: Callable[[], float] | None = None,
) -> bool:
    """Whether the buyer proxy is being served right now, launching the daemon if it is not.

    Returns immediately either way. ``antseed buyer start`` spends 10+ seconds before its
    proxy binds (the CLI is Electron on the machine this was built on), which is far longer
    than the client construction that calls this may block — so the daemon comes up while
    the request that found the port closed is already in its retry backoff, which is what
    turns a refused first turn into an answer. Callers that must know render
    :func:`antseed_daemon_starting` in the meantime.

    ``False`` therefore means "nothing answers here" — never "the launch failed", which is
    indistinguishable from the outside and, either way, not something a turn can act on.
    Never raises.
    """
    environ = env if env is not None else _environ()
    if not antseed_autostart_enabled(environ):
        return False
    url = base_url or antseed_base_url(environ)
    if not is_loopback_url(url):
        return False
    check = probe or is_antseed_reachable
    if check(url):
        return True
    now = (clock or time.monotonic)()
    if now - float(_AUTOSTART.get("attempted_at") or 0.0) < AUTOSTART_MIN_INTERVAL_S:
        return False
    _AUTOSTART["attempted_at"] = now
    launcher = spawn or _spawn_detached
    for cli in antseed_cli_commands(environ):
        if launcher(antseed_start_command(cli, base_url=url)):
            _AUTOSTART["started_at"] = now
            return False
    return False


#: How the buyer daemon locates its on-chain identity, in Antseed's own order
#: (https://antseed.com/docs/buyer-config/): the environment variable first, then
#: ``identity.key`` inside the data directory.
ANTSEED_IDENTITY_ENV = "ANTSEED_IDENTITY_HEX"

#: The buyer's data directory, next to the CLI's config and state files.
ANTSEED_DATA_DIRNAME = ".antseed"


def antseed_data_dir() -> Path:
    """The buyer daemon's data directory (``~/.antseed``)."""
    return Path.home() / ANTSEED_DATA_DIRNAME


def antseed_identity_source(env: dict[str, str] | None = None) -> str | None:
    """Where the daemon will find its identity, or ``None`` where it will find none.

    Presence only — Hermes never reads the key material. The local proxy authenticates by
    the daemon's on-chain identity rather than by a client credential, so Hermes has no use
    for the key itself; this exists so a balance read can name the piece that is missing
    instead of blaming the CLI, and so ``/usage`` can confirm the key already on the machine
    is the one the daemon is using.
    """
    environ = env if env is not None else _environ()
    if str(environ.get(ANTSEED_IDENTITY_ENV) or "").strip():
        return f"${ANTSEED_IDENTITY_ENV}"
    key = antseed_data_dir() / "identity.key"
    return str(key) if key.is_file() else None


# ── Balance (the `antseed` CLI) ───────────────────────────────────────────────


def fetch_antseed_balance(
    *,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    budget_ms: int = DEFAULT_BUDGET_MS,
    command: str | None = None,
    env: dict[str, str] | None = None,
) -> AntseedBalance | None:
    """Read the buyer's USDC balance. Never raises; ``None`` means "unavailable".

    Tries ``buyer status --json`` first (the live daemon state, which carries the
    deposits balance), then ``buyer balance --json`` (the dedicated daemonless
    read). Both are tried for each CLI in :data:`ANTSEED_CLI_COMMANDS`, in order,
    so a machine with the global CLI absent still reports a balance through npx.

    ``budget_ms`` caps the WHOLE read and each invocation gets the smaller of
    ``timeout_ms`` and what is left of it — an unreachable daemon costs the two
    fast command failures it deserves, not four full timeouts.
    """
    import time

    environ = env if env is not None else _environ()
    commands = antseed_cli_commands(environ, command)

    deadline = time.monotonic() + max(budget_ms, 1) / 1000.0
    for cli in commands:
        for parse, args in (
            (balance_from_status, "buyer status --json"),
            (balance_from_balance, "buyer balance --json"),
        ):
            remaining_ms = int((deadline - time.monotonic()) * 1000)
            if remaining_ms <= 0:
                return None
            balance = parse(_run_json_command(f"{cli} {args}", min(timeout_ms, remaining_ms)))
            if balance is not None:
                return balance
    return None


def balance_from_status(raw: dict[str, Any] | None) -> AntseedBalance | None:
    """``buyer status --json`` → balance, or None when it carries no deposits reading."""
    if not raw:
        return None
    available = _number_field(raw.get("depositsAvailable"))
    if available is None:
        return None
    active = _number_field(raw.get("activeChannels"))
    return AntseedBalance(
        address=_string_field(raw.get("walletAddress")),
        available_usd=available,
        reserved_usd=_number_field(raw.get("depositsReserved")),
        connection_state=_string_field(raw.get("connectionState")),
        active_channels=int(active) if active is not None else None,
    )


def balance_from_balance(raw: dict[str, Any] | None) -> AntseedBalance | None:
    """``buyer balance --json`` → balance, or None when it carries no deposits reading."""
    if not raw:
        return None
    available = _number_field(raw.get("depositsAvailable"))
    if available is None:
        return None
    return AntseedBalance(
        address=_string_field(raw.get("address")),
        available_usd=available,
        reserved_usd=_number_field(raw.get("depositsReserved")),
        wallet_usd=_number_field(raw.get("walletUSDC")),
    )


def _run_json_command(command: str, timeout_ms: int) -> dict[str, Any] | None:
    """Run one antseed CLI invocation and parse its JSON object output, if any.

    ``shell=True`` because the fallback invocation is the two-word
    ``npx -y @antseed/cli``, which is how freepi-plus runs it too (and how a
    Windows ``.cmd`` shim is reachable at all). On Windows the child is spawned
    with CREATE_NO_WINDOW: a balance read must never flash a console over a TUI.
    """
    kwargs: dict[str, Any] = {"shell": True}
    if sys.platform == "win32":  # pragma: no cover - platform flag only
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        completed = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=max(timeout_ms, 1) / 1000.0,
            stdin=subprocess.DEVNULL,
            **kwargs,
        )
    except Exception as exc:  # missing CLI, timeout, permission — all "unavailable"
        logger.debug("antseed: %s failed: %s", command, exc)
        return None
    # The CLI may print a spinner or notice line before the payload, so parse
    # from the first brace rather than requiring pure JSON on stdout.
    return _parse_json_object(completed.stdout or "")


def _parse_json_object(text: str) -> dict[str, Any] | None:
    start = text.find("{")
    if start < 0:
        return None
    try:
        parsed = json.loads(text[start:])
    except Exception:
        return None
    return parsed if isinstance(parsed, dict) else None


def _number_field(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
        return number if number == number and number not in (float("inf"), float("-inf")) else None
    if isinstance(value, str) and value.strip():
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _string_field(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


# ── Display ───────────────────────────────────────────────────────────────────


def format_usdc(value: float | None) -> str:
    """``$0.45``. Two decimals: USDC inference balances are pocket-change scale."""
    return "?" if value is None else f"${value:.2f}"


def short_model_id(model_id: str, max_length: int = 40) -> str:
    """``666e6887…@gpt-6.1-sol`` from a full ``peerId@model`` target.

    A 40-hex peer id would push everything that matters off the edge of a
    one-line status read, so the head is elided and the ``@model`` tail kept.
    """
    label = model_id
    at = model_id.find("@")
    if at > 8:
        label = f"{model_id[:8]}…{model_id[at:]}"
    if len(label) > max_length:
        label = label[: max_length - 1] + "…"
    return label


def antseed_status_text(
    model_id: str, balance: AntseedBalance | None, *, daemon_reachable: bool | None = None
) -> str:
    """The one-line Antseed reading, ported from freepi-plus' status line.

    ``daemon_reachable`` is the proxy's liveness, which the balance cannot tell: the deposits
    are on-chain state the CLI reads while the proxy is stopped, so a funded buyer with no
    daemon would otherwise read as healthy right up until the user sends a message and the
    connection is refused. ``None`` means "not checked" and says nothing about the daemon.
    """
    label = f"[Antseed] {short_model_id(model_id)}"
    if balance is None:
        return f"{label} · balance unavailable"
    parts = [f"{format_usdc(balance.available_usd)} USDC left"]
    if (balance.reserved_usd or 0) > 0:
        parts.append(f"{format_usdc(balance.reserved_usd)} reserved")
    if daemon_reachable is False:
        parts.append("starting daemon…" if antseed_daemon_starting() else "daemon down")
    elif balance.connection_state and balance.connection_state != "connected":
        # A live daemon's own word for what it is doing; meaningless while the port is closed.
        parts.append(f"buyer {balance.connection_state}")
    return f"{label} · {' · '.join(parts)}"


def antseed_status_pending(model_id: str) -> str:
    """Shown while the (cached, asynchronous) balance read is in flight."""
    return f"[Antseed] {short_model_id(model_id)} · checking balance…"


#: How long a reading stays fresh, ported from freepi-plus: a balance is a process spawn plus
#: an on-chain round trip, so it is read at most once a minute — and a *failure* is retried
#: after 15 s instead, so a daemon started moments later shows up.
STATUS_TTL_S = 60.0
STATUS_FAILURE_TTL_S = 15.0

#: The cached reading and the in-flight guard: one refresh at a time, whichever surface asked.
_STATUS_CACHE: dict[str, Any] = {"at": 0.0, "text": "", "in_flight": False}


def antseed_status_line(
    model_id: str,
    *,
    ttl_s: float = STATUS_TTL_S,
    failure_ttl_s: float = STATUS_FAILURE_TTL_S,
    clock: Callable[[], float] | None = None,
    refresh: Callable[[], str] | None = None,
) -> str:
    """The one-line Antseed reading, refreshed in the background — never blocking.

    A footer repaints on every keystroke, so this returns the last reading immediately and
    runs the actual read on a daemon thread, landing on a later repaint. Until the first one
    arrives it says so (``checking balance…``), exactly as freepi-plus does.

    ``clock``/``refresh`` are injectable so a test can drive the TTLs without a daemon.
    """
    import threading
    import time

    now = (clock or time.monotonic)()
    cached_text = str(_STATUS_CACHE.get("text") or "")
    # ``at`` is 0.0 until the first read returns; after that it timestamps the *outcome*,
    # successful or not, which is what decides how soon the next read may run.
    last = float(_STATUS_CACHE.get("at") or 0.0)
    if last and now - last < (ttl_s if cached_text else failure_ttl_s):
        return cached_text or antseed_status_pending(model_id)
    if not _STATUS_CACHE.get("in_flight"):
        _STATUS_CACHE["in_flight"] = True

        def read() -> str:
            reachable = is_antseed_reachable()
            if not reachable:
                # This refresh is the one thing that repeats all session, so it is where a
                # daemon the user closed is noticed — and brought back. The port is known
                # closed here, so the launch skips its own probe.
                ensure_antseed_daemon(probe=lambda _url: False)
            return antseed_status_text(
                model_id, fetch_antseed_balance(), daemon_reachable=reachable
            )

        def _refresh() -> None:
            try:
                text = (refresh or read)()
            except Exception:
                text = ""  # a failed read is remembered briefly, never raised into the footer
            _STATUS_CACHE.update({"at": (clock or time.monotonic)(), "text": text, "in_flight": False})

        threading.Thread(target=_refresh, name="antseed-status", daemon=True).start()
    return cached_text or antseed_status_pending(model_id)


def antseed_unavailable_reason(*, daemon_reachable: bool | None = None) -> str:
    """Why there is no balance to show, in the terms the user can act on.

    A stopped daemon is the overwhelmingly common case (``antseed buyer start``
    is a manual step), so when the address does not answer we say that instead of
    blaming the CLI.
    """
    if daemon_reachable is False:
        reason = "no Antseed buyer daemon is listening — start one with `antseed buyer start`"
    else:
        reason = "the antseed CLI reported no balance (is `antseed` installed, and the buyer funded?)"
    # A daemon with no identity cannot connect or pay, and the user asked to have the key
    # already on the machine used — so name it when it is absent rather than only its symptom.
    if antseed_identity_source() is None:
        reason += (
            f"; no buyer identity is set — put the key at {antseed_data_dir() / 'identity.key'} "
            f"or in ${ANTSEED_IDENTITY_ENV}"
        )
    return reason


def antseed_balance_details(
    balance: AntseedBalance | None,
    *,
    model_id: str | None = None,
    daemon_reachable: bool | None = None,
) -> tuple[str, ...]:
    """The balance as detail lines for an account-usage snapshot.

    Same numbers as :func:`antseed_status_text`, laid out one per line: the
    one-liner is right for a status read but wrong for a panel where the
    reserved/unreserved distinction and the deposit address deserve their own row.
    """
    if balance is None:
        return (antseed_unavailable_reason(daemon_reachable=daemon_reachable),)
    lines = [f"available: {format_usdc(balance.available_usd)} USDC"]
    # Only when something is actually committed — the status line suppresses a zero
    # reserved amount for the same reason, and an all-zero row is noise on /usage.
    if (balance.reserved_usd or 0) > 0:
        lines.append(
            f"reserved: {format_usdc(balance.reserved_usd)} USDC "
            "(committed to open payment channels; returned when they close)"
        )
    if balance.address:
        lines.append(f"deposit account: {balance.address}")
    identity = antseed_identity_source()
    if identity:
        lines.append(f"buyer identity: {identity}")
    if balance.connection_state:
        lines.append(f"buyer daemon: {balance.connection_state}")
    if balance.active_channels is not None:
        lines.append(f"open payment channels: {balance.active_channels}")
    if balance.wallet_usd is not None:
        lines.append(f"wallet USDC (not the inference balance): {format_usdc(balance.wallet_usd)}")
    if model_id:
        lines.append(f"model: {short_model_id(model_id)}")
    return tuple(lines)


# ── Catalog ───────────────────────────────────────────────────────────────────


def catalog_models() -> tuple[dict[str, str], ...]:
    """The bundled Antseed catalog as ``({"id", "name"}, …)``, loaded once.

    The live list comes from the buyer daemon; this is the floor for a picker
    built while the daemon is down (and the set of ids ``hermes model`` can
    resolve by name before any network call).
    """
    global _CATALOG_CACHE
    if _CATALOG_CACHE is None:
        try:
            raw = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
            _CATALOG_CACHE = tuple(
                {"id": str(row["id"]), "name": str(row.get("name") or row["id"])}
                for row in raw
                if isinstance(row, dict) and row.get("id")
            )
        except Exception as exc:  # a damaged asset must not break the provider
            logger.debug("antseed: catalog unavailable: %s", exc)
            _CATALOG_CACHE = ()
    return _CATALOG_CACHE


def catalog_ids() -> tuple[str, ...]:
    """Just the ids, in catalog order — what ``fallback_models`` wants."""
    return tuple(row["id"] for row in catalog_models())


def _environ() -> dict[str, str]:
    import os

    return dict(os.environ)
