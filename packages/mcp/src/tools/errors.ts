import { CreditExhaustedError, AuthenticationError, PhototologyError, RateLimitedError } from '@phototology/sdk';
import { LocalImageError } from '../lib/local-image';
import { DEFAULT_API_BASE_URL, SIGNUP_URL, getKeyStatus } from '../lib/key-status';

interface RenderedError {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
}

/**
 * Render an SDK error as an MCP tool execution result.
 *
 * An error result carries NO `structuredContent`. The official client
 * (@modelcontextprotocol/sdk 1.32) validates `structuredContent` against the
 * tool's outputSchema even when `isError` is true, so an error object there
 * reached the agent as "-32602 Structured content does not match the tool's
 * output schema" and the readable text was lost (2026-10-18 end-to-end run).
 * Instead the first text line is JSON with the machine fields (`code`,
 * `retryable`, and per error `retryAfterSeconds`, `actionUrl`, ...), and the
 * sentence for the agent follows on the next line.
 *
 * Local-file errors follow the same shape (`code`, `retryable: false`, and
 * `path` / `sizeBytes` / `detail`); a plain Error stays `Error: <message>`.
 */
/** The plain sentence about the sandbox limits, also in the server instructions. */
export const SANDBOX_RATE_LIMIT_SENTENCE =
  `The sandbox key allows 2 requests a minute and 10 a day per IP; sign up for an account key at ${SIGNUP_URL} to lift this.`;

/** The SANDBOX_KEY explanation, also in the server instructions. */
export const SANDBOX_KEY_SENTENCE =
  'Sandbox keys cannot read the registry or a balance, or write metadata into a photo; analyze_photo and analyze_batch return fixture data; get an account key for lookups and balances';

export function renderToolError(err: unknown): RenderedError {
  const rendered = renderError(err);
  // A failed start-up key check explains most later failures: say so on
  // every error rather than only in the stderr line nobody reads.
  // A rate limit already says what to do; the note would only repeat it. A
  // bad local path has nothing to do with the key.
  const problem = getKeyStatus().startupProblem;
  if (problem && rendered.content[0] && !(err instanceof LocalImageError || err instanceof RateLimitedError)) {
    rendered.content[0] = {
      type: 'text' as const,
      text: `${rendered.content[0].text}\n(At start-up the API key check failed: ${problem})`,
    };
  }
  return rendered;
}

function renderError(err: unknown): RenderedError {
  // A local path or file problem: never retryable as is, the call must change.
  if (err instanceof LocalImageError) {
    return errorResult(
      {
        code: err.code,
        retryable: false,
        ...(err.path ? { path: err.path } : {}),
        ...(err.sizeBytes !== undefined ? { sizeBytes: err.sizeBytes } : {}),
        ...(err.detail ? { detail: err.detail } : {}),
      },
      err.message,
    );
  }

  if (err instanceof CreditExhaustedError) {
    // C1 (PostHog remediation): live data showed an agent re-call analyze_photo
    // 58× against this exact error. The text now leads with the machine code
    // and spells out non-retryability + agents-cannot-purchase + STOP, so a
    // model reads "hand off to a human and stop" rather than "transient, retry".
    // Threat-model C-T2: interpolate ONLY numeric/constant values (balance,
    // creditsRequired, resetsInDays, the constant purchaseUrl), never tool
    // input, filename, or lens names.
    const lines = [
      `OUT_OF_CREDITS: Balance ${err.totalBalance}, need ${err.creditsRequired} credits. ` +
        `This is NOT retryable. Re-calling analyze_photo will fail again until a human adds credits. ` +
        `Agents cannot purchase; checkout requires a human in a browser.`,
      `ACTION: tell your user to open ${err.purchaseUrl} and buy credits ` +
        `(first purchase doubles, so Starter $10 buys 2,000 credits the first time).`,
    ];
    if (typeof err.resetsInDays === 'number') {
      lines.push(`Community credits auto-refill in ${err.resetsInDays} days, but do not poll for that.`);
    }
    lines.push('Then STOP. Do not retry analyze_photo or loop get_credits; wait for the user, or move on.');
    return errorResult(
      { code: 'OUT_OF_CREDITS', retryable: false, actionUrl: err.purchaseUrl, creditsRequired: err.creditsRequired, balance: err.totalBalance },
      lines.join(' '),
    );
  }

  // The SDK throws RateLimitedError at once when a window will not reset
  // within its wait cap; pass the wait on so the agent does not retry blind.
  if (err instanceof RateLimitedError) {
    const wait = err.retryAfterSeconds;
    // Past MAX_RETRYABLE_WAIT_SECONDS no retry inside an agent session helps.
    const retryable = wait === undefined || wait <= MAX_RETRYABLE_WAIT_SECONDS;
    const lines = [`RATE_LIMITED: ${err.message}`];
    if (wait !== undefined) {
      lines.push(retryable
        ? `Retry after ${wait} seconds; calling again sooner fails the same way.`
        // The SDK's message already says when the limit resets; say it only when it does not.
        : `${/resets in/.test(err.message) ? '' : `The limit resets in ${describeWait(wait)}. `}No retry in this session will help, so stop and tell the user.`);
    }
    if (getKeyStatus().sandbox) lines.push(SANDBOX_RATE_LIMIT_SENTENCE);
    return errorResult(
      { code: 'RATE_LIMITED', retryable, ...(wait !== undefined ? { retryAfterSeconds: wait } : {}) },
      lines.join(' '),
    );
  }

  // The API answers an anonymous pt_test_ key on an account-only route
  // (lookup, usage, enrich, photos) with AUTH_FAILED, the same code as a bad
  // key. The key prefix tells the two apart; the message text is not used.
  if (err instanceof AuthenticationError) {
    if (getKeyStatus().sandbox) {
      return errorResult({ code: 'SANDBOX_KEY', retryable: false, actionUrl: SIGNUP_URL }, sandboxKeyText());
    }
    return errorResult(
      { code: err.code, retryable: false },
      `Phototology auth failed (${err.message}). Check PHOTOTOLOGY_API_KEY, or create an account key at ${SIGNUP_URL}.`,
    );
  }

  const message = err instanceof Error ? err.message : String(err);
  // Any other SDK error (a timeout, a network failure, a provider error)
  // carries its code and whether a retry can help, so an agent can tell
  // "try again" from "stop" without parsing the sentence.
  if (err instanceof PhototologyError) {
    let sentence = `Error: ${message}`;
    if (err.code === 'NETWORK_ERROR' || err.code === 'TIMEOUT') {
      const { baseUrl } = getKeyStatus();
      sentence += ` Could not get an answer from the Phototology API at ${baseUrl}` +
        ` (set by PHOTOTOLOGY_BASE_URL; unset means ${DEFAULT_API_BASE_URL}). Check the network and that URL, then retry.`;
    }
    return errorResult({ code: err.code, retryable: err.retryable }, sentence);
  }
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

/** "12 minutes", "24 hours": a wait a person can read. */
function describeWait(seconds: number): string {
  if (seconds < 120) return `${seconds} seconds`;
  if (seconds < 2 * 60 * 60) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

/** RATE_LIMITED waits longer than this are not retryable within an agent session. */
export const MAX_RETRYABLE_WAIT_SECONDS = 600;

/**
 * SANDBOX_KEY without a network call, for the routes an anonymous sandbox key
 * can never use (lookup, balance, enrich, the photo record). Answers only once
 * the start-up probe confirmed the key has no account: an account-linked
 * `pt_test_` key (phototology-web issues them) keeps working. Calling the API
 * anyway would spend the anonymous quota and, inside a closed window, show
 * RATE_LIMITED instead of the real reason.
 */
export async function sandboxRefusal(): Promise<RenderedError | undefined> {
  const before = getKeyStatus();
  if (!before.sandbox) return undefined;
  if (before.sandboxProbe) await before.sandboxProbe;
  if (getKeyStatus().anonymousSandbox !== true) return undefined;
  return errorResult({ code: 'SANDBOX_KEY', retryable: false, actionUrl: SIGNUP_URL }, sandboxKeyText());
}

/** The SANDBOX_KEY sentence: tool errors and the photo resource say the same. */
export function sandboxKeyText(): string {
  return `SANDBOX_KEY: ${SANDBOX_KEY_SENTENCE} at ${SIGNUP_URL}. This is not retryable with this key.`;
}

/** An error result: a JSON first line with the machine fields, then the sentence. */
function errorResult(fields: Record<string, unknown>, sentence: string): RenderedError {
  return {
    content: [{ type: 'text' as const, text: `${JSON.stringify(fields)}\n${sentence}` }],
    isError: true,
  };
}
