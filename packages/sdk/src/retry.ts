import { PhototologyError, RateLimitedError, rateLimitResetSentence } from './errors';
import type { ErrorResponse } from './types';

export interface RetryConfig {
  maxRetries: number;
  /** Per-attempt timeout in ms (each retry gets its own fresh timeout). */
  timeout: number;
  /**
   * Overall wall-clock budget across ALL attempts + backoffs, in ms. Without
   * it, a stalled upstream could burn `timeout` on every attempt, up to
   * `(maxRetries + 1) * timeout` (~minutes). The deadline bounds the total time
   * a single call can take: each attempt's timeout is clamped to the remaining
   * budget and backoff sleeps never sleep past it. `undefined`/`0` = unbounded
   * (legacy behavior). Default is set by the client (90s).
   */
  maxElapsedMs?: number;
  /**
   * The longest a 429 may be waited out, in ms. When the wait it names
   * (`Retry-After`, or `x-ratelimit-reset` when `x-ratelimit-remaining` is 0,
   * whichever is later) is longer, the 429 is thrown at once as a
   * `RateLimitedError` carrying that wait. `undefined` = no cap (legacy).
   */
  maxRateLimitWaitMs?: number;
}

/**
 * Fetch with automatic retry on retryable errors.
 *
 * - Respects Retry-After header exactly (seconds)
 * - Uses exponential backoff: 500ms, 1s, 2s, 4s... capped at 8s
 * - Throws immediately on non-retryable errors
 * - Bounds total wall-clock time via `maxElapsedMs` (no multi-minute hangs)
 * - Never logs or includes API keys in errors
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  config: RetryConfig,
): Promise<Response> {
  let lastError: PhototologyError | undefined;

  const deadline =
    config.maxElapsedMs && config.maxElapsedMs > 0
      ? Date.now() + config.maxElapsedMs
      : Infinity;
  const remainingMs = (): number => deadline - Date.now();
  // Backoff that never sleeps past the overall deadline.
  const cappedSleep = (ms: number): Promise<void> => sleep(Math.max(0, Math.min(ms, remainingMs())));

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    // Out of total budget: stop retrying and surface the last error.
    if (remainingMs() <= 0) {
      throw lastError ?? deadlineError();
    }

    const controller = new AbortController();
    // Clamp the per-attempt timeout to whatever budget is left.
    const attemptTimeout = Math.min(config.timeout, remainingMs());
    const timeoutId = setTimeout(() => controller.abort(), attemptTimeout);

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === 'AbortError') {
        const timeoutErr = new PhototologyError('Request timed out', {
          code: 'TIMEOUT',
          status: 0,
          retryable: true,
          requestId: 'unknown',
        });
        if (attempt >= config.maxRetries) throw timeoutErr;
        lastError = timeoutErr;
        await cappedSleep(backoff(attempt));
        continue;
      }
      const networkErr = new PhototologyError(
        err instanceof Error ? err.message : 'Network error',
        { code: 'NETWORK_ERROR', status: 0, retryable: true, requestId: 'unknown' },
      );
      if (attempt >= config.maxRetries) throw networkErr;
      lastError = networkErr;
      const backoffMs = Math.min(500 * Math.pow(2, attempt), 8000);
      await cappedSleep(backoffMs);
      continue;
    } finally {
      clearTimeout(timeoutId);
    }

    if (response.ok) {
      return response;
    }

    // Parse error response
    let errorBody: ErrorResponse;
    try {
      errorBody = await response.json() as ErrorResponse;
    } catch {
      // Non-JSON error response: wrap as internal error
      throw new PhototologyError('Server returned non-JSON error response', {
        code: 'INTERNAL_ERROR',
        status: response.status,
        retryable: false,
        requestId: 'unknown',
      });
    }

    // Build headers record for fromResponse
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const error = PhototologyError.fromResponse(response.status, errorBody, headers);

    // Non-retryable errors throw immediately
    if (!error.retryable) {
      throw error;
    }

    // A 429 is waited out only when its reset is within maxRateLimitWaitMs.
    if (response.status === 429 && config.maxRateLimitWaitMs !== undefined) {
      const waitSeconds = rateLimitWaitSeconds(response.headers);
      if (waitSeconds !== undefined && waitSeconds * 1000 > config.maxRateLimitWaitMs) {
        throw new RateLimitedError(
          `${error.message} ${rateLimitResetSentence(waitSeconds, config.maxRateLimitWaitMs)}`,
          { code: error.code, status: error.status, retryable: error.retryable, requestId: error.requestId },
          waitSeconds,
        );
      }
    }

    lastError = error;

    // Don't sleep after the last attempt
    if (attempt < config.maxRetries) {
      // Respect Retry-After header if present
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds) && seconds > 0) {
          await cappedSleep(seconds * 1000);
          continue;
        }
      }

      await cappedSleep(backoff(attempt));
    }
  }

  // All retries exhausted
  throw lastError ?? new PhototologyError('Max retries exceeded', {
    code: 'MAX_RETRIES',
    status: 0,
    retryable: false,
    requestId: 'unknown',
  });
}

/**
 * Seconds until a 429 clears: `Retry-After`, or the `x-ratelimit-reset` of an
 * exhausted window when that is later (a daily window's 429 can still say
 * `Retry-After: 60`). `undefined` when neither header is usable.
 */
export function rateLimitWaitSeconds(headers: Headers): number | undefined {
  let wait: number | undefined;
  const retryAfter = parseInt(headers.get('retry-after') ?? '', 10);
  if (!isNaN(retryAfter) && retryAfter > 0) wait = retryAfter;
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = parseInt(headers.get('x-ratelimit-reset') ?? '', 10);
    if (!isNaN(reset)) {
      const untilReset = Math.ceil(reset - Date.now() / 1000);
      if (untilReset > 0 && (wait === undefined || untilReset > wait)) wait = untilReset;
    }
  }
  return wait;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deadlineError(): PhototologyError {
  return new PhototologyError('Request deadline exceeded', {
    code: 'TIMEOUT',
    status: 0,
    retryable: false,
    requestId: 'unknown',
  });
}

function backoff(attempt: number): number {
  return Math.min(500 * Math.pow(2, attempt), 8000);
}
