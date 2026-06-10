import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const WALLET_URL = 'https://phototology.com/wallet';

/**
 * Build the wallet deep-link with MCP attribution.
 *
 * The MCP intentionally does NOT pre-select a specific pack today: the wallet
 * UI is the source of truth for the current pack catalog. Once the wallet is
 * upgraded to accept pack IDs from MCP, a `?pack=<id>` param can be added.
 */
function buildWalletUrl(): string {
  const url = new URL(WALLET_URL);
  url.searchParams.set('utm_source', 'mcp');
  return url.toString();
}

export function registerPurchaseCredits(server: McpServer): void {
  const s = server as any;

  s.registerTool(
    'purchase_credits',
    {
      description: [
        'Get a deep-link the user can open in their browser to buy more Phototology credits. Free. Does not bill credits.',
        '',
        'When to use: when `get_credits` shows the account is low or out, or when an `analyze_photo` / `analyze_batch` call returns an out-of-credits error (its `structuredContent.actions[0].url` is the same wallet link).',
        '',
        'When NOT to use: do not call speculatively. This tool cannot complete a purchase (Stripe needs a browser), so calling it without a real credit need just hands the user a dead-end link. It does not bill and does not change the balance.',
        '',
        'You cannot complete checkout from inside the MCP server. Stripe requires a browser. Surface the returned URL to the user verbatim and tell them to open it. After payment, credits land in the account within seconds; `get_credits` will reflect the new balance.',
        '',
        'Pricing model (all packs at $0.01/credit, no volume discount):',
        '- Starter: 1,000 credits for $10',
        '- Pro: 10,000 credits for $100',
        '- Business: 100,000 credits for $1,000',
        '',
        'First purchase doubles. A user buying for the first time receives 2x credits on their first pack (Starter $10 → 2,000 credits the first time). Mention this when surfacing the URL if the user has never bought before.',
        '',
        'No subscriptions. Pay-as-you-go via packs only. New accounts start with 5,000 free credits via the signup ladder: 1,000 for verifying an email and 4,000 more for adding a card-on-file (Stripe holds the card; Phototology never charges it without a separate purchase). The signup-grant credits are one-time, not recurring.',
        '',
        'Returns: `{ url }`. The `structuredContent.actions[0]` is an `open_url` action so rich-rendering clients show it as a button.',
      ].join('\n'),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const url = buildWalletUrl();
      const payload = { url };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
        structuredContent: {
          ...payload,
          actions: [
            {
              type: 'open_url',
              label: 'Open the Phototology wallet to buy credits',
              url,
            },
          ],
        },
      };
    },
  );
}
