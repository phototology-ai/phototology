/**
 * `phoneHome()` — fire-and-forget MCP-protocol telemetry to phototology-api.
 *
 * Posts a tiny event payload to `POST /v1/mcp/event` whenever the MCP server
 * completes the initialize handshake (so we see *which* MCP client just
 * connected — Claude Desktop, Cursor, Gemini CLI, Codex, etc.) and on tools
 * discovery probes. This is the visibility gap left by api-side
 * `api_request` events, which only fire once an authenticated tool call
 * (analyze, lookup) actually hits the HTTP API.
 *
 * Privacy posture: no third-party SDK is bundled. The only outbound
 * connection is to `api.phototology.com` — a domain the user's MCP is
 * already trusting for every analyze + lookup call. The user's API key is
 * the only credential involved. Opt out with `PHOTOTOLOGY_MCP_NO_TELEMETRY=1`.
 *
 * Errors are swallowed completely. Telemetry must never crash the MCP
 * server, block stdio, or surface anything to the agent.
 *
 * The original PostHog-in-MCP path (commit `bb705fd2`) was reverted in
 * `bc021f96` for distributing a PostHog project key inside the npm
 * package. This module sidesteps that by proxying through phototology-api,
 * which already has the project key server-side. See the revert commit
 * message for the full rationale.
 *
 * @module phone-home
 */

const DEFAULT_BASE_URL = 'https://api.phototology.com';
const REQUEST_TIMEOUT_MS = 1_500;

export type McpEventName = 'mcp_initialize' | 'mcp_tools_list' | 'mcp_tool_called';

export interface McpEventProperties {
  clientName?: string;
  clientVersion?: string;
  mcpVersion?: string;
  // mcp_tool_called fields (PII-free counts/booleans/codes). Set by the
  // tool-registration wrapper in src/tools/index.ts via mcpToolEvent().
  tool?: string;
  ok?: boolean;
  durationMs?: number;
  errorCode?: string;
  creditsCharged?: number;
  cacheHit?: boolean;
  lensCount?: number;
  photoCount?: number;
  cacheHits?: number;
}

export interface PhoneHomeOptions {
  apiKey: string;
  baseUrl?: string;
}

function shouldSkip(): boolean {
  // Opt-out: explicit env var disables all phone-home traffic. Honor either
  // truthy form (`1`, `true`, etc.) so users don't have to guess the spelling.
  const raw = process.env.PHOTOTOLOGY_MCP_NO_TELEMETRY;
  if (!raw) return false;
  const v = raw.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Send a single MCP-lifecycle event to the api proxy. Returns immediately;
 * the actual HTTP work happens on a detached promise. Resolves only the
 * "we tried" beat — the caller cannot wait on the network call.
 */
export function phoneHome(
  event: McpEventName,
  props: McpEventProperties,
  opts: PhoneHomeOptions,
): void {
  if (shouldSkip()) return;
  if (!opts.apiKey) return;
  if (typeof fetch !== 'function') return; // Node <18 fallback safety.

  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/v1/mcp/event`;

  // AbortController prevents the request from hanging forever if the api is
  // unreachable. We don't await the promise — fire and detach — but the
  // timeout still releases the underlying socket.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  // Include only defined keys so lifecycle events stay lean and the body never
  // carries explicit `undefined`s. JSON.stringify drops undefined anyway, but
  // building the object this way keeps the wire contract obvious for the
  // API-side Zod schema in mcpEvent.ts.
  const body: Record<string, unknown> = { event };
  for (const [k, v] of Object.entries(props)) {
    if (v !== undefined) body[k] = v;
  }

  // Cast to never so the floating-promise lint rule treats the call as
  // explicitly discarded. We do NOT want to await — the MCP must keep
  // moving even when api.phototology.com is down.
  void fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  })
    .catch(() => { /* swallow — telemetry must never crash the MCP */ })
    .finally(() => clearTimeout(timer));
}

/**
 * Emit a single `mcp_tool_called` event. Thin wrapper over `phoneHome` that
 * pins the event name and folds the tool name into the props. Same
 * fire-and-forget / swallow-everything / opt-out posture as `phoneHome`.
 */
export function mcpToolEvent(
  tool: string,
  outcome: Omit<McpEventProperties, 'tool' | 'clientName' | 'clientVersion'>,
  opts: PhoneHomeOptions,
): void {
  phoneHome('mcp_tool_called', { tool, ...outcome }, opts);
}
