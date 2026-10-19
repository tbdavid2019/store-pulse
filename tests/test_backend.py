import unittest
from datetime import datetime, timedelta, timezone

from backend.reviews import Place, Review, _parse_published_at, evidence_id, normalize_evidence


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 19, tzinfo=timezone.utc)
        self.place = Place("tw-1", "測試分店", "台北市", 4.2, "https://maps.google.com/?cid=1")

    def review(self, ident, days=1, rating=5, text="服務很快"):
        return Review(ident, "測試者", text, rating, (self.now - timedelta(days=days)).isoformat(), f"{days} days ago", None)

    def test_filters_window_rating_and_duplicates(self):
        reviews = [self.review("a"), self.review("a"), self.review("old", days=91), self.review("low", rating=2)]
        result = normalize_evidence(self.place, reviews, "low_rating", 90, self.now)
        self.assertEqual(result["sampling"]["eligible"], 1)
        self.assertEqual(result["sampling"]["excluded"]["duplicate"], 1)
        self.assertEqual(result["sampling"]["excluded"]["outside_window"], 1)

    def test_fallback_id_is_stable(self):
        review = self.review("")
        self.assertEqual(evidence_id("tw-1", review), evidence_id("tw-1", review))

    def test_google_places_unix_time_is_used_as_review_publication_date(self):
        timestamp = int(datetime(2026, 10, 18, tzinfo=timezone.utc).timestamp())
        self.assertEqual(_parse_published_at({"time": timestamp}), "2026-10-18T00:00:00+00:00")


if __name__ == "__main__":
    unittest.main()
