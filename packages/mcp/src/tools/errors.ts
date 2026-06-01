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
  structuredContent?: { actions: ToolAction[] };
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
    const lines = [`Out of credits. You need ${err.creditsRequired} credits.`];
    if (typeof err.resetsInDays === 'number') {
      lines.push(`Your community credits reset in ${err.resetsInDays} days.`);
    }
    // Surface the first-purchase 2x conversion lever to users who've never
    // bought before. Backend tracks first_purchase_bonus_granted globally;
    // any user who lands here for the first time gets 2x credits on whichever
    // pack they pick.
    lines.push(
      'Buy credits at ' + err.purchaseUrl + ' — first purchase doubles, so Starter $10 buys 2,000 credits the first time.',
    );
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
