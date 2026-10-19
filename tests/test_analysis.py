import unittest
from unittest.mock import Mock, patch

import requests

from backend.analysis import SummaryError, summarize


class SummaryAdapterTests(unittest.TestCase):
    def setUp(self):
        self.evidence = [{"evidence_id": "ev-1", "text": "候位很久", "rating": 2}]

    @patch("backend.analysis.requests.post")
    def test_valid_observation_keeps_only_known_evidence_ids(self, post):
        response = Mock(status_code=200)
        response.json.return_value = {"output": {"observations": [{
            "category": "wait_time",
            "finding": "候位時間較長",
            "evidence_ids": ["ev-1", "unknown"],
        }]}}
        post.return_value = response
        summary, usage = summarize(self.evidence, model_url="http://model.test", model_name="test-model")
        self.assertEqual(summary["observations"][0]["evidence_ids"], ["ev-1"])
        self.assertEqual(usage["model_calls"], 1)

    @patch("backend.analysis.requests.post")
    def test_unknown_only_reference_is_rejected(self, post):
        response = Mock(status_code=200)
        response.json.return_value = {"output": {"observations": [{
            "category": "wait_time", "finding": "無法核對", "evidence_ids": ["unknown"]
        }]}}
        post.return_value = response
        with self.assertRaises(SummaryError):
            summarize(self.evidence, model_url="http://model.test")

    @patch("backend.analysis.requests.post", side_effect=requests.Timeout())
    def test_timeout_is_reported_as_summary_error(self, post):
        with self.assertRaises(SummaryError):
            summarize(self.evidence, model_url="http://model.test", timeout=0.01)

    @patch("backend.analysis.requests.post")
    def test_missing_model_configuration_does_not_call_provider(self, post):
        summary, usage = summarize(self.evidence, model_url="")
        self.assertIsNone(summary)
        self.assertEqual(usage["status"], "summary_unavailable")
        post.assert_not_called()

