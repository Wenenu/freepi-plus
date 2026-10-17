"""Invariant tests for the provider-owned status-bar field.

A provider knows one thing the bar cannot work out for itself — how much inference is left
behind the model it is already showing (Antseed's USDC balance). It contributes it through
``ProviderProfile.status_bar_segment``, the bar renders it as an opt-in field, and a provider
that has nothing to say, no profile, or a raising hook leaves the footer exactly as it was.
"""

from datetime import datetime, timedelta

import pytest

from cli import HermesCLI
from hermes_cli import status_bar_provider


class _Profile:
    def __init__(self, value):
        self.value = value

    def status_bar_segment(self, *, model_id=None):
        return self.value


def _make_cli(provider="antseed"):
    cli_obj = HermesCLI.__new__(HermesCLI)
    cli_obj.model = "deepseek-v4.1-flash"
    cli_obj.provider = provider
    cli_obj.session_start = datetime.now() - timedelta(minutes=3)
    cli_obj.conversation_history = [{"role": "user", "content": "hi"}]
    cli_obj.agent = None
    return cli_obj


def test_no_provider_contributes_nothing():
    assert status_bar_provider.provider_status_segment(None) == ""
    assert status_bar_provider.provider_status_segment("") == ""


def test_the_profiles_segment_is_returned(monkeypatch):
    monkeypatch.setattr("providers.get_provider_profile",
                        lambda name: _Profile("[Antseed] deepseek-v4.1-flash · $5.55 USDC left"))
    assert status_bar_provider.provider_status_segment("antseed", "deepseek-v4.1-flash") == (
        "[Antseed] deepseek-v4.1-flash · $5.55 USDC left")


def test_an_unknown_provider_or_a_raising_hook_never_breaks_the_footer(monkeypatch):
    monkeypatch.setattr("providers.get_provider_profile", lambda name: None)
    assert status_bar_provider.provider_status_segment("antseed") == ""

    def boom(name):
        raise RuntimeError("this provider's hook is broken")

    monkeypatch.setattr("providers.get_provider_profile", boom)
    assert status_bar_provider.provider_status_segment("antseed") == ""


def test_the_segment_renders_beside_the_model_and_a_custom_field_list_can_hide_it(monkeypatch):
    """An unset field list shows everything, so the balance appears with no config; listing
    fields without ``provider`` pays for no hook at all and renders nothing."""
    line = "[Antseed] deepseek-v4.1-flash · $5.55 USDC left"
    calls = []

    def hook(provider, model_id=""):
        calls.append(provider)
        return line

    monkeypatch.setattr("hermes_cli.status_bar_provider.provider_status_segment", hook)

    default = _make_cli()
    default._status_bar_field_set_cache = None
    snapshot = default._get_status_bar_snapshot()
    assert calls == ["antseed"]
    parts = ["".join(t for _, t in seg) for seg in default._status_bar_segments(
        snapshot, 120, None, False, styled=False)]
    assert parts[:2] == ["☤ deepseek-v4.1-flash", line]

    fields = frozenset({"model", "duration"})
    hidden = _make_cli()
    hidden._status_bar_field_set_cache = fields
    snapshot2 = hidden._get_status_bar_snapshot()
    assert snapshot2["provider_segment"] == ""
    assert calls == ["antseed"]  # not consulted again: nobody would see the segment
    text = "".join(t for seg in hidden._status_bar_segments(
        snapshot2, 120, fields, False, styled=False) for _, t in seg)
    assert "USDC" not in text
