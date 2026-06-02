import type { LensId, PresetId } from './lens-fields';

/** Known platform error codes (matches API PlatformErrorCode). */
export type PlatformErrorCode =
  | 'VALIDATION_FAILED'
  | 'AUTH_FAILED'
  | 'PLAN_LIMIT_EXCEEDED'
  | 'IMAGE_INVALID'
  | 'IMAGE_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'CONTENT_FILTERED'
  | 'PARSE_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_ERROR'
  | 'INTERNAL_ERROR'
  | 'SCHEMA_GENERATION_FAILED'
  | 'SCHEMA_VALIDATION_FAILED'
  | 'SCHEMA_NOT_FOUND'
  | 'BESPOKE_SAFETY_BLOCKED'
  | 'BESPOKE_EXTRACTION_FAILED';

/** Image in a multi-image request. */
export interface ImageInput {
  url?: string;
  base64?: string;
}

/** Person context for analysis. */
export interface PersonContext {
  name: string;
  birthYear?: number;
  deathYear?: number;
  role?: string;
}

/** Vehicle context for analysis. */
export interface VehicleContext {
  vin?: string;
  mileage?: number;
  year?: number;
  make?: string;
  model?: string;
}

/** Bespoke extraction configuration for v2/analyze. */
export interface ExtractConfig {
  /** Natural language prompt describing what to extract. Max 500 chars. Mutually exclusive with schema/schemaId. */
  prompt?: string;
  /** Developer-provided JSON Schema. Mutually exclusive with prompt/schemaId. */
  schema?: Record<string, unknown>;
  /** Previously saved schema ID. Mutually exclusive with prompt/schema. */
  schemaId?: string;
}

/** Bespoke metadata in the analysis response. */
export interface BespokeMetadata {
  /** ID of the schema used (for reuse via schemaId). */
  schemaId: string;
  /** How the schema was resolved. */
  inputMode: 'prompt' | 'schema' | 'saved';
  /** Whether the schema was found in cache (previously generated from same prompt). */
  schemaCacheHit: boolean;
  /** Number of fields in the bespoke schema. */
  fieldCount: number;
}

/** Request body for POST /v1/analyze. */
export interface AnalyzeRequest {
  /** Single image URL. Mutually exclusive with imageBase64 and images. */
  imageUrl?: string;
  /** Single image as base64. Mutually exclusive with imageUrl and images. */
  imageBase64?: string;
  /** Multiple images. Mutually exclusive with imageUrl/imageBase64. */
  images?: ImageInput[];

  /** Curated stack name. The field is `preset` on the wire for back-compat. Types are loose (`string`) to tolerate new stacks being added; see PresetId in `@phototology/sdk/lens-fields` for the current typed list. */
  preset?: PresetId | string;
  /** Explicit lens list. Pass to build a custom stack from scratch (alternative to `preset`). Type-narrowed to current lens IDs. */
  modules?: LensId[];
  /** Lenses to add to the curated stack (augment pattern). */
  modulesAdd?: LensId[];
  /** Lenses to remove from the curated stack. */
  modulesRemove?: LensId[];
  /** Per-module configuration (e.g. { describe: { domain: 'automotive' } }). */
  moduleOptions?: Record<string, Record<string, unknown>>;

  /** Domain context. */
  context?: {
    knownPeople?: PersonContext[];
    vehicle?: VehicleContext;
    customInstructions?: string;
  };

  /** Processing options. */
  options?: {
    includeEmbedding?: boolean;
    includeFingerprint?: boolean;
  };

  /** Bespoke extraction configuration. When present, routes to /v2/analyze. */
  extract?: ExtractConfig;

  /**
   * Bypass the projection cache and re-run the LLM for all requested lenses.
   * When false or omitted (default), cached lens outputs from the photo
   * registry are reused and only missing lenses incur LLM cost.
   */
  refresh?: boolean;
}

/** Photo analysis output (opaque record — fields vary by modules used). */
export type PhotoOutput = Record<string, unknown>;

/** Vehicle condition output (opaque record — fields vary by modules used). */
export type VehicleOutput = Record<string, unknown>;

/** Usage information from analysis. */
export interface AnalyzeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modulesUsed: string[];
  /** Number of credits charged for this analysis. */
  creditsCharged?: number;
}

/** Vendor of the AI model that produced the analysis. EU AI Act Art. 50 disclosure. */
export type AnalyzeVendor = 'google' | 'openai' | 'anthropic';

/** Response metadata. */
export interface AnalyzeMeta {
  processingTimeMs: number;
  provider: string;
  promptHash: string;
  requestId: string;
  /**
   * EU AI Act Art. 50 transparency flag. `true` whenever a model produced the
   * output (fresh run, cache hit of real output, or safety screening). `false`
   * only for the `pt_test_` sandbox, where a static golden fixture is returned
   * and no model runs. Branch on top-level `livemode` for the live/test split.
   */
  ai_generated: boolean;
  /** Model identifier (e.g. `"gemini-3.1-flash-lite"`, `"gpt-4o"`). */
  model: string;
  /** Canonical vendor of the model used. */
  vendor: AnalyzeVendor;
}

/** Fingerprint data (when requested). */
export interface Fingerprint {
  pHash: string;
  dHash: string;
  sha256: string;
}

/** Base response shape shared by both output schemas. */
interface AnalyzeResponseBase {
  id: string;
  object: 'analysis';
  /** True for pt_live_ keys; false for pt_test_ sandbox responses (fixtures, no charge). */
  livemode: boolean;
  schemaVersion: string;
  createdAt: string;
  usage: AnalyzeUsage;
  warnings: string[];
  meta: AnalyzeMeta;
  embedding?: number[];
  fingerprint?: Fingerprint;
}

/** Response when outputSchema is 'photo'. */
export interface PhotoAnalyzeResponse extends AnalyzeResponseBase {
  outputSchema: 'photo';
  output: PhotoOutput;
}

/** Response when outputSchema is 'vehicle'. */
export interface VehicleAnalyzeResponse extends AnalyzeResponseBase {
  outputSchema: 'vehicle';
  output: VehicleOutput;
}

/** Discriminated union — narrows output type based on outputSchema. */
export type AnalyzeResponse = PhotoAnalyzeResponse | VehicleAnalyzeResponse;

/** Credits payload attached to 402 PLAN_LIMIT_EXCEEDED responses. */
export interface ErrorCredits {
  /** Credits required by the request. */
  needed: number;
  /** Community pool balance. */
  community: number;
  /** Purchased pool balance. */
  purchased: number;
  /** community + purchased. */
  total: number;
  /** Days until community pool refills. Omitted when user has no community pool. */
  resetsInDays?: number;
}

/** Standard error response from the API. */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    requestId: string;
    /** Populated on 402 PLAN_LIMIT_EXCEEDED with dual-pool credit info. */
    credits?: ErrorCredits;
  };
}

/** Spreadsheet column descriptor exposed per lens via /v1/modules. Drives default tabular projection. */
export interface LensColumn {
  /** User-visible header label (e.g. "estimated_year"). */
  label: string;
  /** Dotted path into `analysisResult` (e.g. "dating.estimatedYear"). */
  jsonPath: string;
  /**
   * Cell rendering hint. `'count'` resolves the `jsonPath` to an array and
   * renders its length (mirrors the API's tabular export pipeline).
   */
  format?: 'string' | 'number' | 'date' | 'percentage' | 'tags' | 'hex' | 'count';
}

/** Single module (lens) in the modules discovery response. */
export interface ModuleInfo {
  name: string;
  description: string;
  category: string;
  outputFields: string[];
  /** Whether running this lens charges a credit. `moderation` is the only non-billable lens. Cache hits cost zero credits regardless. */
  billable: boolean;
  /** Default tabular projection. Each entry maps to one spreadsheet column. */
  defaultColumns: LensColumn[];
  /** `true` if this lens is real but NOT directly selectable via `modules: []` — reachable only through a curated stack (e.g. `vehicle-condition`). Omitted for the 15 directly-selectable lenses. */
  internal?: true;
}

/** Single curated stack in the discovery response. The on-the-wire response keys these as `presets[]` for back-compat; the concept is a stack. */
export interface PresetInfo {
  name: string;
  description: string;
  modules: string[];
}

/** Response from GET /v1/modules. */
export interface ModulesResponse {
  modules: ModuleInfo[];
  presets: PresetInfo[];
}

/**
 * Response from GET /v1/usage — the authenticated key's credit balance.
 *
 * `total` is the spendable credit balance — the single number to show and
 * reason about. `reserved` is the in-flight hold from running analyze calls;
 * effective spendable = `total - reserved`.
 *
 * The `community` / `purchased` breakdown is retained for back-compat (and
 * powers refund-to-origin accounting internally) — it is NOT two separate
 * balances the holder manages; credits spend from the combined `total`.
 * `monthlyAllowance` and `resetsInDays` are legacy fields; the monthly
 * community-pool reset was retired in pricing v1 (cutover 2026-05-18) and
 * `resetsInDays` reports 0 once the cutoff has bound the account.
 */
export interface UsageResponse {
  /** Plan tier (`'starter'`, `'growth'`, …). */
  tier: string;
  /** Spendable credit balance (community + purchased). The number to show. */
  total: number;
  community: {
    /** Credits currently sitting in the community (signup-grant landing) pool. */
    balance: number;
    /**
     * Legacy field. Was the monthly grant credited at reset (e.g. 1000 for
     * starter). Reports 0 for accounts created after the pricing v1 cutoff
     * (2026-05-18). Kept for backward compatibility.
     */
    monthlyAllowance: number;
    /** Bonus credits earned via referrals. Omitted when zero. */
    referralBonus?: number;
    /**
     * Legacy field. Was the days-until-next-monthly-refill counter. Reports 0
     * once the pricing v1 cutoff has bound the account. Kept for backward
     * compatibility.
     */
    resetsInDays: number;
  };
  purchased: {
    /** Non-expiring credits bought via packs. */
    balance: number;
  };
  /** Credits held against in-flight analyze calls — subtract for spendable total. */
  reserved: number;
}

/** Request for looking up a previously analyzed photo. */
export interface LookupRequest {
  /** Image URLs to look up. */
  images?: string[];
  /** Base64-encoded images to look up. */
  imagesBase64?: string[];
  /** SHA-256 hash for direct lookup (GET fast path). */
  sha256?: string;
  /** Perceptual hash for fuzzy lookup (GET fast path). */
  pHash?: string;
  /** Hamming distance threshold for fuzzy matching (default: 5). */
  threshold?: number;
}

/**
 * A single lens index entry from the photo registry.
 *
 * Mirrors the API's `LensIndexEntry` — one entry per lens currently stored
 * on the photo. The `eventId` points at the producing row in `lens_events`.
 */
export interface LensIndexEntry {
  eventId: string;
  output: Record<string, unknown>;
  version: string;
  producedAt: string;
  coRunHash: string;
  provider: string;
}

/**
 * Photo registry record — the persistent memory of a single photo keyed
 * by sha256. Lens outputs are keyed by lens name (not stored as a historical
 * array).
 */
export interface PhotoRecord {
  sha256: string;
  pHash: string;
  dHash: string;
  firstAnalyzedAt: string;
  lastAnalyzedAt: string;
  totalCreditsSpent: number;
  analyzeCallCount: number;
  lenses: Record<string, LensIndexEntry>;
}

/** Lookup result for a single image. */
export interface LookupResult {
  matchType: 'exact' | 'fuzzy' | 'none';
  hammingDistance?: number;
  photo?: PhotoRecord;
  /**
   * Perceptual / cryptographic hashes the API computed for this lookup.
   *
   * Present when the request supplied image bytes (POST path with `images`
   * or `imagesBase64`); absent when the caller used the GET fast-path with a
   * `sha256`/`pHash` query parameter (no bytes to hash).
   *
   * Surfacing the computed hashes on every result — even `matchType: 'none'`
   * — lets template consumers (e.g. `@phototology/vertical-template`)
   * populate per-user dedup indices on first-upload of a brand-new image,
   * so future re-uploads can be recognised without a paid analyze call.
   *
   * Strictly additive in this version. Optional so existing consumers that
   * don't read it stay forward-compatible; null / undefined when the API
   * has not yet shipped the surfacing change.
   */
  computedHashes?: {
    sha256: string;
    pHash: string;
    dHash: string;
  };
}

/** Lookup response from the API. */
export interface LookupResponse {
  object: 'lookup';
  results: Record<string, LookupResult>;
  meta: {
    imagesSubmitted: number;
    imagesMatched: number;
    processingTimeMs: number;
    requestId: string;
  };
}

/**
 * Request body for POST /v2/enrich.
 *
 * Writes cached lens output (from a prior `analyze` call) into the photo's
 * EXIF/IPTC/XMP metadata blocks. Returns the enriched bytes as base64. The
 * photo MUST have been analyzed before; otherwise the API returns 404
 * `PHOTO_NOT_IN_REGISTRY`. Cost: 5 credits per call.
 *
 * c2pa signing is deferred — see Phototology API docs.
 */
export interface EnrichRequest {
  /** Image URL (server fetches). Mutually exclusive with `imageBase64`. */
  imageUrl?: string;
  /** Image as base64. Mutually exclusive with `imageUrl`. */
  imageBase64?: string;
  /** Which metadata blocks to write. At least one required. */
  formats: ('exif' | 'iptc' | 'xmp')[];
}

/** Response from POST /v2/enrich. */
export interface EnrichResponse {
  object: 'enrichment';
  /** Enriched photo bytes, base64-encoded. */
  imageBase64: string;
  /** Which formats were actually written (subset of requested). */
  formatsWritten: ('exif' | 'iptc' | 'xmp')[];
  /** Map of lens name → version that was embedded. */
  lensVersions: Record<string, string>;
  /** SHA-256 of the ORIGINAL (input) bytes. Enriched bytes hash differently. */
  sha256: string;
  meta: {
    requestId: string;
    processingTimeMs: number;
    creditsCharged: number;
    /** EU AI Act Art. 50 transparency flag — always `true`. */
    ai_generated: true;
  };
}

/** SDK client configuration. */
export interface PhototologyClientConfig {
  /** API key (pt_live_ or pt_test_ prefix). Also reads PHOTOTOLOGY_API_KEY env. */
  apiKey?: string;
  /** Base URL for the API. Default: https://api.phototology.com */
  baseUrl?: string;
  /** Maximum number of retries on retryable errors. Default: 3 */
  maxRetries?: number;
  /** Per-attempt request timeout in milliseconds. Default: 30000 */
  timeout?: number;
  /**
   * Overall wall-clock budget across ALL attempts + backoffs, in milliseconds.
   * Bounds the total time a single call can take so a stalled upstream can't
   * hang for `(maxRetries + 1) * timeout`. Default: 90000. Set 0 to disable.
   */
  maxElapsedMs?: number;
  /**
   * Optional User-Agent string. Prepended to the SDK default so server-side
   * observability can identify callers. Example: `"my-app/1.2.0"`.
   * Final UA sent: `"<userAgent> @phototology/sdk/<version>"`.
   */
  userAgent?: string;
}
