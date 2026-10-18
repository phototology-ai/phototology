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
import { setKeyContext } from '../lib/key-status';

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
 * Best-effort machine error code from a rendered tool error: the first text
 * line of every rendered error is `{ code, retryable, ... }` JSON. A whole-text
 * `{ error: { code } }` is still read for older shapes. Anything else (plain
 * "Error: ..." text) yields undefined. Never throws.
 */
function extractErrorCode(result: ToolResult): string | undefined {
  const text = result?.content?.[0]?.text;
  if (typeof text !== 'string') return undefined;
  try {
    const whole = JSON.parse(text);
    if (typeof whole?.error?.code === 'string') return whole.error.code;
  } catch { /* not whole-text JSON */ }
  try {
    const head = JSON.parse(text.split('\n')[0]);
    if (typeof head?.code === 'string') return head.code;
  } catch { /* plain text error: no machine code to extract */ }
  return undefined;
}

/**
 * Analyze-only enrichment pulled from the result payload. PII-free counts and
 * booleans only. Never throws: shape drift just drops the enrichment.
 */
function enrich(toolName: string, result: ToolResult): Partial<ToolOutcome> {
  try {
    if (toolName === 'analyze_photo') {
      // The typed envelope: usage.creditsCharged, usage.modulesUsed, and a
      // boolean cacheHit (the API's meta.cacheHit, normalized) so the PostHog
      // cache-hit rate is computable from every analyze_photo event.
      const sc = result?.structuredContent as { usage?: { creditsCharged?: unknown; modulesUsed?: unknown }; cacheHit?: unknown } | undefined;
      const out: Partial<ToolOutcome> = {};
      if (typeof sc?.usage?.creditsCharged === 'number') out.creditsCharged = sc.usage.creditsCharged;
      if (Array.isArray(sc?.usage?.modulesUsed)) out.lensCount = sc.usage.modulesUsed.length;
      out.cacheHit = sc?.cacheHit === true;
      return out;
    }
    if (toolName === 'analyze_batch') {
      const summary = result?.structuredContent?.summary as { photos?: unknown; cacheHits?: unknown; creditsCharged?: unknown; dryRun?: unknown } | undefined;
      // A dry run analyzes nothing; counting its lookups as cache hits would
      // skew the cache-hit rate, so it reports only ok and duration.
      if (summary?.dryRun === true) return {};
      const out: Partial<ToolOutcome> = {};
      if (typeof summary?.photos === 'number') out.photoCount = summary.photos;
      if (typeof summary?.cacheHits === 'number') out.cacheHits = summary.cacheHits;
      if (typeof summary?.creditsCharged === 'number') out.creditsCharged = summary.creditsCharged;
      return out;
    }
    if (toolName === 'enrich_photo') {
      // The typed envelope's usage.creditsCharged is the canonical cost on
      // every path (bytes returned, saved to outputPath, or sidecar). No
      // modulesUsed, so no lensCount.
      const usage = result?.structuredContent?.usage as { creditsCharged?: unknown } | undefined;
      return typeof usage?.creditsCharged === 'number' ? { creditsCharged: usage.creditsCharged } : {};
    }
  } catch { /* shape drift: emit the base event without enrichment */ }
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
 * 'registerTool')` and any McpServer behavior keep working; only the handler
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
 * (fire-and-forget; skipped under PHOTOTOLOGY_MCP_NO_TELEMETRY, DO_NOT_TRACK or
 * NODE_ENV=test, see shouldSkip in ../phone-home). The event carries the
 * tool name, ok/duration, an error code on failure (including local failures
 * that never reach the API), and analyze enrichment: the visibility the
 * route-based `api_request` events can't provide.
 *
 * Returns the client so `registerResources` reads through the same instance
 * (one connection pool, one user agent).
 */
/**
 * Total time one SDK call may take, across attempts and backoffs: just under
 * an MCP client's default 60 s request timeout. At the SDK default of 90 s a
 * dead API surfaced as the client's own timeout instead of a tool error; much
 * lower would fail real work, since a full-analysis call on one photo can run
 * 20 to 30 s on the model side.
 */
export const MCP_CLIENT_MAX_ELAPSED_MS = 55_000;
/** The longest a tool waits for a rate-limit reset before returning RATE_LIMITED. */
export const MCP_CLIENT_MAX_RATE_LIMIT_WAIT_MS = 10_000;

export function registerTools(server: McpServer, apiKey: string, userAgent?: string): PhototologyClient {
  setKeyContext(apiKey, process.env.PHOTOTOLOGY_BASE_URL);
  const client = new PhototologyClient({
    apiKey,
    baseUrl: process.env.PHOTOTOLOGY_BASE_URL,
    userAgent,
    maxElapsedMs: MCP_CLIENT_MAX_ELAPSED_MS,
    maxRateLimitWaitMs: MCP_CLIENT_MAX_RATE_LIMIT_WAIT_MS,
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

  return client;
}
