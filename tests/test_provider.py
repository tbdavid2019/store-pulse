import unittest
from datetime import datetime, timezone

from backend.reviews import Place, Review, ReviewError, detect_incentive_signals, normalize_evidence, parse_google_places_payload


class ProviderFixtureTests(unittest.TestCase):
    def test_low_rating_sample_excludes_high_rating(self):
        place = Place("branch-1", "分店", "台北", 4.5, "https://maps.google.com")
        reviews = [
            Review("r1", "A", "五星", 5, "2026-10-18T00:00:00+00:00", "1 day ago", None),
            Review("r2", "B", "太慢", 2, "2026-10-18T00:00:00+00:00", "1 day ago", None),
        ]
        result = normalize_evidence(place, reviews, "low_rating", 30)
        self.assertEqual([item["provider_review_id"] for item in result["evidence"]], ["r2"])
        self.assertEqual(result["sampling"]["excluded"]["rating"], 1)

    def test_missing_date_is_never_used_as_padding(self):
        place = Place("branch-1", "分店", "台北", 4.5, "https://maps.google.com")
        review = Review("r1", "A", "沒有日期", 2, None, "很久以前", None)
        result = normalize_evidence(place, [review], "recent", 90)
        self.assertEqual(result["evidence"], [])
        self.assertEqual(result["sampling"]["excluded"]["missing_date"], 1)

    def test_incentive_signal_is_evidence_bound(self):
        signal = detect_incentive_signals([{"evidence_id": "ev_1", "text": "五星好評送飲料"}])
        self.assertEqual(signal[0]["evidence_ids"], ["ev_1"])

    def test_google_places_reviews_are_normalized_and_linked_to_branch(self):
        timestamp = int(datetime(2026, 10, 18, tzinfo=timezone.utc).timestamp())
        place, reviews = parse_google_places_payload(
            "branch-1",
            {"place_id": "branch-1", "name": "分店", "address": "台北", "url": "https://maps.google.com/?cid=1"},
            [{"author_name": "A", "text": "候位很久", "rating": 2, "time": timestamp, "relative_time_description": "1 day ago"}],
        )
        self.assertEqual(place.place_id, "branch-1")
        self.assertEqual(reviews[0].published_at, "2026-10-18T00:00:00+00:00")
        result = normalize_evidence(place, reviews, "recent", 30)
        self.assertEqual(result["evidence"][0]["source_url_kind"], "branch")

    def test_google_places_mismatched_place_id_is_rejected(self):
        with self.assertRaises(ReviewError):
            parse_google_places_payload("selected", {"place_id": "other"}, [])

    def test_only_five_reviews_are_accepted_from_the_client(self):
        place_data = {"place_id": "branch-1", "name": "分店", "url": "https://maps.google.com"}
        review = {"author_name": "A", "text": "review", "rating": 5, "time": 1792281600}
        _, reviews = parse_google_places_payload("branch-1", place_data, [review] * 7)
        self.assertEqual(len(reviews), 5)

