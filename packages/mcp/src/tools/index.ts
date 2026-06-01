import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PhototologyClient } from '@phototology/sdk';
import { registerAnalyzePhoto } from './analyze-photo';
import { registerAnalyzeBatch } from './analyze-batch';
import { registerListLenses } from './list-lenses';
import { registerLookupPhoto } from './lookup-photo';
import { registerGetCredits } from './get-credits';
import { registerPurchaseCredits } from './purchase-credits';
import { registerEnrichPhoto } from './enrich-photo';
import { mcpToolEvent, type McpEventProperties, type PhoneHomeOptions } from '../phone-home';

type ToolResult = {
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
};
type ToolHandler = (args: any) => Promise<ToolResult>;
type ToolOutcome = Omit<McpEventProperties, 'tool' | 'clientName' | 'clientVersion'>;
interface TelemetryOpts extends PhoneHomeOptions {
  mcpVersion?: string;
}

/**
 * Best-effort machine error code from a rendered tool error. LocalImageError
 * results carry `{ error: { code } }` as JSON text; CreditExhaustedError carries
 * a `structuredContent.actions` array. Anything else (plain "Error: ..." text)
 * yields undefined. Never throws.
 */
function extractErrorCode(result: ToolResult): string | undefined {
  try {
    if (result?.structuredContent?.actions) return 'OUT_OF_CREDITS';
    const text = result?.content?.[0]?.text;
    if (typeof text === 'string') {
      const parsed = JSON.parse(text);
      if (typeof parsed?.error?.code === 'string') return parsed.error.code;
    }
  } catch { /* plain text error — no machine code to extract */ }
  return undefined;
}

/**
 * Analyze-only enrichment pulled from the result payload. PII-free counts and
 * booleans only. Never throws — shape drift just drops the enrichment.
 */
function enrich(toolName: string, result: ToolResult): Partial<ToolOutcome> {
  try {
    if (toolName === 'analyze_photo') {
      const parsed = JSON.parse(result?.content?.[0]?.text ?? '{}');
      const out: Partial<ToolOutcome> = {};
      if (typeof parsed?.usage?.creditsCharged === 'number') out.creditsCharged = parsed.usage.creditsCharged;
      if (Array.isArray(parsed?.usage?.modulesUsed)) out.lensCount = parsed.usage.modulesUsed.length;
      // The API sets meta.cacheHit:true only on a full registry cache hit;
      // fresh/partial runs omit it. Normalize to an explicit boolean so the
      // PostHog cache-hit rate is computable from every analyze_photo event.
      out.cacheHit = parsed?.meta?.cacheHit === true;
      return out;
    }
    if (toolName === 'analyze_batch') {
      // analyze_batch exposes the payload directly on structuredContent.
      const sc = result?.structuredContent;
      const out: Partial<ToolOutcome> = {};
      if (typeof sc?.totalSubmitted === 'number') out.photoCount = sc.totalSubmitted as number;
      if (typeof sc?.totalCacheHits === 'number') out.cacheHits = sc.totalCacheHits as number;
      if (typeof sc?.totalCreditsCharged === 'number') out.creditsCharged = sc.totalCreditsCharged as number;
      return out;
    }
    if (toolName === 'enrich_photo') {
      // EnrichResponse carries credits at meta.creditsCharged; the outputPath
      // save path lifts it to a top-level creditsCharged. No usage/modulesUsed.
      const parsed = JSON.parse(result?.content?.[0]?.text ?? '{}');
      const credits = typeof parsed?.meta?.creditsCharged === 'number'
        ? parsed.meta.creditsCharged
        : (typeof parsed?.creditsCharged === 'number' ? parsed.creditsCharged : undefined);
      return credits !== undefined ? { creditsCharged: credits } : {};
    }
  } catch { /* shape drift — emit the base event without enrichment */ }
  return {};
}

/**
 * Wrap a tool handler so each invocation times itself and emits one
 * `mcp_tool_called` event (fire-and-forget). Telemetry can never break the
 * tool: the result is returned regardless, and any telemetry throw is swallowed.
 */
function instrumentHandler(toolName: string, handler: ToolHandler, opts: TelemetryOpts): ToolHandler {
  const { mcpVersion, ...phoneOpts } = opts;
  return async (args: any) => {
    const start = Date.now();
    let result: ToolResult;
    try {
      result = await handler(args);
    } catch (err) {
      // Handlers catch internally, but guard the rare uncaught throw.
      try { mcpToolEvent(toolName, { ok: false, durationMs: Date.now() - start, errorCode: 'UNCAUGHT', mcpVersion }, phoneOpts); } catch { /* swallow */ }
      throw err;
    }
    try {
      const ok = result?.isError !== true;
      const outcome: ToolOutcome = { ok, durationMs: Date.now() - start, mcpVersion, ...enrich(toolName, result) };
      if (!ok) outcome.errorCode = extractErrorCode(result);
      mcpToolEvent(toolName, outcome, phoneOpts);
    } catch { /* telemetry must never break the tool */ }
    return result;
  };
}

/**
 * Transparent Proxy that instruments every handler passed to `registerTool`.
 * Delegates all other access to the real server, so `jest.spyOn(server,
 * 'registerTool')` and any McpServer behavior keep working — only the handler
 * (3rd arg) is wrapped, name + config pass through untouched.
 */
function instrumentServer(server: McpServer, opts: TelemetryOpts): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'registerTool') {
        return (name: string, config: unknown, handler: ToolHandler) =>
          (target as any).registerTool(name, config, instrumentHandler(name, handler, opts));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as McpServer;
}

/**
 * Register all MCP tools on the server.
 *
 * Creates a singleton PhototologyClient for connection reuse, and wraps tool
 * registration so every invocation emits one `mcp_tool_called` telemetry event
 * (fire-and-forget; honors PHOTOTOLOGY_MCP_NO_TELEMETRY). The event carries the
 * tool name, ok/duration, an error code on failure (including local failures
 * that never reach the API), and analyze enrichment — the visibility the
 * route-based `api_request` events can't provide.
 */
export function registerTools(server: McpServer, apiKey: string, userAgent?: string): void {
  const client = new PhototologyClient({
    apiKey,
    baseUrl: process.env.PHOTOTOLOGY_BASE_URL,
    userAgent,
  });

  const s = instrumentServer(server, {
    apiKey,
    baseUrl: process.env.PHOTOTOLOGY_BASE_URL,
    mcpVersion: userAgent?.match(/@phototology\/mcp\/(\S+)/)?.[1],
  });

  registerAnalyzePhoto(s, client);
  registerAnalyzeBatch(s, client);
  registerListLenses(s, client);
  registerLookupPhoto(s, client);
  registerGetCredits(s, client);
  registerPurchaseCredits(s);
  registerEnrichPhoto(s, client);
}
