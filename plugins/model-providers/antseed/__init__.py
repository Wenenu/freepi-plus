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

Ported from freepi-plus (github.com/Wenenu/freepi-plus), where Antseed is the
native inference path, with the two clients sharing one daemon contract.
"""

from __future__ import annotations

from datetime import datetime, timezone

from providers import register_provider
from providers.base import ProviderProfile

from .antseed import (
    ANTSEED_DEFAULT_BASE_URL,
    antseed_balance_details,
    antseed_base_url,
    antseed_unavailable_reason,
    catalog_ids,
    fetch_antseed_balance,
    is_antseed_reachable,
)


class AntseedProfile(ProviderProfile):
    """Antseed: an OpenAI-compatible loopback proxy with a USDC balance behind it."""

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
