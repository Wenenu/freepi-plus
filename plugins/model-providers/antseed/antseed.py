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
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
    if command:
        commands: tuple[str, ...] = (command,)
    else:
        override = str(environ.get("ANTSEED_CLI_COMMAND") or "").strip()
        commands = (override,) if override else ANTSEED_CLI_COMMANDS

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


def antseed_status_text(model_id: str, balance: AntseedBalance | None) -> str:
    """The one-line Antseed reading, ported from freepi-plus' status line."""
    label = f"[Antseed] {short_model_id(model_id)}"
    if balance is None:
        return f"{label} · balance unavailable"
    parts = [f"{format_usdc(balance.available_usd)} USDC left"]
    if (balance.reserved_usd or 0) > 0:
        parts.append(f"{format_usdc(balance.reserved_usd)} reserved")
    if balance.connection_state and balance.connection_state != "connected":
        parts.append(f"buyer {balance.connection_state}")
    return f"{label} · {' · '.join(parts)}"


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
