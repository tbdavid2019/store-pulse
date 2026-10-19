export interface Env {
  ASSETS?: Fetcher;
  AI?: any;
  STORE_PULSE_KV?: KVNamespace;
  STORE_PULSE_ENABLE_ANALYSIS?: string;
  STORE_PULSE_CACHE_TTL_SECONDS?: string;
  STORE_PULSE_EMPTY_CACHE_TTL_SECONDS?: string;
  STORE_PULSE_CLIENT_RATE_LIMIT?: string;
  STORE_PULSE_DAILY_MODEL_BUDGET?: string;
  STORE_PULSE_API_ORIGINS?: string;
  STORE_PULSE_ANALYSIS_VERSION?: string;
  MODEL_API_URL?: string;
  MODEL_API_KEY?: string;
  MODEL_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
}

export type AnalysisMode = 'recent' | 'low_rating';

export interface PlaceInput {
  place_id: string;
  name?: string;
  address?: string;
  rating?: number | null;
  url?: string;
}

export interface ReviewInput {
  author_name?: string;
  text?: string;
  snippet?: string;
  rating?: number | null;
  time?: number | string | null;
  timestamp?: number | string | null;
  published_at?: string | null;
  relative_time_description?: string | null;
  language?: string;
  review_id?: string;
  id?: string;
}

export interface AnalysisRequestPayload {
  place_id: string;
  mode?: AnalysisMode;
  window_days?: number;
  place: PlaceInput;
  reviews: ReviewInput[];
}

export interface NormalizedPlace {
  place_id: string;
  name: string;
  address: string;
  rating: number | null;
  source_url: string;
}

export interface NormalizedReview {
  provider_review_id: string | null;
  author: string;
  text: string;
  rating: number | null;
  published_at: string | null;
  relative_time: string | null;
  source_url: string | null;
  source_url_kind: string;
}

export interface EvidenceItem {
  evidence_id: string;
  provider_review_id: string | null;
  author: string;
  published_at: string;
  rating: number | null;
  text: string;
  is_excerpt: boolean;
  source_url: string | null;
  source_url_kind: string;
}

export interface Observation {
  category: 'service' | 'wait_time' | 'product_quality' | 'environment' | 'price';
  finding: string;
  evidence_ids: string[];
  suggested_action?: string;
}

export interface IncentiveSignal {
  kind: string;
  count: number;
  evidence_ids: string[];
  excerpt: string;
}

export interface SamplingMetadata {
  mode: AnalysisMode;
  window_days: number;
  start_at: string;
  end_at: string;
  fetched: number;
  deduplicated: number;
  eligible: number;
  used: number;
  excluded: {
    duplicate: number;
    missing_date: number;
    outside_window: number;
    rating: number;
    empty_text: number;
  };
  truncated: boolean;
}

export interface AnalysisResponsePayload {
  status: 'success' | 'insufficient_evidence' | 'summary_unavailable' | 'timeout' | 'quota_exceeded';
  request_id: string;
  place: {
    place_id: string;
    name: string;
    address: string;
    rating: number | null;
    source_url: string;
  };
  sampling: SamplingMetadata;
  evidence: EvidenceItem[];
  signals: IncentiveSignal[];
  summary?: {
    observations: Observation[];
  } | null;
  source_sha: string;
  fetched_at: string;
  analyzed_at?: string;
  usage: {
    review_source: string;
    model_calls: number;
    model?: string;
    status?: string;
    reason?: string;
    summary_error?: string;
  };
  cache: {
    hit: boolean;
    ttl_seconds: number;
  };
}
