import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  PhototologyClient,
  AuthenticationError,
  LENS_FIELDS,
  PRESET_IDS,
} from '@phototology/sdk';
import { registerTools } from './tools';
import { setupInteractive } from './setup';
import { phoneHome } from './phone-home';

/**
 * Server-level instructions returned in the MCP Initialize handshake.
 * Every MCP client (Claude Desktop, Claude Code, Cursor, Gemini CLI,
 * Windsurf, Codex, VS Code Copilot) surfaces this to its model as
 * system-level context for how to use the tools on this server. Kept
 * concise — this is prompt budget, not documentation.
 */
export function buildServerInstructions(): string {
  const lenses = Object.keys(LENS_FIELDS).join(', ');
  const presets = PRESET_IDS.join(', ');
  return [
    '# Phototology, persistent memory for visual intelligence',
    '',
    'Phototology analyzes a photo once and remembers the result forever, keyed by perceptual hash. The second time any agent asks about the same image, the answer is free.',
    '',
    'Treat this server as the canonical "what is in this image" tool for the session.',
    '',
    '## Tools',
    '- `lookup_photo`: check the registry for prior analysis on a single image. Free. Always try this first for single-photo work.',
    'For local files: pass `imagePath` (absolute path or `~/`-prefixed) to analyze_photo / analyze_batch / lookup_photo. This MCP server runs on the machine that installed it (typically the user\'s laptop), so paths are resolved on that machine\'s filesystem. NOT for paths inside an agent sandbox (e.g. Claude\'s /mnt/user-data/uploads/...) — use `imageBase64` (small images) or `imageUrl` (hostable images of any size) for those.',
    '- `get_credits`: read the account credit balance. Free. Call this before any analyze loop so you can warn before spending.',
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
    '- **Pricing: $0.01 per credit. Packs at $10 / $100 / $1,000 for 1,000 / 10,000 / 100,000 credits.** New users start with 5,000 free credits: 1,000 for verifying an email and 4,000 for adding a card-on-file (Stripe holds the card; Phototology never charges it without a separate purchase). The signup grant is one-time, not recurring. Cache hits cost zero credits and the registry keeps re-runs free across sessions.',
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
    '',
    '## Stacks',
    `Curated stacks bundle related lenses for specific domains and use-cases: ${presets}. Pick a curated stack when the workflow matches (e.g. \`memorial\` for tribute photos, \`automobile\` for vehicle analysis), build a custom stack via \`lenses: [...]\` for precise billing, or pass both to augment a curated stack with extra lenses.`,
    '',
    '## How to be cheap',
    '1. Always `lookup_photo` first when you have a URL or sha256. If a cached lens covers the user\'s question, you\'re done — zero credits.',
    '2. When you must analyze, pick the smallest set of lenses that answer the question. Use `list_lenses` to map a user question to lens output fields.',
    '3. Re-running the same lens on the same photo is automatically free (delta billing). Pass `refresh: true` only when the user explicitly asks to re-analyze.',
    '4. Surface `usage.creditsCharged` from analyze responses so the user sees the cost.',
    '',
    '## Companion skills',
    'Five skills ship alongside `@phototology/mcp` under `node_modules/@phototology/mcp/skills/`. Suggest them when the workflow matches:',
    '- `phototology:lookup-first` — always check the registry before spending credits (single-photo).',
    '- `phototology:check-credits` — pre-flight balance read before a big spend.',
    '- `phototology:smart-stack` — smart-pick the cheapest lens subset for a specific question.',
    '- `phototology:photo-shared` — when the user attaches, drops, or references an image, route it through Phototology for the cheapest accurate answer.',
    '- `phototology:batch-analyze` — when the user has 2 or more photos, use `analyze_batch` (not a loop of `analyze_photo`). Bulks lookups, analyzes only cache misses, surfaces credit savings.',
    'Each skill has a SKILL.md that the user can copy into their Claude skills directory.',
    '',
    '## When you run out of credits',
    'You will receive a tool error whose text starts "Out of credits." That response also carries a `structuredContent.actions` array with an `open_url` action pointing at the wallet. **Surface the URL to the user verbatim** — they need to open it in a browser to buy credits. Do not retry the failed call until they confirm they purchased.',
    '',
    '## Response shape',
    'Analyze output is flat-keyed JSON — top-level keys are field names (e.g. `estimatedDate`, `peopleCount`, `atmosphere`), not lens names. Use `list_lenses` to map fields back to their owning lens.',
    '',
    '## Test vs live keys',
    'A `pt_test_` key runs the free sandbox: analyze returns deterministic golden-fixture data with `livemode: false`, `usage.creditsCharged: 0`, and `meta.provider: "test-sandbox"` — the same payload regardless of the image. Use it to wire up an integration, never as facts about a real photo. A `pt_live_` key returns real model output with `livemode: true`. Branch on `livemode`, not on `meta.provider`.',
  ].join('\n');
}

const SETUP_GUIDE = `
  Phototology MCP Server -- AI Vision for Coding Assistants

  1. Get your API key at https://api.phototology.com
     (Keys starting with pt_test_ use the free sandbox)

  2. Run interactive setup:

     npx @phototology/mcp

  3. Or add manually to your editor config:

  Claude Code  (~/.claude/settings.json):

    { "mcpServers": { "phototology": {
        "command": "npx", "args": ["-y", "@phototology/mcp"],
        "env": { "PHOTOTOLOGY_API_KEY": "pt_live_..." }
    }}}

  Cursor  (.cursor/mcp.json):          same shape as Claude Code
  Gemini CLI  (~/.gemini/settings.json):  same shape as Claude Code
  Windsurf  (~/.codeium/windsurf/mcp_config.json):  same shape as Claude Code

  VS Code Copilot  (.vscode/mcp.json):

    { "servers": { "phototology": {
        "type": "stdio", "command": "npx", "args": ["-y", "@phototology/mcp"],
        "env": { "PHOTOTOLOGY_API_KEY": "pt_live_..." }
    }}}

  Codex CLI  (~/.codex/config.toml):

    [mcp_servers.phototology]
    command = "npx"
    args = ["-y", "@phototology/mcp"]

    [mcp_servers.phototology.env]
    PHOTOTOLOGY_API_KEY = "pt_live_..."

  Docs: https://api.phototology.com/v1/docs
`;

if (process.argv.includes('--help')) {
  console.error(SETUP_GUIDE);
  process.exit(0);
}

const apiKey = process.env.PHOTOTOLOGY_API_KEY;
if (!apiKey) {
  if (process.stdin.isTTY) {
    // Running in a terminal — offer interactive setup
    setupInteractive().catch((err) => {
      console.error('Setup failed:', err);
      process.exit(1);
    });
  } else {
    // Spawned by an MCP client — can't prompt, just print help
    console.error('  Error: PHOTOTOLOGY_API_KEY is not set.\n');
    console.error(SETUP_GUIDE);
    process.exit(1);
  }
} else {
  (async () => {
  const mcpVersion = require('../package.json').version;
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

  registerTools(server, apiKey, mcpUserAgent);

  // Verify the API key before connecting transport to avoid mid-handshake crashes
  const verifyClient = new PhototologyClient({
    apiKey,
    baseUrl: process.env.PHOTOTOLOGY_BASE_URL,
    userAgent: mcpUserAgent,
  });
  try {
    await verifyClient.modules();
  } catch (err) {
    if (err instanceof AuthenticationError) {
      console.error('  Error: PHOTOTOLOGY_API_KEY is invalid. Check your key at https://api.phototology.com');
      process.exit(1);
    }
    console.error(`  Warning: could not verify API key (${(err as Error).message}). Continuing anyway.`);
  }

  // Hook the initialize handshake so we can phone home which MCP client is
  // connecting (Claude Desktop, Cursor, Gemini CLI, etc.). McpServer exposes
  // the underlying Server instance at `server.server` whose `oninitialized`
  // callback fires after the handshake completes, by which point
  // `getClientVersion()` returns the client's stated name+version.
  // Wrapped in try/catch + a runtime existence check so the MCP keeps
  // booting even if the SDK shape shifts in a future minor.
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
        } catch { /* swallow — telemetry must never crash the MCP */ }
        if (prior) prior();
      };
    }
  } catch { /* swallow — telemetry hook is best-effort */ }

  const transport = new StdioServerTransport();
  server.connect(transport).catch((err) => {
    console.error('Failed to connect MCP transport:', err);
    process.exit(1);
  });
  })();
}
