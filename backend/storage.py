"""SQLite cache and quota storage."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Optional


class Storage:
    def __init__(self, path: Optional[str] = None):
        self.path = path or os.getenv("STORE_PULSE_DB_PATH", ".data/store-pulse.sqlite3")
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self._init()

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    @contextmanager
    def _connection(self):
        conn = self._connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init(self):
        with self._connection() as conn:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS analyses (cache_key TEXT PRIMARY KEY, status TEXT NOT NULL, payload TEXT NOT NULL, created_at REAL NOT NULL, expires_at REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS budget (day TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS rate (client TEXT NOT NULL, bucket INTEGER NOT NULL, hits INTEGER NOT NULL, PRIMARY KEY(client, bucket));
            """)

    def get(self, key: str, now: Optional[float] = None) -> Optional[dict[str, Any]]:
        now = now or time.time()
        with self.lock, self._connection() as conn:
            row = conn.execute("SELECT payload, expires_at FROM analyses WHERE cache_key=?", (key,)).fetchone()
            if not row:
                return None
            if row["expires_at"] < now:
                conn.execute("DELETE FROM analyses WHERE cache_key=?", (key,))
                return None
            payload = json.loads(row["payload"])
            payload.setdefault("cache", {})["hit"] = True
            return payload

    def put(self, key: str, payload: dict[str, Any], ttl: int):
        now = time.time()
        with self.lock, self._connection() as conn:
            conn.execute("INSERT OR REPLACE INTO analyses VALUES (?, ?, ?, ?, ?)", (key, payload.get("status", "success"), json.dumps(payload, ensure_ascii=False), now, now + ttl))

    def allow_client(self, client: str, limit: int) -> bool:
        bucket = int(time.time() // 60)
        with self.lock, self._connection() as conn:
            row = conn.execute("SELECT hits FROM rate WHERE client=? AND bucket=?", (client, bucket)).fetchone()
            hits = int(row["hits"]) if row else 0
            if hits >= limit:
                return False
            conn.execute("INSERT OR REPLACE INTO rate VALUES (?, ?, ?)", (client, bucket, hits + 1))
            return True

    def reserve_daily(self, budget: int, now: Optional[float] = None) -> bool:
        day = time.strftime("%Y-%m-%d", time.gmtime(time.time() if now is None else now))
        with self.lock, self._connection() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT attempts FROM budget WHERE day=?", (day,)).fetchone()
            attempts = int(row["attempts"]) if row else 0
            if attempts >= budget:
                return False
            if row:
                conn.execute("UPDATE budget SET attempts=? WHERE day=?", (attempts + 1, day))
            else:
                conn.execute("INSERT INTO budget VALUES (?, ?)", (day, 1))
            return True
