import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PhototologyClient } from '@phototology/sdk';
import { renderToolError } from './errors';
import { usdFromCredits } from '../lib/envelope';
import { ListLensesOutputSchema, type ListLensesOutput } from '../schemas';

/**
 * Reshape the SDK's `{ modules, presets }` response into the MCP's
 * brand-aligned `{ lenses, stacks }`. The inner `modules: string[]` field on
 * each preset (its constituent lens names) is also renamed to `lenses` so the
 * MCP output is consistent end-to-end. `billable`, `defaultColumns`, and the
 * optional `internal` flag pass through unchanged so agents can make pricing
 * decisions, derive default spreadsheet projections, and avoid routing users
 * to lenses that are reachable only via a curated stack.
 *
 * Prices are added per photo: each lens carries `credits` (1 if billable,
 * else 0) and each stack carries `credits` (its billable member lenses, looked
 * up in the same catalog; a member the catalog does not list bills nothing)
 * and `usdPerPhoto`.
 *
 * Shared by the `list_lenses` tool and the `phototology://lenses` resource.
 */
// Type aliases, not interfaces: the loose output envelope needs an implicit index signature.
type SdkLensColumn = {
  label: string;
  jsonPath: string;
  format?: 'string' | 'number' | 'date' | 'percentage' | 'tags' | 'hex' | 'count';
};
type SdkModule = {
  name: string;
  description: string;
  category: string;
  outputFields: string[];
  billable: boolean;
  defaultColumns: SdkLensColumn[];
  internal?: true;
};
export function reshapeForMcp(
  sdkResult: { modules: SdkModule[]; presets: Array<{ name: string; description: string; modules: string[] }> },
): ListLensesOutput {
  const billable = new Set(sdkResult.modules.filter((m) => m.billable).map((m) => m.name));
  return {
    lenses: sdkResult.modules.map((m) => ({
      name: m.name,
      description: m.description,
      category: m.category,
      outputFields: m.outputFields,
      billable: m.billable,
      credits: m.billable ? 1 : 0,
      defaultColumns: m.defaultColumns,
      ...(m.internal ? { internal: true as const } : {}),
    })),
    stacks: sdkResult.presets.map((p) => {
      const credits = p.modules.filter((m) => billable.has(m)).length;
      return {
        name: p.name,
        description: p.description,
        lenses: p.modules,
        credits,
        usdPerPhoto: usdFromCredits(credits),
      };
    }),
  };
}

export function registerListLenses(server: McpServer, client: PhototologyClient): void {
  const s = server as any;

  s.registerTool(
    'list_lenses',
    {
      description: [
        'List every available lens and stack on this server, with descriptions and the output fields each lens owns.',
        '',
        'Free. Does not bill credits. Call this for runtime discovery before deciding which lenses or stack to pass to `analyze_photo`.',
        '',
        'Returns `{ lenses: [{ name, description, category, outputFields, billable, credits, defaultColumns, internal? }], stacks: [{ name, description, lenses, credits, usdPerPhoto }] }`. Prices are per uncached photo at $0.01 per credit: a lens `credits` is 1 when billable and 0 when not; a stack `credits` counts its billable lenses and `usdPerPhoto` is computed from that count, in dollars, so multiply by the photo count to price a batch before running it. A lens is a single analysis capability; a stack is a named bundle of lenses that runs together, and its `lenses` array names them. Use the lens `outputFields` map to translate a field-name question (e.g. "what year was this taken?") into the right `lenses` argument on `analyze_photo` (e.g. `["dating"]`). Lenses with `billable: false` cost zero credits. `defaultColumns` describes the default tabular projection if the user is exporting to a spreadsheet (label + jsonPath + optional format hint). `internal: true` marks a lens that is reachable ONLY via its curated stack: never pass an `internal: true` lens name in the `lenses` argument; instead route the user to the matching stack (e.g. for `vehicle-condition`, use the `vehicle-condition` stack).',
      ].join('\n'),
      outputSchema: ListLensesOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      try {
        const sdkResult = await client.modules();
        const reshaped = reshapeForMcp(sdkResult);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(reshaped, null, 2) }],
          structuredContent: reshaped,
        };
      } catch (err: unknown) {
        return renderToolError(err);
      }
    },
  );
}
