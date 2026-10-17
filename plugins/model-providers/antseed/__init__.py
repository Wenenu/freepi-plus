"""Antseed provider profile: P2P inference bought with USDC through a local buyer daemon.

Antseed (https://antseed.com) is a decentralized inference network on Base L2. The
buyer deposits USDC once (``antseed buyer deposit``) and runs ``antseed buyer
start``, which serves an OpenAI-compatible proxy on ``127.0.0.1:8377``, routes
requests to peers and meters them against that deposit. Because the proxy speaks
OpenAI-compatible chat completions, this profile owns NO transport: the generic
chat-completions client serves it, and ``fetch_models()`` reads the daemon's live
``/v1/models``. Everything Antseed-specific lives in the sibling ``antseed.py`` —
the endpoint default, the CLI that reads the USDC balance, and the bundled
catalog the picker falls back to while the daemon is down.

Two consequences worth knowing:

* **No API key, but a credential is required.** The buyer proxy authenticates by
  the on-chain buyer identity key, so it ignores an ``Authorization`` header —
  yet the runtime treats a provider with no credential as unconfigured and will
  not select it. ``hermes_cli/auth.py`` therefore hands this provider a literal
  placeholder key (``ANTSEED_LOCAL_API_KEY``), exactly as freepi-plus does.
* **The balance is not an API.** USDC deposits are on-chain state that the HTTP
  proxy does not expose; only the ``antseed`` CLI can read them, so ``/usage``
  shells out to it. That read fails open — a stopped daemon shows "unavailable"
  and never blocks a turn.
* **Hermes starts the daemon.** ``antseed buyer start`` is a manual step, and its
  absence does not read as a missing step — it reads as a broken provider, because
  the proxy address refuses the connection and the turn burns its retries. So
  ``create_client`` launches one when the port is closed (``ANTSEED_AUTOSTART=0``
  opts out), and the footer's periodic read does the same for a daemon closed
  mid-session.

Ported from freepi-plus (github.com/Wenenu/freepi-plus), where Antseed is the
native inference path, with the two clients sharing one daemon contract.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from providers import register_provider
from providers.base import ProviderProfile

from .antseed import (
    ANTSEED_DEFAULT_BASE_URL,
    antseed_balance_details,
    antseed_base_url,
    antseed_status_line,
    antseed_unavailable_reason,
    catalog_ids,
    ensure_antseed_daemon,
    fetch_antseed_balance,
    is_antseed_reachable,
)


class AntseedProfile(ProviderProfile):
    """Antseed: an OpenAI-compatible loopback proxy with a USDC balance behind it."""

    def create_client(self, **client_kwargs: Any) -> Any | None:
        """Start the buyer daemon if it is down, then let the shared client be built.

        This profile owns no transport — the proxy is OpenAI-compatible — so the one thing
        this hook has to do is the one thing the shared client cannot: ``antseed buyer start``
        is a manual step, and a session that begins without it spends its first request on a
        refused connection and its retries on a daemon that was never there.

        Client construction is the last moment before that request, and it happens once per
        session (and again on a model switch), which is exactly where a cold daemon belongs.
        The launch does not wait for the proxy to bind (10+ s: see ``ensure_antseed_daemon``).
        Returns ``None`` on purpose — the standard client is the right one, and the core
        builds it after this returns.
        """
        ensure_antseed_daemon(base_url=str(client_kwargs.get("base_url") or "") or None)
        return None

    def status_bar_segment(self, *, model_id: str | None = None) -> str | None:
        """Which model, and how much inference is left to pay for — the freepi footer row.

        ``[Antseed] <model> · $0.45 USDC left · $2.00 reserved``: the same one-liner
        freepi-plus shows, with the same split between spendable and channel-committed money.
        Cached and refreshed in the background (``antseed_status_line``), because the reading
        spawns the CLI and the footer repaints far faster than a balance can change.
        """
        return antseed_status_line(str(model_id or ""))

    def fetch_account_usage(
        self, *, base_url: str | None = None, api_key: str | None = None
    ):
        """The buyer's USDC deposit, for ``/usage``.

        Returns an ``AccountUsageSnapshot`` whose ``details`` are the balance rows.
        Windows stay empty on purpose: the free-tier providers express limits as
        percentages of a quota, and Antseed has no quota — it has a balance that
        buys a variable number of tokens, which a percentage would misstate.
        """
        from agent.account_usage import AccountUsageSnapshot

        balance = fetch_antseed_balance()
        if balance is None:
            reachable = is_antseed_reachable(base_url or antseed_base_url())
            return AccountUsageSnapshot(
                provider=self.name,
                source="antseed_buyer_cli",
                fetched_at=datetime.now(timezone.utc),
                title="Antseed balance",
                details=(),
                unavailable_reason=antseed_unavailable_reason(daemon_reachable=reachable),
            )
        return AccountUsageSnapshot(
            provider=self.name,
            source="antseed_buyer_cli",
            fetched_at=datetime.now(timezone.utc),
            title="Antseed balance",
            details=antseed_balance_details(balance),
        )


register_provider(
    AntseedProfile(
        name="antseed",
        display_name="Antseed",
        description="Antseed P2P inference — per-request USDC paid from your local buyer daemon",
        signup_url="https://antseed.com",
        aliases=("ant-seed", "antseed-p2p"),
        base_url=ANTSEED_DEFAULT_BASE_URL + "/v1",
        env_vars=("ANTSEED_API_KEY",),
        # The bundled freepi catalog, used when the daemon is not answering (or is
        # between peers). The live list always wins when it can be fetched.
        fallback_models=catalog_ids(),
    )
)
