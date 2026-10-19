# Spec Delta

## Purpose

讓管理者在搜尋分店後主動取得繁體中文營運摘要，查看支持每項結論的評論證據，並清楚辨識分析進度、樣本不足、快取時間及服務失敗等狀態。

## ADDED Requirements

### Requirement: User initiated branch analysis
The system SHALL provide a deep-analysis action on each branch card with sampling mode and time-window controls. External analysis MUST begin only after explicit activation, and each result MUST remain associated with its selected branch.

#### Scenario: Search only
- **WHEN** a search displays branch cards
- **THEN** no model analysis is triggered automatically and review data is sent for analysis only after the user activates the action

#### Scenario: Analysis in progress
- **WHEN** the user activates deep analysis for a branch
- **THEN** the card shows progress, prevents duplicate activation, and leaves other branch results usable

#### Scenario: Search changes during analysis
- **WHEN** a user starts a new search before an earlier analysis finishes
- **THEN** the earlier result cannot attach to a card from the new search

### Requirement: Evidence supported operational summary
The system MUST produce a Traditional Chinese structured summary covering evidenced service, wait time, product quality, environment or price observations. Every observation MUST reference valid evidence IDs; categories without evidence MUST be omitted. Reviews MUST be treated as untrusted data rather than executable instructions.

#### Scenario: Supported observation
- **WHEN** the selected evidence describes repeated long waits
- **THEN** the summary reports the sample observation with supporting evidence and separates any suggested action from the reported customer experience

#### Scenario: Invalid model output
- **WHEN** the model returns malformed data or references an unknown evidence ID
- **THEN** the system suppresses that summary, shows `summary_unavailable`, and retains the fetched evidence for inspection

#### Scenario: Instructions inside a review
- **WHEN** review text requests disclosure of secrets or changes to the analysis rules
- **THEN** the system treats the text as review content and exposes no credentials or operational tools to the model

### Requirement: Inspect evidence and sample limitations
The system SHALL allow each observation's evidence to be expanded with rating, publication time, source text or explicitly marked excerpt, and available source links. It MUST display analysis time, fetch time, selected period, used count, coverage limitations and cache status.

#### Scenario: Open supporting evidence
- **WHEN** the user expands an observation
- **THEN** the corresponding evidence is visible and its external links open only validated HTTP or HTTPS destinations

#### Scenario: Review contains markup
- **WHEN** evidence contains HTML or script-like text
- **THEN** it is rendered as inert text

### Requirement: Present incentive signals conservatively
The system SHALL describe detected review incentives as sample signals, with evidence references and occurrence counts. It MUST avoid certifying review authenticity or presenting a heuristic adjusted rating as a verified score.

#### Scenario: Review for gift wording
- **WHEN** an included review mentions a gift in exchange for a review
- **THEN** the result identifies the wording and source without asserting that the branch's reviews are proven fraudulent

### Requirement: Handle empty samples and unavailable services
The system MUST distinguish `insufficient_evidence`, `place_mismatch`, `quota_exceeded`, `service_unavailable`, `summary_unavailable` and timeout states. Empty samples MUST produce no generated summary and no model call. Cached data MUST retain explicit timestamps; offline use MUST identify analysis as unavailable.

#### Scenario: Empty eligible sample
- **WHEN** all fetched reviews are outside the window or excluded
- **THEN** the result shows `insufficient_evidence`, exclusion counts and a suggestion to adjust the window

#### Scenario: Model service failure
- **WHEN** evidence retrieval succeeds but the model fails
- **THEN** the user can inspect evidence with a `summary_unavailable` status

#### Scenario: Offline analysis
- **WHEN** the device is offline and a user requests analysis
- **THEN** the interface displays an offline state rather than presenting an old API response as a new analysis
