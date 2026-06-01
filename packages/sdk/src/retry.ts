import { PhototologyError } from './errors';
import type { ErrorResponse } from './types';

export interface RetryConfig {
  maxRetries: number;
  timeout: number;
}

/**
 * Fetch with automatic retry on retryable errors.
 *
 * - Respects Retry-After header exactly (seconds)
 * - Uses exponential backoff: 500ms, 1s, 2s, 4s... capped at 8s
 * - Throws immediately on non-retryable errors
 * - Never logs or includes API keys in errors
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  config: RetryConfig,
): Promise<Response> {
  let lastError: PhototologyError | undefined;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

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
        await sleep(backoff(attempt));
        continue;
      }
      const networkErr = new PhototologyError(
        err instanceof Error ? err.message : 'Network error',
        { code: 'NETWORK_ERROR', status: 0, retryable: true, requestId: 'unknown' },
      );
      if (attempt >= config.maxRetries) throw networkErr;
      lastError = networkErr;
      const backoffMs = Math.min(500 * Math.pow(2, attempt), 8000);
      await sleep(backoffMs);
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
      // Non-JSON error response — wrap as internal error
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

    lastError = error;

    // Don't sleep after the last attempt
    if (attempt < config.maxRetries) {
      // Respect Retry-After header if present
      const retryAfter = response.headers.get('retry-after');
      if (retryAfter) {
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds) && seconds > 0) {
          await sleep(seconds * 1000);
          continue;
        }
      }

      await sleep(backoff(attempt));
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(500 * Math.pow(2, attempt), 8000);
}
