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

/** Photo analysis output (opaque record; fields vary by modules used). */
export type PhotoOutput = Record<string, unknown>;

/** Inclusive year range of a date estimate. */
export interface YearRange {
  from: number;
  to: number;
}

/**
 * Shape of `output.estimatedDate` from the `dating` lens. Every field is
 * optional; read it from {@link PhotoOutput} with a cast, e.g.
 * `const date = result.output.estimatedDate as EstimatedDate | undefined`.
 *
 * `yearRange` (added 2026-10) is the primary estimate. `year` is kept for
 * backward compatibility: the model's best single year, or the range midpoint
 * when only a range was returned. `rangeLabel` is a display string such as
 * `"c. 1975–1985"`. Process type or print look alone is always `low`.
 */
export interface EstimatedDate {
  year?: number | null;
  yearRange?: YearRange | null;
  rangeLabel?: string;
  decade?: string | null;
  confidence?: 'high' | 'medium' | 'low';
  reasoning?: string;
}

/** Vehicle condition output (opaque record; fields vary by modules used). */
export type VehicleOutput = Record<string, unknown>;

/** Usage information from analysis. */
export interface AnalyzeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modulesUsed: string[];
  /** Number of credits charged for this analysis. */
  creditsCharged?: number;
  /** Billable lens runs served from the cache instead of charged. 0 on a fresh run. */
  creditsSaved?: number;
  /** Dollar equivalents at $0.01 per credit, as strings with two decimals (e.g. "0.05"). */
  usd?: { charged: string; saved: string };
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

/** PDQ perceptual hash (Meta, 256 bits) with its quality and dihedral variants. */
export interface PdqFingerprint {
  /** 64 lowercase hex characters. */
  hash: string;
  /** 0 to 100; matches need at least 50 on both sides. */
  quality: number;
  /** The 8 dihedral hashes (original, rotations, flips); the first equals `hash`. */
  variants: string[];
}

/** Fingerprint data (when requested). */
export interface Fingerprint {
  pHash: string;
  dHash: string;
  sha256: string;
  /** SHA-256 of the decoded pixels: equal for files that differ only in metadata. Absent above 40 MP. */
  pixelsSha256?: string;
  /** PDQ hash; survives re-encodes, rotations and flips. */
  pdq?: PdqFingerprint;
  /** ISCC Image-Code (ISO 24138), e.g. `ISCC:EEA4GQZQTY6J5DTH`. */
  iscc?: string;
}

/**
 * What a receipt says about the photo it covers. `bytesSha256` is the
 * registry key; the perceptual hashes let a verifier match re-encoded copies.
 */
export interface ReceiptSubject {
  bytesSha256: string;
  pixelsSha256?: string;
  pHash: string;
  dHash: string;
  pdq?: { hash: string; quality: number };
  iscc?: string;
}

/** One lens a receipt covers, with the SHA-256 of that lens's canonical output. */
export interface ReceiptLens {
  id: string;
  version: string;
  outputSha256: string;
}

/**
 * What a receipt records about the photo's incoming Content Credentials: the
 * status, and (on receipts issued since credentials are read) whether the
 * manifest declares an AI source, the signer and the trust list. Receipts
 * issued before that carry `{ status: 'unread' }` only.
 */
export interface ReceiptCredentials {
  status: CredentialsReport['status'];
  aiGenerated?: CredentialsReport['aiGenerated'];
  signer?: CredentialsReport['signer'];
  trustList?: CredentialsReport['trustList'];
}

/**
 * The signed part of a receipt. Its canonical JSON (RFC 8785) is the
 * signing input, so every field here is part of the signed contract.
 */
export interface ReceiptPayload {
  type: 'phototology.receipt';
  version: 1;
  id: string;
  livemode: boolean;
  issuer: 'https://phototology.com';
  keyId: string;
  subject: ReceiptSubject;
  analysis: {
    requestId: string;
    lenses: ReceiptLens[];
    provider: string;
    model: string | null;
    modelVersion: string | null;
    outputSha256: string;
    analyzedAt: string;
  };
  firstSeenAt: string;
  credentials: ReceiptCredentials;
  registry: { url: string };
}

/**
 * RFC 3161 timestamp over the receipt signature. `tsa` names the timestamp
 * authority that issued `token` (base64 DER TimeStampToken, the token alone,
 * not the full TSA response). `time` is the token's own genTime.
 */
export interface ReceiptTimestamp {
  status: 'ok' | 'pending' | 'unavailable';
  tsa?: string;
  token?: string;
  time?: string;
}

/**
 * A signed receipt for the lenses that ran fresh in one analyze call.
 * `signature` is a detached compact JWS (`header..signature`, ES256) over
 * the canonical JSON of `payload`. Check it offline with
 * `verifyReceiptSignature`, or server-side with `client.verifyReceipt`.
 */
export interface Receipt {
  payload: ReceiptPayload;
  signature: string;
  timestamp: ReceiptTimestamp;
}

/**
 * A receipt-signing public key from the JWKS (EC P-256, ES256). The sandbox
 * key carries `phototology.sandbox: true`. Declared here rather than reusing
 * the DOM `JsonWebKey` so the SDK's types compile without the DOM lib.
 */
export interface ReceiptJwk {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
  use?: string;
  alg?: string;
  'phototology.sandbox'?: boolean;
}

/** GET /.well-known/phototology-keys.json */
export interface ReceiptJwks {
  keys: ReceiptJwk[];
}

/**
 * POST /v1/verify response. `valid` is true when the signature is valid
 * and the timestamp is valid, pending or unavailable. The timestamp is
 * `invalid` when `timestamp.time` differs from the token's own time.
 */
export interface VerifyResponse {
  valid: boolean;
  livemode: boolean;
  keyId: string;
  signature: 'valid' | 'invalid' | 'unknown_key';
  timestamp: 'valid' | 'invalid' | 'pending' | 'unavailable' | 'untrusted_root';
  /**
   * The time inside the timestamp token when the timestamp is valid, else
   * null. Absent from servers deployed before this field existed.
   */
  timestampedAt?: string | null;
  issuedAt: string;
  checkedAt: string;
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
  /**
   * Signed receipts: the new receipt for lenses that ran in this call first,
   * then stored receipts covering cached lenses. Empty, with a `RECEIPT_*`
   * warning, when none was issued. Absent on a moderation-block response,
   * which carries no analysis.
   */
  receipts?: Receipt[];
  /** Content Credentials report for the submitted photo. */
  credentials?: CredentialsReport;
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

/** Discriminated union: narrows output type based on outputSchema. */
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
  /** `true` if this lens is real but NOT directly selectable via `modules: []`; reachable only through a curated stack (e.g. `vehicle-condition`). Omitted for the 15 directly-selectable lenses. */
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
 * Response from GET /v1/usage: the calling key's credit balance.
 *
 * `total` is the spendable credit balance: the single number to show and
 * reason about. `reserved` is the in-flight hold from running analyze calls;
 * effective spendable = `total - reserved`.
 *
 * The `community` / `purchased` breakdown is retained for back-compat (and
 * powers refund-to-origin accounting internally). It is NOT two separate
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
  /** Credits held against in-flight analyze calls. Subtract for spendable total. */
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
  /**
   * Perceptual hash for fuzzy lookup (GET fast path): the 64-character bit
   * string analyze and lookup return, or the same 64 bits as 16 hex characters.
   */
  pHash?: string;
  /** Hamming distance threshold for fuzzy matching (default: 5). */
  threshold?: number;
}

/**
 * A single lens index entry from the photo registry.
 *
 * Mirrors the API's `LensIndexEntry`: one entry per lens currently stored
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
 * Photo registry record: the persistent memory of a single photo keyed
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
  /**
   * Identity hashes; present only on photos analyzed since they were recorded.
   * Same shape as {@link Fingerprint}: PDQ nests, `pixelsSha256` and `iscc` are flat.
   */
  pixelsSha256?: string;
  pdq?: PdqFingerprint;
  iscc?: string;
}

/** Lookup result for a single image. */
export interface LookupResult {
  /**
   * Which tier matched, tried in this order: `exact` (same bytes), `pixels`
   * (same decoded pixels, metadata differs), `pdq` (PDQ within 31 bits, e.g.
   * a re-encode, rotation or flip), `fuzzy` (pHash within `threshold`).
   */
  matchType: 'exact' | 'pixels' | 'pdq' | 'fuzzy' | 'none';
  /** PDQ Hamming distance; present only when `matchType` is `'pdq'`. */
  pdqDistance?: number;
  /** pHash Hamming distance; present only when `matchType` is `'fuzzy'`. */
  hammingDistance?: number;
  photo?: PhotoRecord;
  /**
   * Perceptual / cryptographic hashes the API computed for this lookup.
   *
   * Present when the request supplied image bytes (POST path with `images`
   * or `imagesBase64`); absent when the caller used the GET fast-path with a
   * `sha256`/`pHash` query parameter (no bytes to hash).
   *
   * Surfacing the computed hashes on every result (even `matchType: 'none'`)
   * lets template consumers (e.g. `@phototology/vertical-template`)
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
  /**
   * Stored receipts for the matched photo, newest first, at most 10. `[]`
   * on `matchType: 'none'` and for photos analyzed before receipts existed.
   * Optional for API versions that predate receipts.
   */
  receipts?: Receipt[];
  /** Content Credentials report, when the API includes one. */
  credentials?: CredentialsReport;
}

/**
 * GET /v2/photos/{sha256}: this account's registry record for one photo,
 * its stored receipts (newest first, at most 10) and the credentials report.
 */
export interface PhotoResponse {
  object: 'photo';
  photo: PhotoRecord;
  receipts: Receipt[];
  credentials: CredentialsReport;
  firstSeenAt: string;
  lastAnalyzedAt: string;
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
 * c2pa signing is deferred; see Phototology API docs.
 */
export interface EnrichRequest {
  /** Image URL (server fetches). Mutually exclusive with `imageBase64`. */
  imageUrl?: string;
  /** Image as base64. Mutually exclusive with `imageUrl`. */
  imageBase64?: string;
  /** Which metadata blocks to write. At least one required. */
  formats: ('exif' | 'iptc' | 'xmp')[];
  /**
   * Keep the photo's content credential intact. Defaults to `true`, and the
   * SDK always sends it: when the photo carries a valid or trusted credential,
   * the API returns an XMP sidecar (`mode: 'sidecar'`) instead of writing into
   * the file. `false` writes into the file anyway and the response warns
   * `CREDENTIAL_INVALIDATED`.
   */
  preserveCredentials?: boolean;
}

/** Incoming content credentials the API read from the input photo. */
export interface CredentialsReport {
  status: 'none' | 'invalid' | 'valid' | 'trusted' | 'unread';
  /** True when the manifest declares a trained-model source; null when no manifest was read. */
  aiGenerated: boolean | null;
  signer: { name: string; issuer: string } | null;
  captureDevice: string | null;
  signedAt: string | null;
  /** Which trust list the signer chains to; null unless `status` is `trusted`. */
  trustList: 'c2pa' | 'legacy' | null;
  assertions: string[];
  note: string;
}

/** Response from POST /v2/enrich. */
export interface EnrichResponse {
  object: 'enrichment';
  /**
   * `file`: the metadata was written into the image, returned as `imageBase64`.
   * `sidecar`: the photo carries a valid or trusted content credential that a
   * write would break, so the metadata comes back as an XMP packet in
   * `sidecar.xmp` and the image is left untouched. Billed the same either way.
   */
  mode: 'file' | 'sidecar';
  /** Enriched photo bytes, base64-encoded. `mode: 'file'` only. */
  imageBase64?: string;
  /** The XMP sidecar packet, `mode: 'sidecar'` only. Save it beside the original as `<file>.xmp`. */
  sidecar?: { xmp: string };
  /** Which formats were actually written (subset of requested; `['xmp']` for a sidecar). */
  formatsWritten: ('exif' | 'iptc' | 'xmp')[];
  /** Why a sidecar was returned, `mode: 'sidecar'` only. */
  reason?: string;
  /**
   * `CREDENTIAL_INVALIDATED` when the in-file write went over a valid or trusted
   * credential (`preserveCredentials: false`). `CREDENTIALS_UNREAD` when the
   * API's credential reader is on but could not read the photo in time, so the
   * copy was written without knowing whether it carried a credential.
   */
  warnings?: string[];
  /** Incoming content credentials read from the input. */
  credentials: CredentialsReport;
  /** Map of lens name → version that was embedded. */
  lensVersions: Record<string, string>;
  /** SHA-256 of the ORIGINAL (input) bytes. Enriched bytes hash differently. */
  sha256: string;
  /**
   * Registry id written into the file's XMP: the sha256 of the original bytes,
   * read back by a later lookup. Present only when the write stored it.
   */
  registryId?: string;
  meta: {
    requestId: string;
    processingTimeMs: number;
    creditsCharged: number;
    /** EU AI Act Art. 50 transparency flag, always `true`. */
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
   * The longest the client will wait for a rate-limit window to reset, in
   * milliseconds. A wait learned from `Retry-After` or `x-ratelimit-reset`
   * that is longer than this is not slept: the call throws `RateLimitedError`
   * with `retryAfterSeconds` instead, without sending the request. Default: 10000.
   */
  maxRateLimitWaitMs?: number;
  /**
   * Optional User-Agent string. Prepended to the SDK default so server-side
   * observability can identify callers. Example: `"my-app/1.2.0"`.
   * Final UA sent: `"<userAgent> @phototology/sdk/<version>"`.
   */
  userAgent?: string;
}
