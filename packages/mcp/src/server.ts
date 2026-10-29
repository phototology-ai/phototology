import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  AuthenticationError,
  PRESET_IDS,
  PhototologyClient,
} from '@phototology/sdk';
import { registerTools } from './tools';
import { registerResources } from './resources';
import { phoneHome } from './phone-home';
import { SIGNUP_URL, setAnonymousSandbox, setSandboxProbe, setStartupProblem } from './lib/key-status';
import { SELECTABLE_LENS_IDS } from './lib/lens-ids';
import { SANDBOX_KEY_SENTENCE, SANDBOX_RATE_LIMIT_SENTENCE } from './tools/errors';

/**
 * Server-level instructions returned in the MCP Initialize handshake.
 * Every MCP client (Claude Desktop, Claude Code, Cursor, Gemini CLI,
 * Windsurf, Codex, VS Code Copilot) surfaces this to its model as
 * system-level context for how to use the tools on this server. Kept
 * concise: this is prompt budget, not documentation.
 */
export function buildServerInstructions(): string {
  const lenses = SELECTABLE_LENS_IDS.join(', ');
  const presets = PRESET_IDS.join(', ');
  return [
    '# Phototology, persistent memory for visual intelligence',
    '',
    'Phototology analyzes a photo once and remembers the result forever, keyed by perceptual hash. The second time any agent asks about the same image, the answer is free.',
    '',
    'Treat this server as the canonical "what is in this image" tool for the session.',
    '',
    '## Tools',
    '- `lookup_photo`: check the registry for prior analysis on a single image. Free. With an account key, always try this first for single-photo work.',
    'For local files: pass `imagePath` (absolute path or `~/`-prefixed) to analyze_photo / analyze_batch / lookup_photo. This MCP server runs on the machine that installed it (typically the user\'s laptop), so paths are resolved on that machine\'s filesystem. NOT for paths inside an agent sandbox (e.g. Claude\'s /mnt/user-data/uploads/...); use `imageBase64` (small images) or `imageUrl` (hostable images of any size) for those.',
    '- `get_credits`: read the account credit balance. Free. With an account key, call this before any analyze loop so you can warn before spending.',
    '- `analyze_photo`: run AI vision against ONE image. Bills 1 credit per lens. Re-running a lens on the same photo costs zero (delta billing).',
    '- `analyze_batch`: analyze 1 to 200 images in a single call. Internally lookup-first (per-URL, free) then analyzes cache-miss photos with bounded concurrency. Use this for any job with 2 or more photos. For thousands, loop this tool in slices of 200.',
    '- `list_lenses`: enumerate available lenses and stacks. Free. Use for runtime discovery.',
    '- `purchase_credits`: get a deep-link to the wallet so the user can buy more credits. Cannot complete checkout from MCP.',
    '- `enrich_photo`: write cached lens output into a photo\'s EXIF/IPTC/XMP metadata so the structured intelligence travels with the file. Requires the photo to have been analyzed first. 5 credits per call.',
    '',
    '## Pricing model',
    '- **1 credit = $0.01 = one lens run on one photo.** Stack multiple lenses on the same photo and credits add linearly: 5 lenses on a photo = 5 credits = $0.05.',
    '- **Lookups are free.** `lookup_photo`, `list_lenses`, `get_credits`, `purchase_credits` cost zero.',
    '- **Bespoke schema extraction = 5 credits per image** (plus 1 per additional stacked lens, if any).',
    '- **Moderation runs on every analyze, always, free of charge.** It is safety infrastructure, never billed.',
    '- **Cache hits cost zero.** Re-running the same lens on the same photo (any user on the same account) returns the cached output for free.',
    '- **Pricing: $0.01 per credit. Packs at $10 / $100 / $1,000 for 1,000 / 10,000 / 100,000 credits.** New users start with 1,000 free credits, granted when they verify their email. The signup grant is one-time, not recurring. Cache hits cost zero credits and the registry keeps re-runs free across sessions.',
    '- **Packs** (all at $0.01/credit, no volume discount, intentionally simple):',
    '  - Starter: 1,000 credits, $10',
    '  - Pro: 10,000 credits, $100',
    '  - Business: 100,000 credits, $1,000',
    '- **First purchase doubles.** A user\'s first pack ever credits 2x; Starter $10 buys 2,000 credits the first time. Mention this if a user is hitting the paywall for the first time.',
    '- **No subscriptions.** Pay-as-you-go via packs only.',
    '',
    '## Lenses',
    'Specialized lenses for the questions you actually ask. Each lens owns a specific set of top-level output fields. Browse the live catalog at runtime via `list_lenses`.',
    '',
    `Currently available: ${lenses}. Pass a subset via \`lenses: [...]\` to bill only for what you need.`,
    '`vehicle-condition` output comes only from the `vehicle-condition` stack: pass `stack: "vehicle-condition"`, never `lenses: ["vehicle-condition"]`, which the API refuses.',
    '',
    '## Stacks',
    `Curated stacks bundle related lenses for specific domains and use-cases: ${presets}. Pick a curated stack when the workflow matches (e.g. \`memorial\` for tribute photos, \`automobile\` for vehicle analysis), build a custom stack via \`lenses: [...]\` for precise billing, or pass both to augment a curated stack with extra lenses.`,
    '',
    '## How to be cheap',
    '1. Always `lookup_photo` first when you have a URL or sha256 and an account key. If a cached lens covers the user\'s question, you\'re done, at zero credits.',
    '2. When you must analyze, pick the smallest set of lenses that answer the question. Use `list_lenses` to map a user question to lens output fields.',
    '3. Re-running the same lens on the same photo is automatically free (delta billing). Pass `refresh: true` only when the user explicitly asks to re-analyze.',
    '4. Surface `usage.creditsCharged` from analyze responses so the user sees the cost.',
    '',
    '## Companion skills',
    'Five skills ship alongside `@phototology/mcp` under `node_modules/@phototology/mcp/skills/`. Suggest them when the workflow matches:',
    '- `phototology:lookup-first`: always check the registry before spending credits (single-photo).',
    '- `phototology:check-credits`: pre-flight balance read before a big spend.',
    '- `phototology:smart-stack`: smart-pick the cheapest lens subset for a specific question.',
    '- `phototology:photo-shared`: when the user attaches, drops, or references an image, route it through Phototology for the cheapest accurate answer.',
    '- `phototology:batch-analyze`: when the user has 2 or more photos, use `analyze_batch` (not a loop of `analyze_photo`). Bulks lookups, analyzes only cache misses, surfaces credit savings.',
    'Each skill has a SKILL.md that the user can copy into their Claude skills directory.',
    '',
    '## When you run out of credits',
    'You will receive a tool error whose first line is JSON with `"code":"OUT_OF_CREDITS"` and an `actionUrl` pointing at the wallet; the next line starts "OUT_OF_CREDITS:". **Surface the URL to the user verbatim**. They need to open it in a browser to buy credits. Do not retry the failed call until they confirm they purchased.',
    '',
    '## Response shape',
    'Analyze output is flat-keyed JSON: top-level keys are field names (e.g. `estimatedDate`, `peopleCount`, `atmosphere`), not lens names. Use `list_lenses` to map fields back to their owning lens. Dates: `estimatedDate.yearRange` (`{ from, to }`) is the estimate; `estimatedDate.year` is the single best year (kept for older clients); `rangeLabel` reads like "c. 1975–1985". Quote the range, not just the year, when confidence is `low` or `medium`. `dateSource` says where `year` came from: `exif` is the capture date the camera wrote, read from the original file before resizing (then `capturedAt` holds the timestamp, `yearRange` is that one year, and the visual guess is in `visualEstimate`); `visual` is the visual estimate. `notAfterYear` is a latest-possible year from a scan or save date. These are absent on older results.',
    '',
    '## Receipts',
    'Analyze and lookup results carry `receipts`, signed records of which lenses ran on which photo. `receipts` may be empty; on an analyze result, `warnings` then names why (`RECEIPT_UNAVAILABLE`, `RECEIPT_NONE_STORED`, or a `RECEIPT_NOT_ISSUED_*` code). Today only `pt_test_` keys receive receipts (signed by the public sandbox key, never vouching for live data), so a `pt_live_` key gets `RECEIPT_UNAVAILABLE` on a fresh analyze and `RECEIPT_NONE_STORED` on a registry hit.',
    '',
    '## Test vs live keys',
    'A `pt_test_` key runs the free sandbox: analyze returns deterministic golden-fixture data with `livemode: false`, `usage.creditsCharged: 0`, and `meta.provider: "test-sandbox"`, the same payload regardless of the image. Use it to wire up an integration, never as facts about a real photo. A `pt_live_` key returns real model output with `livemode: true`. Branch on `livemode`, not on `meta.provider`.',
    'Every tool error from the API starts with one line of JSON: `code`, `retryable`, and fields such as `retryAfterSeconds` or `actionUrl`. Read it before the sentence that follows; when `retryable` is false, do not retry.',
    `${SANDBOX_KEY_SENTENCE}: lookup_photo, get_credits and enrich_photo answer a sandbox key with a tool error whose code is SANDBOX_KEY, which is not retryable.`,
    `A rate limit comes back as a tool error whose code is RATE_LIMITED, with \`retryAfterSeconds\`; wait that long or stop, never retry at once. A wait over 10 minutes is marked not retryable. ${SANDBOX_RATE_LIMIT_SENTENCE}`,
  ].join('\n');
}

/** The start-up key check gets one attempt within this budget. */
const KEY_CHECK_BUDGET_MS = 5_000;

export interface StartServerOptions {
  /** The MCP package version, reported in serverInfo and the user agent. */
  version: string;
}

export interface StartedServer {
  server: McpServer;
  client: PhototologyClient;
  /** The background key check; resolves (never rejects) when it is done. */
  keyCheck: Promise<void>;
}

/**
 * Build the MCP server, register tools and resources, and connect it to the
 * transport.
 */
export async function startServer(apiKey: string, transport: Transport, opts: StartServerOptions): Promise<StartedServer> {
  const mcpVersion = opts.version;
  const mcpUserAgent = `@phototology/mcp/${mcpVersion}`;

  const server = new McpServer(
    {
      name: 'phototology',
      version: mcpVersion,
    },
    {
      instructions: buildServerInstructions(),
    },
  );

  const client = registerTools(server, apiKey, mcpUserAgent);
  registerResources(server, client);

  hookInitializeTelemetry(server, apiKey, mcpVersion);

  // Connect first: the handshake must never wait on the network. A key check
  // that blocked here held `initialize` for 90 s on a rate-limited launch,
  // past the client's 60 s timeout (2026-10-18 production smoke).
  await server.connect(transport);
  const keyCheck = checkKeyInBackground(apiKey, mcpUserAgent);
  return { server, client, keyCheck };
}

/**
 * One attempt, within KEY_CHECK_BUDGET_MS, on its own client so it neither
 * retries nor waits out a rate limit. A failure logs one warning; only a
 * rejected key is recorded for tool errors to repeat.
 *
 * A `pt_test_` key gets one GET /v1/usage instead. The API serves that route
 * before its anonymous limiter, so it costs none of the sandbox's 2 requests
 * a minute and 10 a day, and its answer tells the anonymous sandbox
 * (AUTH_FAILED) from an account-linked test key (200). The tools that need an
 * account wait for it, then answer SANDBOX_KEY locally for the former.
 */
function checkKeyInBackground(apiKey: string, userAgent: string): Promise<void> {
  // Never throws, never rejects: a background check must not take the server down.
  try {
    return startKeyCheck(apiKey, userAgent);
  } catch {
    return Promise.resolve();
  }
}

function startKeyCheck(apiKey: string, userAgent: string): Promise<void> {
  const checker = new PhototologyClient({
    apiKey,
    baseUrl: process.env.PHOTOTOLOGY_BASE_URL,
    userAgent: `${userAgent} (key-check)`,
    maxRetries: 0,
    timeout: KEY_CHECK_BUDGET_MS,
    maxElapsedMs: KEY_CHECK_BUDGET_MS,
    maxRateLimitWaitMs: 0,
  });

  if (apiKey.startsWith('pt_test_')) {
    const probe = checker.usage().then(
      () => setAnonymousSandbox(false),
      (err: unknown) => {
        // Anything but a rejection (timeout, network) leaves it unknown: the tools then ask the API.
        if (err instanceof AuthenticationError) setAnonymousSandbox(true);
      },
    );
    // Set synchronously, before any tool call can arrive.
    setSandboxProbe(probe);
    return probe;
  }

  return checker.modules().then(
    () => undefined,
    (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err);
      // Only a rejected key marks the session: tool errors repeat it. A
      // timeout, a network failure or a rate limit says nothing about the key,
      // so it gets the stderr warning only, and the tool's own error names it.
      if (err instanceof AuthenticationError) {
        setStartupProblem(`the API rejected it (${reason}). Check PHOTOTOLOGY_API_KEY, or create an account key at ${SIGNUP_URL}.`);
      }
      const repeat = err instanceof AuthenticationError ? ' Tool errors will repeat this.' : '';
      console.error(`  Warning: could not verify PHOTOTOLOGY_API_KEY (${reason}). The server is running.${repeat}`);
    },
  );
}

/**
 * Hook the initialize handshake so we can phone home which MCP client is
 * connecting (Claude Desktop, Cursor, Gemini CLI, etc.). McpServer exposes
 * the underlying Server instance at `server.server` whose `oninitialized`
 * callback fires after the handshake completes, by which point
 * `getClientVersion()` returns the client's stated name+version.
 * Wrapped in try/catch + a runtime existence check so the MCP keeps
 * booting even if the SDK shape shifts in a future minor.
 */
function hookInitializeTelemetry(server: McpServer, apiKey: string, mcpVersion: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const underlying = (server as any).server;
    if (underlying && typeof underlying === 'object') {
      const prior = typeof underlying.oninitialized === 'function'
        ? underlying.oninitialized.bind(underlying)
        : null;
      underlying.oninitialized = () => {
        try {
          const clientInfo = typeof underlying.getClientVersion === 'function'
            ? underlying.getClientVersion()
            : null;
          phoneHome(
            'mcp_initialize',
            {
              clientName: clientInfo?.name,
              clientVersion: clientInfo?.version,
              mcpVersion,
            },
            { apiKey, baseUrl: process.env.PHOTOTOLOGY_BASE_URL },
          );
        } catch { /* swallow: telemetry must never crash the MCP */ }
        if (prior) prior();
      };
    }
  } catch { /* swallow: telemetry hook is best-effort */ }
}
