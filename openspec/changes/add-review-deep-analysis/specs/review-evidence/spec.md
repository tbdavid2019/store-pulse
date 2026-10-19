# Spec Delta

## Purpose

為 Store Pulse 提供身分明確、時間可核對且可追溯的分店評論證據，讓營運分析建立在已取得的評論樣本上，同時揭露取樣限制並控制外部服務用量。

## ADDED Requirements

### Requirement: Bind evidence to the selected branch
The system MUST bind the submitted Google Places review sample to the selected Google place ID and verify the branch identity before analysis.

#### Scenario: Matching branch
- **WHEN** the submitted place data contains the selected place ID
- **THEN** the system associates the evidence with that branch and retains both identifiers

#### Scenario: Ambiguous branch
- **WHEN** the submitted place ID differs from the selected branch ID
- **THEN** the system returns `place_mismatch` and stops before generating a summary

### Requirement: Explicit sampling and time window
The system SHALL support `recent` and `low_rating` sampling with 30-day or 90-day windows, defaulting to `recent` and 90 days. Only reviews with a verifiable publication timestamp inside the requested window SHALL enter analysis; low-rating samples MUST have ratings of 3 or less.

#### Scenario: Recent sample
- **WHEN** recent analysis is requested
- **THEN** the system requests newest-first reviews and filters them against the UTC analysis start time and selected window

#### Scenario: Low rating sample
- **WHEN** low-rating analysis is requested
- **THEN** the system requests lowest-first reviews, applies the time window and rating filter, and labels the sample as deliberately selected low ratings

#### Scenario: Old or undated review
- **WHEN** fetched reviews contain old or unverifiably dated entries
- **THEN** those entries are excluded with exclusion counts and never used to pad the sample

### Requirement: Traceable and deduplicated evidence
The system MUST retain a stable evidence ID, source review ID when supplied, publication timestamp, rating, source attribution and available branch link for each included review. Duplicate review IDs MUST represent one review; missing IDs MUST use a deterministic fallback identity.

#### Scenario: Repeated translated review
- **WHEN** two submitted entries share a review ID
- **THEN** the system counts and presents one evidence item

#### Scenario: Missing review link
- **WHEN** Google Places omits a direct review URL
- **THEN** the system retains a branch source link and marks the direct review link as unavailable

### Requirement: Disclose sample coverage
The system MUST expose fetched, deduplicated, eligible and used counts, exclusion counts, sampling mode, requested window, fetch time and whether retrieval was truncated. Conclusions MUST be identified as sample-based rather than population statistics.

#### Scenario: Places review sample reaches its limit
- **WHEN** the submitted sample contains five reviews
- **THEN** the response marks the sample as capped and describes its limited coverage

### Requirement: Bound and reuse external work
The system MUST cap client-supplied Google Places reviews at five, enforce model call caps, client rate limits and a global daily model request budget. Fresh matching cached results SHALL be reused, and simultaneous identical requests SHALL share one in-flight analysis.

#### Scenario: Fresh matching cache
- **WHEN** a request matches the branch, sampling window and analysis version of a fresh cached result
- **THEN** the system returns the cached result with its original timestamps and performs no external calls

#### Scenario: Daily model budget exhausted
- **WHEN** a cache miss occurs after the configured daily model budget is exhausted
- **THEN** the system returns `quota_exceeded` without calling the model and retains the available review evidence

#### Scenario: Concurrent identical requests
- **WHEN** identical analysis requests arrive while the same analysis is running
- **THEN** they share its result and consume one analysis allocation

### Requirement: Keep service credentials on the server
The system MUST keep model credentials in server configuration, restrict cross-origin API access to configured origins, and redact credentials from responses and logs.

#### Scenario: Model authentication failure
- **WHEN** the configured model service rejects a credential
- **THEN** the client receives `service_unavailable` with a request ID, while diagnostics retain a redacted failure reason
