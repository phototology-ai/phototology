import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PhototologyClient } from '@phototology/sdk';
import { renderToolError } from './errors';

export function registerGetCredits(server: McpServer, client: PhototologyClient): void {
  const s = server as any;

  s.registerTool(
    'get_credits',
    {
      description: [
        'Read the current credit balance for the authenticated account. Free. Does not bill credits.',
        '',
        'When to use: before any `analyze_photo` loop, before a bespoke (5-credit) call, before a `full-analysis` stack (runs every lens — call `list_lenses` for the current catalog size), or any time the user asks "how many credits do I have left?".',
        '',
        'When NOT to use: not needed right after a successful `analyze_photo` / `analyze_batch` — those results already report `usage.creditsCharged`, so re-reading the balance is wasted latency. Cache-only `lookup_photo` workflows never bill, so skip the balance check there too. Call this only when you are about to spend.',
        '',
        'Returns: `{ tier, total, community: { balance, monthlyAllowance, resetsInDays, referralBonus? }, purchased: { balance }, reserved }`. `total` is the spendable credit balance — the single number to report to the user. Effective spendable after in-flight holds = `total - reserved`. The `community` / `purchased` split is retained for back-compat (it powers refund-to-origin accounting); it is NOT two separate balances the user manages — credits spend from the combined `total`. `monthlyAllowance` and `resetsInDays` are legacy fields; the monthly reset was retired in pricing v1 (cutover 2026-05-18) and `resetsInDays` reports 0 once the cutoff has bound the account.',
        '',
        'If the user is low or out, call `purchase_credits` to get the wallet deep-link. First-time buyers get 2x credits on their first pack.',
      ].join('\n'),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const result = await client.usage();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err: unknown) {
        return renderToolError(err);
      }
    },
  );
}
