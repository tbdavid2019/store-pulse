import os
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor

try:
    from backend import app as app_module
    from backend.storage import Storage
except ImportError:
    app_module = None
    Storage = None


@unittest.skipUnless(app_module is not None, "Flask dependencies are installed in the test environment")
class ApiContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        app_module.storage = Storage(os.path.join(self.temp.name, "api.sqlite3"))
        self.client = app_module.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def payload(self, place_id, reviews=None):
        return {
            "place_id": place_id,
            "place": {"place_id": place_id, "name": "測試分店", "address": "台北", "rating": 4.2, "url": "https://maps.google.com/?cid=1"},
            "reviews": reviews or [],
        }

    def test_health_and_invalid_request(self):
        self.assertEqual(self.client.get("/api/health").status_code, 200)
        response = self.client.post("/api/review-analysis", json={"place_id": "", "mode": "bad", "window_days": 20})
        self.assertEqual(response.status_code, 422)
        self.assertEqual(response.get_json()["status"], "invalid_request")

    def test_cors_allows_configured_origin_only(self):
        allowed = self.client.get("/api/health", headers={"Origin": "http://localhost:5000"})
        denied = self.client.get("/api/health", headers={"Origin": "https://untrusted.example"})
        self.assertEqual(allowed.headers.get("Access-Control-Allow-Origin"), "http://localhost:5000")
        self.assertIsNone(denied.headers.get("Access-Control-Allow-Origin"))

    def test_private_repository_files_are_not_served(self):
        for path in ("/backend/app.py", "/.git/config", "/.env.example"):
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)

    def test_analysis_result_is_cached(self):
        calls = []

        def fake_run(place_id, mode, window_days, deadline, place_data, reviews):
            calls.append((place_id, mode, window_days))
            return {"status": "insufficient_evidence", "sampling": {"used": 0}, "evidence": [], "usage": {}}

        original = app_module._run_analysis
        app_module._run_analysis = fake_run
        try:
            first = self.client.post("/api/review-analysis", json=self.payload("branch-1"))
            second = self.client.post("/api/review-analysis", json=self.payload("branch-1"))
        finally:
            app_module._run_analysis = original
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(len(calls), 1)
        self.assertTrue(second.get_json()["cache"]["hit"])

    def test_google_places_reviews_and_fake_model_complete_analysis(self):
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        review = {"author_name": "測試者", "text": "候位時間較長", "rating": 2, "time": int(time.time()), "relative_time_description": "剛剛"}
        original_summarize = app_module.summarize
        app_module.summarize = lambda evidence, timeout, before_request=None: ({"observations": [{"category": "wait_time", "finding": "候位較久", "evidence_ids": [evidence[0]["evidence_id"]]}]}, {"model_calls": 1, "model": "fixture"})
        try:
            response = self.client.post("/api/review-analysis", json=self.payload("branch-e2e", [review]))
        finally:
            app_module.summarize = original_summarize
        payload = response.get_json()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(payload["status"], "success")
        self.assertEqual(payload["summary"]["observations"][0]["evidence_ids"], [payload["evidence"][0]["evidence_id"]])
        self.assertEqual(payload["usage"]["review_source"], "google_places")

    def test_model_budget_is_reserved_per_model_call(self):
        now = int(time.time())
        review = {"author_name": "測試者", "text": "候位很久", "rating": 2, "time": now}
        original_budget = os.environ.get("STORE_PULSE_DAILY_MODEL_BUDGET")
        original_url = os.environ.get("MODEL_API_URL")
        original_summarize = app_module.summarize
        os.environ["STORE_PULSE_DAILY_MODEL_BUDGET"] = "1"
        os.environ["MODEL_API_URL"] = "https://model.example"

        def fake_summarize(evidence, timeout, before_request=None):
            before_request()
            return {"observations": [{"category": "wait_time", "finding": "候位久", "evidence_ids": [evidence[0]["evidence_id"]]}]}, {"model_calls": 1}

        app_module.summarize = fake_summarize
        try:
            first = self.client.post("/api/review-analysis", json=self.payload("budget-1", [review]))
            second = self.client.post("/api/review-analysis", json=self.payload("budget-2", [review]))
        finally:
            app_module.summarize = original_summarize
            if original_budget is None:
                os.environ.pop("STORE_PULSE_DAILY_MODEL_BUDGET", None)
            else:
                os.environ["STORE_PULSE_DAILY_MODEL_BUDGET"] = original_budget
            if original_url is None:
                os.environ.pop("MODEL_API_URL", None)
            else:
                os.environ["MODEL_API_URL"] = original_url
        self.assertEqual(first.get_json()["status"], "success")
        self.assertEqual(second.get_json()["status"], "quota_exceeded")

    def test_forwarded_header_cannot_rotate_client_rate_limit(self):
        original_limit = os.environ.get("STORE_PULSE_CLIENT_RATE_LIMIT")
        original_run = app_module._run_analysis
        os.environ["STORE_PULSE_CLIENT_RATE_LIMIT"] = "1"
        app_module._run_analysis = lambda place_id, mode, days, deadline, place_data, reviews: {"status": "insufficient_evidence", "sampling": {"used": 0}, "evidence": [], "usage": {}}
        try:
            first = self.client.post("/api/review-analysis", json=self.payload("rate-1"), headers={"X-Forwarded-For": "1.1.1.1"})
            second = self.client.post("/api/review-analysis", json=self.payload("rate-2"), headers={"X-Forwarded-For": "2.2.2.2"})
        finally:
            app_module._run_analysis = original_run
            if original_limit is None:
                os.environ.pop("STORE_PULSE_CLIENT_RATE_LIMIT", None)
            else:
                os.environ["STORE_PULSE_CLIENT_RATE_LIMIT"] = original_limit
        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 429)

    def test_cache_key_changes_when_model_version_changes(self):
        original_model = os.environ.get("MODEL_NAME")
        original_key = os.environ.get("MODEL_API_KEY")
        os.environ["MODEL_NAME"] = "model-a"
        os.environ.pop("MODEL_API_KEY", None)
        first = app_module._cache_key("branch", "recent", 90)
        os.environ["MODEL_NAME"] = "model-b"
        second = app_module._cache_key("branch", "recent", 90)
        os.environ["MODEL_NAME"] = "model-a"
        os.environ["MODEL_API_KEY"] = "test-key"
        third = app_module._cache_key("branch", "recent", 90)
        if original_model is None:
            os.environ.pop("MODEL_NAME", None)
        else:
            os.environ["MODEL_NAME"] = original_model
        if original_key is None:
            os.environ.pop("MODEL_API_KEY", None)
        else:
            os.environ["MODEL_API_KEY"] = original_key
        self.assertNotEqual(first, second)
        self.assertNotEqual(first, third)

    def test_concurrent_identical_requests_share_analysis(self):
        calls = []
        calls_lock = threading.Lock()
        original = app_module._run_analysis

        def fake_run(place_id, mode, window_days, deadline, place_data, reviews):
            with calls_lock:
                calls.append(place_id)
            time.sleep(0.08)
            return {"status": "insufficient_evidence", "sampling": {"used": 0}, "evidence": [], "usage": {}}

        app_module._run_analysis = fake_run
        barrier = threading.Barrier(2)

        def submit():
            client = app_module.app.test_client()
            barrier.wait()
            response = client.post("/api/review-analysis", json=self.payload("same-branch"))
            return response.status_code, response.get_json()

        try:
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(lambda _: submit(), range(2)))
        finally:
            app_module._run_analysis = original
        self.assertEqual([status for status, _ in responses], [200, 200])
        self.assertEqual(calls, ["same-branch"])

    def test_expired_owner_cannot_release_replacement_lease(self):
        old_flight = app_module.Flight(threading.Event(), time.monotonic() - 100)
        new_flight = app_module.Flight(threading.Event(), time.monotonic())
        app_module.inflight["lease-test"] = new_flight
        app_module._finish_flight("lease-test", old_flight, ({"status": "timeout"}, 504))
        self.assertIs(app_module.inflight["lease-test"], new_flight)
        self.assertTrue(old_flight.event.is_set())
        self.assertFalse(new_flight.event.is_set())
        app_module._finish_flight("lease-test", new_flight, ({"status": "success"}, 200))
        self.assertNotIn("lease-test", app_module.inflight)

