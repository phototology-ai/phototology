import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PhototologyClient, UsageResponse } from '@phototology/sdk';
import { renderToolError } from './errors';
import { usdFromCredits } from '../lib/envelope';
import { GetCreditsOutputSchema, type GetCreditsOutput } from '../schemas';

/**
 * The balance plus `usd`, the dollar value of `total`. An older API that omits
 * `total` gets it summed from the two pools it is made of.
 */
function toCreditsEnvelope(res: UsageResponse): GetCreditsOutput {
  // The API may drop legacy fields, so read the pools defensively.
  const pools = res as Partial<Pick<UsageResponse, 'community' | 'purchased'>>;
  const total = typeof res.total === 'number'
    ? res.total
    : (pools.community?.balance ?? 0) + (pools.purchased?.balance ?? 0);
  return { ...res, total, usd: usdFromCredits(total) };
}

export function registerGetCredits(server: McpServer, client: PhototologyClient): void {
  const s = server as any;

  s.registerTool(
    'get_credits',
    {
      title: 'Check credit balance',
      description: [
        'Read the current credit balance for the account behind this API key. Free. Does not bill credits.',
        '',
        'When to use: before any `analyze_photo` loop, before a bespoke (5-credit) call, before a `full-analysis` stack (runs every lens; call `list_lenses` for the current catalog size), or any time the user asks "how many credits do I have left?".',
        '',
        'When NOT to use: not needed right after a successful `analyze_photo` / `analyze_batch`: those results already report `usage.creditsCharged`, so re-reading the balance is wasted latency. Cache-only `lookup_photo` workflows never bill, so skip the balance check there too. Call this only when you are about to spend.',
        '',
        'Returns: `{ total, usd, tier?, community?: { balance?, monthlyAllowance?, resetsInDays?, referralBonus? }, purchased?: { balance? }, reserved? }`. Only `total` and `usd` are always present; the rest are legacy detail an API may omit. `total` is the spendable credit balance, the single number to report to the user, and `usd` is its dollar value at $0.01 per credit (e.g. \"49.80\"). Effective spendable after in-flight holds = `total - reserved` (treat a missing `reserved` as 0). The `community` / `purchased` split is retained for back-compat (it powers refund-to-origin accounting); it is NOT two separate balances the user manages; credits spend from the combined `total`. `monthlyAllowance` and `resetsInDays` are legacy fields; the monthly reset was retired in pricing v1 (cutover 2026-05-18) and `resetsInDays` reports 0 once the cutoff has bound the account.',
        '',
        'If the user is low or out, call `purchase_credits` to get the wallet deep-link. First-time buyers get 2x credits on their first pack.',
      ].join('\n'),
      outputSchema: GetCreditsOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const envelope = toCreditsEnvelope(await client.usage());
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
        };
      } catch (err: unknown) {
        return renderToolError(err);
      }
    },
  );
}
