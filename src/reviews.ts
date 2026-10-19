import { createHash } from 'node:crypto';
import type {
  AnalysisMode,
  EvidenceItem,
  IncentiveSignal,
  NormalizedPlace,
  NormalizedReview,
  PlaceInput,
  ReviewInput,
  SamplingMetadata,
} from './types.ts';

export const SOURCE_SHA = 'e7f99abc793f87cb872abf716e45541b620535e0';

export class ReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewError';
  }
}

function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function reviewText(payload: ReviewInput): string {
  return String(payload.snippet || payload.text || '').trim();
}

function reviewIdentifier(payload: ReviewInput): string | null {
  const value = payload.review_id || payload.id;
  return value ? String(value) : null;
}

export function parseGooglePlacesPayload(
  placeId: string,
  placeData: unknown,
  reviewsData: unknown
): { place: NormalizedPlace; reviews: NormalizedReview[] } {
  if (!placeData || typeof placeData !== 'object' || String((placeData as PlaceInput).place_id || '') !== placeId) {
    throw new ReviewError('place_mismatch');
  }
  if (!Array.isArray(reviewsData)) {
    throw new ReviewError('invalid_reviews');
  }

  const p = placeData as PlaceInput;
  let placeUrl = String(p.url || '');
  try {
    const parsed = new URL(placeUrl);
    if (parsed.protocol !== 'https:' || !['maps.google.com', 'www.google.com', 'google.com'].includes(parsed.hostname)) {
      placeUrl = '';
    }
  } catch {
    placeUrl = '';
  }

  const place: NormalizedPlace = {
    place_id: placeId,
    name: String(p.name || ''),
    address: String(p.address || ''),
    rating: parseNumber(p.rating),
    source_url: placeUrl,
  };

  const reviews: NormalizedReview[] = (reviewsData as ReviewInput[])
    .slice(0, 5)
    .filter((item): item is ReviewInput => Boolean(item && typeof item === 'object'))
    .map(item => parseReview(item));

  return { place, reviews };
}

function parseReview(item: ReviewInput): NormalizedReview {
  return {
    provider_review_id: reviewIdentifier(item),
    author: String(item.author_name || '匿名使用者'),
    text: reviewText(item),
    rating: parseNumber(item.rating),
    published_at: parsePublishedAt(item),
    relative_time: String(item.relative_time_description || '') || null,
    source_url: null,
    source_url_kind: 'branch',
  };
}

function parsePublishedAt(item: ReviewInput): string | null {
  const raw = item.published_at ?? item.time ?? item.timestamp;
  if (typeof raw === 'number') {
    // Unix timestamp in seconds
    return new Date(raw * 1000).toISOString();
  }
  if (typeof raw === 'string') {
    const cleaned = raw.trim();
    const d = new Date(cleaned);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

export function evidenceId(
  placeId: string,
  review: { provider_review_id?: string | null; author: string; published_at?: string | null; text: string }
): string {
  const material = [
    placeId,
    review.provider_review_id || '',
    review.author,
    review.published_at || '',
    review.text,
  ].join('|');
  return 'ev_' + createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 20);
}

export function normalizeEvidence(
  place: NormalizedPlace,
  reviews: NormalizedReview[],
  mode: AnalysisMode,
  windowDays: number,
  nowDate?: Date
): { evidence: EvidenceItem[]; sampling: SamplingMetadata; source_sha: string } {
  const now = nowDate || new Date();
  const start = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const seenKeys = new Set<string>();
  const evidence: EvidenceItem[] = [];
  const excluded = {
    duplicate: 0,
    missing_date: 0,
    outside_window: 0,
    rating: 0,
    empty_text: 0,
  };

  for (const review of reviews) {
    if (!review.text) {
      excluded.empty_text++;
      continue;
    }
    if (!review.published_at) {
      excluded.missing_date++;
      continue;
    }
    const published = new Date(review.published_at);
    if (isNaN(published.getTime())) {
      excluded.missing_date++;
      continue;
    }

    const reviewKey = review.provider_review_id || evidenceId(place.place_id, review);
    if (seenKeys.has(reviewKey)) {
      excluded.duplicate++;
      continue;
    }
    seenKeys.add(reviewKey);

    if (published < start || published > now) {
      excluded.outside_window++;
      continue;
    }

    if (mode === 'low_rating' && (review.rating === null || review.rating > 3)) {
      excluded.rating++;
      continue;
    }

    evidence.push({
      evidence_id: evidenceId(place.place_id, review),
      provider_review_id: review.provider_review_id,
      author: review.author,
      published_at: published.toISOString(),
      rating: review.rating,
      text: review.text,
      is_excerpt: false,
      source_url: review.source_url || place.source_url || null,
      source_url_kind: review.source_url ? review.source_url_kind : 'branch',
    });
  }

  return {
    evidence,
    sampling: {
      mode,
      window_days: windowDays,
      start_at: start.toISOString(),
      end_at: now.toISOString(),
      fetched: reviews.length,
      deduplicated: reviews.length - excluded.duplicate,
      eligible: evidence.length,
      used: 0,
      excluded,
      truncated: false,
    },
    source_sha: SOURCE_SHA,
  };
}

const INCENTIVE_REGEX = /五星好評|五顆星送|好評送|打卡送|評論送|給五星|五星送|集讚送|出示評論|5[ -]?star review|review for (?:a )?free/i;

export function detectIncentiveSignals(evidence: EvidenceItem[]): IncentiveSignal[] {
  const signals: IncentiveSignal[] = [];
  for (const item of evidence) {
    const text = String(item.text || '');
    if (INCENTIVE_REGEX.test(text)) {
      signals.push({
        kind: 'review_incentive_wording',
        count: 1,
        evidence_ids: [item.evidence_id],
        excerpt: text.slice(0, 240),
      });
    }
  }
  return signals;
}
