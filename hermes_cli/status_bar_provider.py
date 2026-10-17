"""The active provider's own status-bar segment for the CLI footer.

Hermes owns the bar; a provider owns the one reading the bar cannot make for itself — how
much inference is left behind the model it is already showing, which for Antseed is a USDC
balance living behind a local daemon. ``ProviderProfile.status_bar_segment`` is the hook, and
its contract is that it returns promptly: the footer repaints on every keystroke, so the
implementation caches and refreshes in the background (see the Antseed profile).

Kept beside ``status_bar_git`` because it is the same shape: a gated field the snapshot
builder fills only when the user asked for it.
"""

from __future__ import annotations

from typing import Optional


def provider_status_segment(provider: Optional[str], model_id: str = "") -> str:
    """The segment ``provider`` contributes, or ``""`` when it contributes none.

    A provider with no profile, no hook or a raising hook yields an empty segment: a missing
    footer nicety is never worth breaking the prompt line over.
    """
    name = str(provider or "").strip()
    if not name:
        return ""
    try:
        import providers  # noqa: PLC0415  (registers nothing; the lookup is the point)

        profile = providers.get_provider_profile(name)
        if profile is None:
            return ""
        return str(profile.status_bar_segment(model_id=model_id) or "")
    except Exception:
        return ""
