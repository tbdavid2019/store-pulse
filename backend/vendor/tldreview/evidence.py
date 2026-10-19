"""Small extracted normalization primitive from the pinned TLDReview boundary.

Store Pulse wraps this module with its own IDs, timestamps and quotas so the
upstream project remains an implementation reference rather than a runtime CLI.
"""
from __future__ import annotations

from typing import Any


def review_text(payload: dict[str, Any]) -> str:
    """Read common Google Places review text fields without inventing content."""
    return str(payload.get("snippet") or payload.get("text") or "").strip()


def review_identifier(payload: dict[str, Any]) -> str | None:
    """Preserve the source review identifier when present."""
    value = payload.get("review_id") or payload.get("id")
    return str(value) if value else None
