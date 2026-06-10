import { CreditExhaustedError, AuthenticationError } from '@phototology/sdk';
import { LocalImageError } from '../lib/local-image';

/**
 * Action object embedded in `structuredContent` so MCP clients that support
 * rich rendering (Claude Code, future Claude.ai, Cursor) can show a real
 * button. Clients that don't render `structuredContent` still see the URL
 * in the text fallback.
 */
export interface ToolAction {
  type: 'open_url';
  label: string;
  url: string;
}

interface RenderedError {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: {
    actions: ToolAction[];
    // Machine-legible mirror of the OUT_OF_CREDITS text (C1). A model that
    // reads structuredContent gets the non-retryability as a boolean, not just
    // prose. `balance` maps to the SDK error's `totalBalance` (the dual-pool
    // combined total — there is no single `balance` field on the error).
    code?: string;
    retryable?: boolean;
    actionUrl?: string;
    creditsRequired?: number;
    balance?: number;
  };
  isError: true;
}

/**
 * Render an SDK error as an MCP tool execution result.
 *
 * Credit exhaustion gets a human-readable message AND a structured `actions`
 * payload (per MCP spec 2025-11-25) so clients can render a button. Clients
 * without structured-content support still see the URL in the text fallback.
 *
 * All other errors fall through to the existing `Error: <message>` format.
 */
export function renderToolError(err: unknown): RenderedError {
  if (err instanceof LocalImageError) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          error: {
            code: err.code,
            message: err.message,
            ...(err.path ? { path: err.path } : {}),
            ...(err.sizeBytes !== undefined ? { sizeBytes: err.sizeBytes } : {}),
          },
        }, null, 2),
      }],
      isError: true,
    };
  }

  if (err instanceof CreditExhaustedError) {
    // C1 (PostHog remediation): live data showed an agent re-call analyze_photo
    // 58× against this exact error. The text now leads with the machine code
    // and spells out non-retryability + agents-cannot-purchase + STOP, so a
    // model reads "hand off to a human and stop" rather than "transient, retry".
    // Threat-model C-T2: interpolate ONLY numeric/constant values (balance,
    // creditsRequired, resetsInDays, the constant purchaseUrl) — never tool
    // input, filename, or lens names.
    const lines = [
      `OUT_OF_CREDITS: Balance ${err.totalBalance}, need ${err.creditsRequired} credits. ` +
        `This is NOT retryable — re-calling analyze_photo will fail again until a human adds credits. ` +
        `Agents cannot purchase; checkout requires a human in a browser.`,
      `ACTION: tell your user to open ${err.purchaseUrl} and buy credits ` +
        `(first purchase doubles, so Starter $10 buys 2,000 credits the first time).`,
    ];
    if (typeof err.resetsInDays === 'number') {
      lines.push(`Community credits auto-refill in ${err.resetsInDays} days, but do not poll for that.`);
    }
    lines.push('Then STOP. Do not retry analyze_photo or loop get_credits; wait for the user, or move on.');
    return {
      content: [{ type: 'text' as const, text: lines.join(' ') }],
      structuredContent: {
        actions: [
          {
            type: 'open_url',
            label: 'Buy credits in your Phototology wallet (first purchase doubles)',
            url: err.purchaseUrl,
          },
        ],
        code: 'OUT_OF_CREDITS',
        retryable: false,
        actionUrl: err.purchaseUrl,
        creditsRequired: err.creditsRequired,
        balance: err.totalBalance,
      },
      isError: true,
    };
  }

  // Auth-failure polish: agents calling get_credits / lookup_photo with an
  // anonymous test key (no userId attached) get a clearer hint than the raw
  // SDK message. The platform-API endpoints involved require a real account.
  if (err instanceof AuthenticationError) {
    return {
      content: [
        {
          type: 'text' as const,
          text:
            'Phototology auth failed (' + err.message + '). This usually means the API key has no user account attached (anonymous `pt_test_` keys are sandbox-only and cannot read credit balance or registry history). Create a real key at https://api.phototology.com to use balance + lookup endpoints.',
        },
      ],
      isError: true,
    };
  }

  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}
