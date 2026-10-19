"""HTTP API for Store Pulse review analysis.

Run with ``python3 -m backend.app`` after installing requirements.
"""
from __future__ import annotations

import hashlib
import os
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Any

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.middleware.proxy_fix import ProxyFix

from .analysis import SummaryError, summarize
from .reviews import ReviewError, detect_incentive_signals, normalize_evidence, parse_google_places_payload
from .storage import Storage

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ICONS = os.path.join(ROOT, "icons")
app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024
origins = [item.strip() for item in os.getenv("STORE_PULSE_API_ORIGINS", "http://localhost:5000,http://127.0.0.1:5000").split(",") if item.strip()]
CORS(app, origins=origins, supports_credentials=False)
try:
    trusted_proxy_hops = max(0, int(os.getenv("STORE_PULSE_TRUSTED_PROXY_HOPS", "0")))
except ValueError:
    trusted_proxy_hops = 0
if trusted_proxy_hops:
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=trusted_proxy_hops, x_proto=trusted_proxy_hops, x_host=0, x_port=0, x_prefix=0)
storage = Storage()


@dataclass
class Flight:
    event: threading.Event
    started: float
    response: tuple[dict[str, Any], int] | None = None


inflight: dict[str, Flight] = {}
inflight_lock = threading.RLock()


def _config_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _error(status: str, message: str, http_status: int = 400):
    return jsonify({"status": status, "message": message, "request_id": secrets.token_urlsafe(8)}), http_status


def _error_payload(status: str, message: str) -> dict[str, Any]:
    return {"status": status, "message": message, "request_id": secrets.token_urlsafe(8)}


def _validate(payload: dict[str, Any]) -> tuple[str, str, int]:
    if not isinstance(payload, dict):
        raise ValueError("request body must be an object")
    place_id = str(payload.get("place_id") or "").strip()
    mode = str(payload.get("mode") or "recent").strip()
    window_days = payload.get("window_days", 90)
    if not place_id or len(place_id) > 256:
        raise ValueError("place_id is required")
    if mode not in {"recent", "low_rating"}:
        raise ValueError("mode must be recent or low_rating")
    if window_days not in {30, 90}:
        raise ValueError("window_days must be 30 or 90")
    place_data = payload.get("place")
    reviews = payload.get("reviews")
    if not isinstance(place_data, dict) or str(place_data.get("place_id") or "") != place_id:
        raise ValueError("place must match place_id")
    if not isinstance(reviews, list) or len(reviews) > 5:
        raise ValueError("reviews must be a list of up to five Google Places reviews")
    return place_id, mode, int(window_days)


def _cache_key(place_id: str, mode: str, window_days: int) -> str:
    model_url = os.getenv("MODEL_API_URL", "")
    model_name = os.getenv("MODEL_NAME", "")
    model_auth_configured = bool(os.getenv("MODEL_API_KEY", ""))
    analysis_version = os.getenv("STORE_PULSE_ANALYSIS_VERSION", "2")
    version_material = "|".join((analysis_version, model_url, model_name, str(model_auth_configured), "zh-TW"))
    version = hashlib.sha256(version_material.encode()).hexdigest()[:16]
    return f"{version}|{place_id}|{mode}|{window_days}"


def _finish_flight(key: str, flight: Flight, response: tuple[dict[str, Any], int]) -> None:
    """Publish a flight result and release only the lease owned by that flight."""
    with inflight_lock:
        flight.response = response
        if inflight.get(key) is flight:
            inflight.pop(key, None)
        flight.event.set()


def _run_analysis(place_id: str, mode: str, window_days: int, deadline: float, place_data: Any, review_data: Any) -> dict[str, Any]:
    place, reviews = parse_google_places_payload(place_id, place_data, review_data)
    if mode == "recent":
        reviews.sort(key=lambda item: item.published_at or "", reverse=True)
    else:
        reviews.sort(key=lambda item: (item.rating if item.rating is not None else 6, item.published_at or ""))
    evidence_result = normalize_evidence(place, reviews, mode, window_days)
    evidence_result["sampling"]["truncated"] = len(review_data) >= 5
    evidence = evidence_result["evidence"][:5]
    total_chars = 0
    used = []
    for item in evidence:
        remaining = 8000 - total_chars
        if remaining <= 0:
            evidence_result["sampling"]["truncated"] = True
            break
        text = item["text"]
        if len(text) > 1200:
            text = text[:1200].rstrip() + "…"
            item = {**item, "text": text, "is_excerpt": True}
        if len(text) > remaining:
            item = {**item, "text": text[: max(1, remaining - 1)].rstrip() + "…", "is_excerpt": True}
        total_chars += len(item["text"])
        used.append(item)
    evidence_result["sampling"]["used"] = len(used)
    result: dict[str, Any] = {
        "status": "success" if used else "insufficient_evidence",
        "request_id": secrets.token_urlsafe(8),
        "place": {"place_id": place.place_id, "name": place.name, "address": place.address, "rating": place.rating, "source_url": place.source_url},
        "sampling": evidence_result["sampling"],
        "evidence": used,
        "signals": detect_incentive_signals(used),
        "source_sha": evidence_result["source_sha"],
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "usage": {"review_source": "google_places", "model_calls": 0},
        "cache": {"hit": False, "ttl_seconds": _config_int("STORE_PULSE_CACHE_TTL_SECONDS", 21600)},
    }
    if not used:
        return result
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise SummaryError("request_deadline_exceeded")
        def reserve_model_call():
            if not storage.reserve_daily(_config_int("STORE_PULSE_DAILY_MODEL_BUDGET", 100)):
                raise SummaryError("quota_exceeded")

        summary, usage = summarize(used, timeout=min(25, remaining), before_request=reserve_model_call)
        result["summary"] = summary
        result["usage"].update(usage)
        if summary is None:
            result["status"] = usage.get("status", "summary_unavailable")
        result["analyzed_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    except (SummaryError, ValueError, OSError) as exc:
        result["status"] = "timeout" if str(exc) in {"request_deadline_exceeded", "model_timeout"} else "quota_exceeded" if str(exc) == "quota_exceeded" else "summary_unavailable"
        result["summary"] = None
        result["usage"]["summary_error"] = type(exc).__name__
    return result


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "analysis_enabled": os.getenv("STORE_PULSE_ENABLE_ANALYSIS", "true").lower() == "true"})


@app.post("/api/review-analysis")
def review_analysis():
    if os.getenv("STORE_PULSE_ENABLE_ANALYSIS", "true").lower() != "true":
        return _error("analysis_disabled", "深度分析目前已停用。", 503)
    payload = request.get_json(silent=True) or {}
    try:
        place_id, mode, window_days = _validate(payload)
    except ValueError as exc:
        return _error("invalid_request", str(exc), 422)
    client = request.remote_addr or "anonymous"
    key = _cache_key(place_id, mode, window_days)
    cached = storage.get(key)
    if cached:
        return jsonify(cached)
    if not storage.allow_client(client, _config_int("STORE_PULSE_CLIENT_RATE_LIMIT", 5)):
        return _error("rate_limited", "分析請求過於頻繁，請稍後再試。", 429)
    deadline = time.monotonic() + _config_int("STORE_PULSE_REQUEST_TIMEOUT_SECONDS", 45)
    with inflight_lock:
        flight = inflight.get(key)
        lease_ttl = _config_int("STORE_PULSE_REQUEST_TIMEOUT_SECONDS", 45) + 10
        if flight is not None and time.monotonic() - flight.started <= lease_ttl:
            is_owner = False
        else:
            if flight is not None:
                flight.event.set()
            flight = Flight(threading.Event(), time.monotonic())
            inflight[key] = flight
            is_owner = True
    if not is_owner:
        if flight.event.wait(timeout=max(0, deadline - time.monotonic())) and flight.response:
            return jsonify(flight.response[0]), flight.response[1]
        return _error("timeout", "分析逾時，請稍後重試。", 504)

    response_body: dict[str, Any]
    response_status = 200
    try:
        result = _run_analysis(place_id, mode, window_days, deadline, payload.get("place"), payload.get("reviews"))
        ttl = _config_int("STORE_PULSE_EMPTY_CACHE_TTL_SECONDS", 600) if result["status"] == "insufficient_evidence" else _config_int("STORE_PULSE_CACHE_TTL_SECONDS", 21600)
        if result["status"] != "quota_exceeded":
            storage.put(key, result, ttl)
        response_body = result
    except ReviewError as exc:
        if str(exc) == "place_mismatch":
            status, message, response_status = "place_mismatch", "回傳的評論無法確認屬於所選分店。", 502
        elif str(exc) == "quota_exceeded":
            status, message, response_status = "quota_exceeded", "今日評論服務額度已用完。", 429
        elif str(exc) == "timeout":
            status, message, response_status = "timeout", "分析逾時，請稍後重試。", 504
        else:
            status, message, response_status = "service_unavailable", "評論服務暫時無法完成這家分店的分析。", 502
        response_body = _error_payload(status, message)
    except Exception:
        response_body = _error_payload("service_unavailable", "評論分析服務暫時無法使用。")
        response_status = 502
    finally:
        _finish_flight(key, flight, (locals().get("response_body", _error_payload("service_unavailable", "評論分析服務暫時無法使用。")), locals().get("response_status", 502)))
    return jsonify(response_body), response_status


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/manifest.json")
def manifest():
    return send_from_directory(ROOT, "manifest.json")


@app.get("/service-worker.js")
def service_worker():
    return send_from_directory(ROOT, "service-worker.js", mimetype="application/javascript")


@app.get("/icons/<path:filename>")
def icon(filename: str):
    return send_from_directory(ICONS, filename)


if __name__ == "__main__":
    app.run(host=os.getenv("HOST", "127.0.0.1"), port=int(os.getenv("PORT", "5000")), debug=False)
