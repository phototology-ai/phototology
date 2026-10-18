import type { ErrorResponse } from './types';

/** Regex to match API keys in error messages. */
const API_KEY_PATTERN = /pt_(live|test)_[a-zA-Z0-9_-]+/g;

/** Redact API keys from a string. */
function redactApiKeys(message: string): string {
  return message.replace(API_KEY_PATTERN, '[REDACTED]');
}

/** Options for constructing a PhototologyError. */
export interface PhototologyErrorOptions {
  code: string;
  status: number;
  retryable: boolean;
  requestId: string;
}

/**
 * Base error class for all Phototology API errors.
 *
 * Never includes API keys in error messages.
 */
export class PhototologyError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId: string;

  constructor(message: string, options: PhototologyErrorOptions) {
    super(redactApiKeys(message));
    this.name = 'PhototologyError';
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.requestId = options.requestId;
  }

  /**
   * Create the appropriate error subclass from an API error response.
   */
  static fromResponse(
    status: number,
    body: ErrorResponse,
    headers?: Record<string, string>,
  ): PhototologyError {
    const { code, message, retryable, requestId } = body.error;
    const opts: PhototologyErrorOptions = { code, status, retryable, requestId };

    switch (code) {
      case 'AUTH_FAILED':
        return new AuthenticationError(message, opts);
      case 'VALIDATION_FAILED':
      case 'IMAGE_INVALID':
      case 'IMAGE_TOO_LARGE':
      case 'CONTENT_FILTERED':
        return new ValidationError(message, opts);
      case 'RATE_LIMITED': {
        const retryAfter = headers?.['retry-after']
          ? parseInt(headers['retry-after'], 10)
          : undefined;
        return new RateLimitedError(message, opts, retryAfter);
      }
      case 'PARSE_FAILED':
        return new ParseError(message, opts);
      case 'INTERNAL_ERROR':
        return new InternalError(message, opts);
      case 'PROVIDER_UNAVAILABLE':
      case 'PROVIDER_ERROR':
        return new ProviderError(message, opts);
      case 'PLAN_LIMIT_EXCEEDED': {
        // When the API attaches a credits payload (dual-pool billing),
        // surface a richer CreditExhaustedError subtype.
        const credits = body.error.credits;
        if (credits) {
          return new CreditExhaustedError(message, {
            ...opts,
            creditsRequired: credits.needed,
            communityBalance: credits.community,
            purchasedBalance: credits.purchased,
            totalBalance: credits.total,
            resetsInDays: credits.resetsInDays,
          });
        }
        return new PlanLimitError(message, opts);
      }
      default:
        return new PhototologyError(message, opts);
    }
  }
}

export class AuthenticationError extends PhototologyError {
  constructor(message: string, options: PhototologyErrorOptions) {
    super(message, options);
    this.name = 'AuthenticationError';
  }
}

export class ValidationError extends PhototologyError {
  constructor(message: string, options: PhototologyErrorOptions) {
    super(message, options);
    this.name = 'ValidationError';
  }
}

/**
 * Thrown on a 429, and without sending a request when the client already knows
 * the rate-limit window will not reset within `maxRateLimitWaitMs`.
 */
export class RateLimitedError extends PhototologyError {
  /** Seconds until the limit resets, when known. Same value as `retryAfterSeconds`. */
  readonly retryAfter?: number;
  /** Seconds until the limit resets, when known. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: PhototologyErrorOptions, retryAfter?: number) {
    super(message, options);
    this.name = 'RateLimitedError';
    this.retryAfter = retryAfter;
    this.retryAfterSeconds = retryAfter;
  }
}

export class ParseError extends PhototologyError {
  constructor(message: string, options: PhototologyErrorOptions) {
    super(message, options);
    this.name = 'ParseError';
  }
}

export class InternalError extends PhototologyError {
  constructor(message: string, options: PhototologyErrorOptions) {
    super(message, options);
    this.name = 'InternalError';
  }
}

export class ProviderError extends PhototologyError {
  constructor(message: string, options: PhototologyErrorOptions) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

export class PlanLimitError extends PhototologyError {
  constructor(message: string, options: PhototologyErrorOptions) {
    super(message, options);
    this.name = 'PlanLimitError';
  }
}

/** Default purchase URL returned in CreditExhaustedError when none is supplied. */
export const DEFAULT_PURCHASE_URL = 'https://phototology.com/wallet';

/** Options for constructing a CreditExhaustedError. */
export interface CreditExhaustedErrorOptions extends PhototologyErrorOptions {
  /** Total credits required to complete the requested analysis. */
  creditsRequired: number;
  /** Credits currently in the community (signup-grant landing) pool. */
  communityBalance: number;
  /** Credits currently in the purchased (non-expiring) pool. */
  purchasedBalance: number;
  /** Sum of community + purchased pools. */
  totalBalance: number;
  /** Days until the community pool refills. Undefined when the user has no community pool. */
  resetsInDays?: number;
  /** URL where the caller can buy more credits. Defaults to DEFAULT_PURCHASE_URL. */
  purchaseUrl?: string;
}

/**
 * Thrown when the API returns 402 `PLAN_LIMIT_EXCEEDED` with credit-pool
 * information attached to the error body.
 *
 * Extends `PlanLimitError` so existing handlers that catch `PlanLimitError`
 * continue to work while new callers can branch on the richer subtype.
 */
export class CreditExhaustedError extends PlanLimitError {
  readonly creditsRequired: number;
  readonly communityBalance: number;
  readonly purchasedBalance: number;
  readonly totalBalance: number;
  readonly resetsInDays?: number;
  readonly purchaseUrl: string;

  constructor(message: string, options: CreditExhaustedErrorOptions) {
    super(message, options);
    this.name = 'CreditExhaustedError';
    this.creditsRequired = options.creditsRequired;
    this.communityBalance = options.communityBalance;
    this.purchasedBalance = options.purchasedBalance;
    this.totalBalance = options.totalBalance;
    this.resetsInDays = options.resetsInDays;
    this.purchaseUrl = options.purchaseUrl ?? DEFAULT_PURCHASE_URL;
  }
}

/** "45 seconds", "12 minutes", "24 hours": a wait a person can read. */
export function describeWait(seconds: number): string {
  if (seconds < 120) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  if (seconds < 2 * 60 * 60) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

/** The sentence appended to a rate-limit message: when it resets, and why the client did not wait. */
export function rateLimitResetSentence(seconds: number, maxWaitMs: number): string {
  const at = new Date(Date.now() + seconds * 1000).toISOString();
  return `The limit resets in ${describeWait(seconds)} (at ${at}). ` +
    `The client waits at most ${Math.round(maxWaitMs / 1000)} seconds for a reset (maxRateLimitWaitMs), so it did not send the request.`;
}
