import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PhototologyClient } from '@phototology/sdk';
import { renderToolError } from './errors';

/**
 * Reshape the SDK's `{ modules, presets }` response into the MCP's
 * brand-aligned `{ lenses, stacks }`. The inner `modules: string[]` field on
 * each preset (its constituent lens names) is also renamed to `lenses` so the
 * MCP output is consistent end-to-end. `billable`, `defaultColumns`, and the
 * optional `internal` flag pass through unchanged so agents can make pricing
 * decisions, derive default spreadsheet projections, and avoid routing users
 * to lenses that are reachable only via a curated stack.
 */
interface SdkLensColumn {
  label: string;
  jsonPath: string;
  format?: 'string' | 'number' | 'date' | 'percentage' | 'tags' | 'hex' | 'count';
}
interface SdkModule {
  name: string;
  description: string;
  category: string;
  outputFields: string[];
  billable: boolean;
  defaultColumns: SdkLensColumn[];
  internal?: true;
}
function reshapeForMcp(
  sdkResult: { modules: SdkModule[]; presets: Array<{ name: string; description: string; modules: string[] }> },
) {
  return {
    lenses: sdkResult.modules.map((m) => ({
      name: m.name,
      description: m.description,
      category: m.category,
      outputFields: m.outputFields,
      billable: m.billable,
      defaultColumns: m.defaultColumns,
      ...(m.internal ? { internal: true as const } : {}),
    })),
    stacks: sdkResult.presets.map((p) => ({
      name: p.name,
      description: p.description,
      lenses: p.modules,
    })),
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
        'Returns `{ lenses: [{ name, description, category, outputFields, billable, defaultColumns, internal? }], stacks: [{ name, description, lenses }] }`. A lens is a single analysis capability; a stack is a named bundle of lenses that runs together (e.g. `automobile` runs `automobile` + `vehicle-condition` + supporting lenses). Use the lens `outputFields` map to translate a field-name question (e.g. "what year was this taken?") into the right `lenses` argument on `analyze_photo` (e.g. `["dating"]`). `billable: false` lenses (currently just `moderation`) cost zero credits. `defaultColumns` describes the default tabular projection if the user is exporting to a spreadsheet (label + jsonPath + optional format hint). `internal: true` marks a lens that is reachable ONLY via its curated stack — never pass an `internal: true` lens name in the `lenses` argument; instead route the user to the matching stack (e.g. for `vehicle-condition`, use the `vehicle-condition` stack).',
      ].join('\n'),
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
