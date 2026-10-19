import os
import tempfile
import time
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
import unittest

from backend.storage import Storage


class StorageTests(unittest.TestCase):
    def test_cache_budget_and_rate_limit_persist(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "store-pulse.sqlite3")
            storage = Storage(path)
            storage.put("key", {"status": "success"}, 60)
            self.assertEqual(storage.get("key")["status"], "success")
            self.assertTrue(storage.reserve_daily(1))
            self.assertFalse(storage.reserve_daily(1))
            self.assertTrue(storage.allow_client("client", 1))
            self.assertFalse(storage.allow_client("client", 1))

    def test_daily_reservations_are_atomic_across_threads(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(os.path.join(directory, "store-pulse.sqlite3"))
            with ThreadPoolExecutor(max_workers=12) as pool:
                outcomes = list(pool.map(lambda _: storage.reserve_daily(5), range(24)))
            self.assertEqual(sum(outcomes), 5)

    def test_daily_budget_uses_utc_day_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(os.path.join(directory, "store-pulse.sqlite3"))
            before_midnight = datetime(2026, 10, 19, 23, 59, tzinfo=timezone.utc).timestamp()
            after_midnight = datetime(2026, 10, 20, 0, 1, tzinfo=timezone.utc).timestamp()
            self.assertTrue(storage.reserve_daily(1, now=before_midnight))
            self.assertFalse(storage.reserve_daily(1, now=before_midnight))
            self.assertTrue(storage.reserve_daily(1, now=after_midnight))

    def test_cache_expiry_returns_miss(self):
        with tempfile.TemporaryDirectory() as directory:
            storage = Storage(os.path.join(directory, "store-pulse.sqlite3"))
            storage.put("key", {"status": "success"}, 1)
            self.assertIsNone(storage.get("key", now=time.time() + 2))

