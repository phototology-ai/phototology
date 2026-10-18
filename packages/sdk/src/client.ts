import { fetchWithRetry } from './retry';
import { PhototologyError, RateLimitedError, ValidationError, describeWait, rateLimitResetSentence } from './errors';
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  EnrichRequest,
  EnrichResponse,
  LookupRequest,
  LookupResponse,
  ModulesResponse,
  PhotoResponse,
  PhototologyClientConfig,
  Receipt,
  ReceiptJwks,
  UsageResponse,
  VerifyResponse,
} from './types';

const DEFAULT_BASE_URL = 'https://api.phototology.com';
const DEFAULT_MAX_RETRIES = 3;
// Per-attempt timeout. Lowered from 60s (2026-06-02): nothing legitimate
// (lookup/modules/usage/single-photo analyze on flash-lite is ~5s) takes 30s,
// and a 60s per-attempt ceiling let a stalled upstream hang a single attempt
// for a full minute.
const DEFAULT_TIMEOUT = 30_000;
// Overall wall-clock budget across all attempts + backoffs. Without this, the
// worst case was (maxRetries + 1) * timeout ≈ 4 minutes on a flaky upstream.
// 90s leaves room for ~3 attempts of real analyze while bounding the hang.
const DEFAULT_MAX_ELAPSED_MS = 90_000;
// The longest the client sleeps for a rate-limit reset. A daily window can
// report a reset 24 h ahead; sleeping that out hangs every later call.
const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 10_000;
// A request sent with less than this left of maxElapsedMs can only time out,
// so a rate-limit wait that would leave less throws instead.
const MIN_REQUEST_BUDGET_MS = 1_000;

// Bumped when a release needs to flip User-Agent reporting (see CHANGELOG).
// Kept as a string literal rather than a package.json read so Node and edge
// runtimes behave identically.
const SDK_VERSION = '2.0.0';
const DEFAULT_USER_AGENT = `@phototology/sdk/${SDK_VERSION}`;
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/**
 * Phototology API client.
 *
 * Named export (no default) per project convention.
 *
 * @example
 * ```ts
 * import { PhototologyClient } from '@phototology/sdk';
 *
 * const client = new PhototologyClient({ apiKey: 'pt_test_...' });
 * const result = await client.analyze({ imageUrl: 'https://example.com/photo.jpg' });
 * ```
 */
export class PhototologyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly timeout: number;
  private readonly maxElapsedMs: number;
  private readonly maxRateLimitWaitMs: number;
  private readonly userAgent: string;
  /** Unix ms timestamp. If set and in the future, the window is exhausted until then. */
  private rateLimitResetAt: number = 0;
  /** `x-ratelimit-limit` of the exhausted window, for the error message. */
  private rateLimitLimit: string | null = null;

  constructor(config?: PhototologyClientConfig) {
    const apiKey = config?.apiKey ?? process.env.PHOTOTOLOGY_API_KEY;
    if (!apiKey) {
      throw new PhototologyError(
        'API key is required. Pass apiKey in config or set PHOTOTOLOGY_API_KEY environment variable.',
        { code: 'CONFIG_ERROR', status: 0, retryable: false, requestId: 'none' },
      );
    }
    this.apiKey = apiKey;
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.maxRetries = config?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT;
    this.maxElapsedMs = config?.maxElapsedMs ?? DEFAULT_MAX_ELAPSED_MS;
    this.maxRateLimitWaitMs = config?.maxRateLimitWaitMs ?? DEFAULT_MAX_RATE_LIMIT_WAIT_MS;
    this.userAgent = config?.userAgent
      ? `${config.userAgent} ${DEFAULT_USER_AGENT}`
      : DEFAULT_USER_AGENT;
  }

  /**
   * Analyze a photo (or multiple photos).
   *
   * Returns a discriminated union: check `outputSchema` to narrow the output type.
   */
  async analyze(request: AnalyzeRequest): Promise<AnalyzeResponse> {
    // Route to v2 when bespoke extraction is requested
    const path = request.extract ? '/v2/analyze' : '/v1/analyze';
    const response = await this.request('POST', path, request);
    return safeJson<AnalyzeResponse>(response);
  }

  /**
   * List available lenses (individual analysis dimensions) and curated stacks
   * (pre-bundled lenses for specific domains / use-cases). The on-the-wire
   * field names are `modules` and `presets` for back-compat; the concept
   * words are lens / stack.
   */
  async modules(): Promise<ModulesResponse> {
    const response = await this.request('GET', '/v1/modules');
    return safeJson<ModulesResponse>(response);
  }

  /**
   * Fetch the calling key's credit balance.
   *
   * Free: does not bill credits. Use before a batch of analyze calls so the
   * caller can warn the user, pick a cheaper subset of lenses, or surface a
   * purchase link before hitting the out-of-credits error.
   *
   * @returns The dual-pool balance: `community.balance` (signup-grant landing
   *   pool, no longer auto-refills post-pricing-v1), `purchased.balance`
   *   (non-expiring packs), `reserved` (in-flight holds). Effective spendable
   *   credits = `community.balance + purchased.balance - reserved`.
   */
  async usage(): Promise<UsageResponse> {
    const response = await this.request('GET', '/v1/usage');
    return safeJson<UsageResponse>(response);
  }

  /**
   * Write cached lens output into a photo's EXIF/IPTC/XMP metadata
   * blocks. The enriched bytes carry their structured intelligence in
   * standard metadata fields any downstream tool can read, no
   * Phototology API call needed to access the analysis after enrichment.
   *
   * Requires a prior `analyze()` call on the same photo (registry hit
   * by sha256). Throws `ValidationError` with the message
   * `PHOTO_NOT_IN_REGISTRY` if the photo has not been analyzed before.
   *
   * Cost: 5 credits per call. Bills regardless of cache state.
   *
   * When the photo carries a valid or trusted content credential and
   * `preserveCredentials` is not `false`, the response has `mode: 'sidecar'`
   * and the metadata comes back as an XMP packet in `sidecar.xmp` instead of
   * `imageBase64`; save it beside the original as `<file>.xmp`.
   *
   * `preserveCredentials` is always sent (default `true`): the API treats a
   * request without it as a client that cannot read a sidecar.
   *
   * c2pa signing is deferred: `formats: ['c2pa']` is rejected.
   */
  async enrich(request: EnrichRequest): Promise<EnrichResponse> {
    const response = await this.request('POST', '/v2/enrich', {
      ...request,
      preserveCredentials: request.preserveCredentials ?? true,
    });
    return safeJson<EnrichResponse>(response);
  }

  /**
   * Look up previously analyzed photos by image or hash.
   *
   * POST /v2/lookup when images are provided.
   * GET /v2/lookup when sha256 or pHash is provided (fast path).
   *
   * Lookups are free and do not consume credits.
   */
  async lookup(request: LookupRequest): Promise<LookupResponse> {
    // Use GET fast path when client provides a hash directly
    if (request.sha256 || request.pHash) {
      const params = new URLSearchParams();
      if (request.sha256) params.set('sha256', request.sha256);
      if (request.pHash) params.set('pHash', request.pHash);
      if (request.threshold !== undefined) params.set('threshold', String(request.threshold));
      const response = await this.request('GET', `/v2/lookup?${params.toString()}`);
      return safeJson<LookupResponse>(response);
    }

    // POST path for image-based lookup
    const response = await this.request('POST', '/v2/lookup', {
      images: request.images,
      images_base64: request.imagesBase64,
      threshold: request.threshold,
    });
    return safeJson<LookupResponse>(response);
  }

  /**
   * This account's registry record for one photo, with its stored receipts
   * (newest first, at most 10) and the Content Credentials report. Free.
   *
   * Throws a `PhototologyError` with code `PHOTO_NOT_IN_REGISTRY` (404)
   * when this account has not analyzed the photo.
   *
   * Throws `ValidationError` (`VALIDATION_FAILED`) without a request when
   * `sha256` is not 64 hex characters.
   *
   * @param sha256 Hex SHA-256 of the photo's bytes.
   */
  async getPhoto(sha256: string): Promise<PhotoResponse> {
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw new ValidationError('sha256 must be 64 hexadecimal characters', {
        code: 'VALIDATION_FAILED',
        status: 400,
        retryable: false,
        requestId: 'none',
      });
    }
    const response = await this.request('GET', `/v2/photos/${sha256}`);
    return safeJson<PhotoResponse>(response);
  }

  /**
   * Server-side receipt check: the signature against the published keys and
   * the RFC 3161 timestamp against the pinned authority roots. Free.
   *
   * A 4xx (a malformed receipt) throws without a retry. For an offline
   * signature check with no network call, use `verifyReceiptSignature`.
   */
  async verifyReceipt(receipt: Receipt): Promise<VerifyResponse> {
    const response = await this.request('POST', '/v1/verify', { receipt }, { auth: false });
    return safeJson<VerifyResponse>(response);
  }

  /**
   * The receipt-signing public keys (`/.well-known/phototology-keys.json`).
   * Pass the result to `verifyReceiptSignature`. Cache it: keys are only
   * ever added, so old receipts keep verifying.
   */
  async getJwks(): Promise<ReceiptJwks> {
    const response = await this.request('GET', '/.well-known/phototology-keys.json', undefined, { auth: false });
    return safeJson<ReceiptJwks>(response);
  }

  /**
   * Send a request with retry and pre-emptive rate limit backoff. The API key
   * goes only to routes that need it: `auth: false` (verify, the key set)
   * keeps it off public routes that take no key.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts: { auth?: boolean } = {},
  ): Promise<Response> {
    // Pre-emptive backoff: if we know we're rate-limited, wait until reset,
    // but never longer than maxRateLimitWaitMs. Past that, throw without
    // sending: the request would only spend another call on a 429. The wait
    // counts against maxElapsedMs: a wait that would leave the request less
    // than MIN_REQUEST_BUDGET_MS throws too, and the request gets what is left.
    const startedAt = Date.now();
    const bounded = this.maxElapsedMs > 0;
    const waitMs = this.rateLimitResetAt - startedAt;
    if (waitMs > 0) {
      if (waitMs > this.maxRateLimitWaitMs) {
        throw this.rateLimitedBeforeSend(rateLimitResetSentence(Math.ceil(waitMs / 1000), this.maxRateLimitWaitMs));
      }
      if (bounded && this.maxElapsedMs - waitMs <= MIN_REQUEST_BUDGET_MS) {
        throw this.rateLimitedBeforeSend(this.budgetSentence(waitMs));
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      // A slow timer can eat the margin checked above; check what is really
      // left. Only after a sleep: with no wait, a small maxElapsedMs is the
      // caller's choice and the request goes out.
      const sleptMs = Date.now() - startedAt;
      if (bounded && this.maxElapsedMs - sleptMs <= MIN_REQUEST_BUDGET_MS) {
        throw this.rateLimitedBeforeSend(
          `The client waited ${describeWait(Math.ceil(sleptMs / 1000))} for the limit to reset, which left this call ` +
            `less than ${MIN_REQUEST_BUDGET_MS / 1000} second of its ${Math.round(this.maxElapsedMs / 1000)} second budget ` +
            '(maxElapsedMs), so it did not send the request.',
        );
      }
    }
    // 0 means "no deadline" to fetchWithRetry; when bounded it is at least 1.
    const remainingBudgetMs = bounded
      ? Math.max(1, this.maxElapsedMs - (Date.now() - startedAt))
      : 0;

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      ...(opts.auth === false ? {} : { 'Authorization': `Bearer ${this.apiKey}` }),
      'Content-Type': 'application/json',
      'User-Agent': this.userAgent,
    };

    const init: RequestInit = {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    let response: Response;
    try {
      response = await fetchWithRetry(url, init, {
        maxRetries: this.maxRetries,
        timeout: this.timeout,
        maxElapsedMs: remainingBudgetMs,
        maxRateLimitWaitMs: this.maxRateLimitWaitMs,
      });
    } catch (err) {
      // Remember a 429's reset so the next call fails fast instead of
      // spending another request on the same exhausted window.
      if (err instanceof RateLimitedError && err.retryAfterSeconds) {
        this.rateLimitResetAt = Date.now() + err.retryAfterSeconds * 1000;
      }
      throw err;
    }

    // Track rate limit state from response headers
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      const reset = response.headers.get('x-ratelimit-reset');
      if (reset) {
        this.rateLimitResetAt = parseInt(reset, 10) * 1000; // Unix seconds to ms
        this.rateLimitLimit = response.headers.get('x-ratelimit-limit');
      }
    } else if (remaining !== null) {
      this.rateLimitResetAt = 0;
    }

    return response;
  }

  /**
   * A RateLimitedError for a request the client decided not to send.
   * `retryAfterSeconds` is the time until the real reset: 0 once it has passed.
   */
  private rateLimitedBeforeSend(why: string): RateLimitedError {
    const seconds = Math.ceil(Math.max(0, this.rateLimitResetAt - Date.now()) / 1000);
    const used = this.rateLimitLimit
      ? `all ${this.rateLimitLimit} requests in the current window are used`
      : 'no requests are left in the current window';
    // Once the reset has passed, the window is open again; only the budget is gone.
    const opening = seconds === 0 ? 'Rate limit window has reset' : `Rate limit reached: ${used}`;
    return new RateLimitedError(
      `${opening}. ${why}`,
      { code: 'RATE_LIMITED', status: 429, retryable: true, requestId: 'none' },
      seconds,
    );
  }

  /** Why a wait inside the window was not taken: it would use up maxElapsedMs. */
  private budgetSentence(waitMs: number): string {
    const seconds = Math.max(1, Math.ceil(waitMs / 1000));
    const at = new Date(Date.now() + waitMs).toISOString();
    return `The limit resets in ${describeWait(seconds)} (at ${at}). ` +
      `Waiting for it would leave this call less than ${MIN_REQUEST_BUDGET_MS / 1000} second of its ` +
      `${Math.round(this.maxElapsedMs / 1000)} second budget (maxElapsedMs), so the client did not send the request.`;
  }
}

async function safeJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new PhototologyError('Server returned non-JSON response', {
      code: 'PARSE_FAILED',
      status: response.status,
      retryable: false,
      requestId: 'unknown',
    });
  }
}
