"""Google Places review normalization and evidence handling for Store Pulse.

The request boundary preserves review identifiers and dates so the UI can show
exactly which sample supports an operational observation.
"""
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional
from urllib.parse import urlparse

from .vendor.tldreview import SOURCE_SHA
from .vendor.tldreview.evidence import review_identifier, review_text


class ReviewError(RuntimeError):
    """A place binding or evidence normalization error."""


@dataclass(frozen=True)
class Review:
    provider_review_id: Optional[str]
    author: str
    text: str
    rating: Optional[float]
    published_at: Optional[str]
    relative_time: Optional[str]
    source_url: Optional[str]
    source_url_kind: str = "branch"


@dataclass(frozen=True)
class Place:
    place_id: str
    name: str
    address: str
    rating: Optional[float]
    source_url: str


def parse_google_places_payload(place_id: str, place_data: Any, reviews_data: Any) -> tuple[Place, list[Review]]:
    """Normalize the selected place and review sample already returned by Places."""
    if not isinstance(place_data, dict) or str(place_data.get("place_id") or "") != place_id:
        raise ReviewError("place_mismatch")
    if not isinstance(reviews_data, list):
        raise ReviewError("invalid_reviews")
    place_url = str(place_data.get("url") or "")
    parsed_url = urlparse(place_url)
    if parsed_url.scheme != "https" or parsed_url.hostname not in {"maps.google.com", "www.google.com", "google.com"}:
        place_url = ""
    place = Place(
        place_id=place_id,
        name=str(place_data.get("name") or ""),
        address=str(place_data.get("address") or ""),
        rating=_number(place_data.get("rating")),
        source_url=place_url,
    )
    reviews = [_parse_review(item) for item in reviews_data[:5] if isinstance(item, dict)]
    return place, reviews


def _number(value: Any) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _parse_review(item: dict[str, Any]) -> Review:
    return Review(
        provider_review_id=review_identifier(item),
        author=str(item.get("author_name") or "匿名使用者"),
        text=review_text(item),
        rating=_number(item.get("rating")),
        published_at=_parse_published_at(item),
        relative_time=str(item.get("relative_time_description") or "") or None,
        source_url=None,
        source_url_kind="branch",
    )


def _parse_published_at(item: dict[str, Any]) -> Optional[str]:
    # Google Places Legacy returns `time` as Unix seconds. `iso_date_of_last_edit`
    # is deliberately excluded because an edit must not move an old review into
    # a recent sampling window.
    raw = item.get("published_at") or item.get("time") or item.get("timestamp")
    if isinstance(raw, (int, float)):
        return datetime.fromtimestamp(raw, tz=timezone.utc).isoformat()
    if isinstance(raw, str):
        value = raw.strip().replace("Z", "+00:00")
        try:
            return datetime.fromisoformat(value).astimezone(timezone.utc).isoformat()
        except ValueError:
            return None
    return None


def evidence_id(place_id: str, review: Review) -> str:
    material = "|".join([
        place_id,
        review.provider_review_id or "",
        review.author,
        review.published_at or "",
        review.text,
    ])
    return "ev_" + hashlib.sha256(material.encode("utf-8")).hexdigest()[:20]


def normalize_evidence(place: Place, reviews: Iterable[Review], mode: str, window_days: int, now: Optional[datetime] = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    start = now - timedelta(days=window_days)
    fetched = list(reviews)
    seen_review_keys: set[str] = set()
    evidence: list[dict[str, Any]] = []
    excluded: dict[str, int] = {"duplicate": 0, "missing_date": 0, "outside_window": 0, "rating": 0, "empty_text": 0}
    for review in fetched:
        if not review.text:
            excluded["empty_text"] += 1
            continue
        if not review.published_at:
            excluded["missing_date"] += 1
            continue
        try:
            published = datetime.fromisoformat(review.published_at.replace("Z", "+00:00")).astimezone(timezone.utc)
        except ValueError:
            excluded["missing_date"] += 1
            continue
        review_key = review.provider_review_id or evidence_id(place.place_id, review)
        if review_key in seen_review_keys:
            excluded["duplicate"] += 1
            continue
        seen_review_keys.add(review_key)
        if published < start or published > now:
            excluded["outside_window"] += 1
            continue
        if mode == "low_rating" and (review.rating is None or review.rating > 3):
            excluded["rating"] += 1
            continue
        evidence.append({
            "evidence_id": evidence_id(place.place_id, review),
            "provider_review_id": review.provider_review_id,
            "author": review.author,
            "published_at": published.isoformat(),
            "rating": review.rating,
            "text": review.text,
            "is_excerpt": False,
            "source_url": review.source_url or place.source_url or None,
            "source_url_kind": review.source_url_kind if review.source_url else "branch",
        })
    return {
        "evidence": evidence,
        "sampling": {
            "mode": mode,
            "window_days": window_days,
            "start_at": start.isoformat(),
            "end_at": now.isoformat(),
            "fetched": len(fetched),
            "deduplicated": len(fetched) - excluded["duplicate"],
            "eligible": len(evidence),
            "used": 0,
            "excluded": excluded,
            "truncated": False,
        },
        "source_sha": SOURCE_SHA,
    }


_INCENTIVE_RE = re.compile(r"五星好評|五顆星送|好評送|打卡送|評論送|給五星|五星送|集讚送|出示評論|5[ -]?star review|review for (?:a )?free", re.I)


def detect_incentive_signals(evidence: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return conservative sample signals with evidence IDs and source text."""
    signals = []
    for item in evidence:
        text = str(item.get("text") or "")
        if _INCENTIVE_RE.search(text):
            signals.append({"kind": "review_incentive_wording", "count": 1, "evidence_ids": [item["evidence_id"]], "excerpt": text[:240]})
    return signals
