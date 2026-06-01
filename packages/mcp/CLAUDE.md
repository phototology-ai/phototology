# @phototology/mcp Development Protocol
> **Version:** 1.2.1 | **Architecture:** MCP stdio server wrapping @phototology/sdk | **Updated:** 2026-06-01

## What This Is

Stdio MCP server that exposes `@phototology/sdk` as seven Model Context Protocol tools. Published to npm; referenced in Claude Code, Claude Desktop, Cursor, VS Code Copilot, Gemini CLI, Windsurf, Codex CLI. Binary: `phototology-mcp`.

**1.1.0 changes (2026-05-17):**
- Three new tools: `get_credits` (free balance read), `purchase_credits` (wallet deep-link), `analyze_batch` (1-200 photos per call).
- `list_modules` renamed to `list_lenses`; response reshaped from `{ modules, presets }` to `{ lenses, stacks }`.
- `analyze_photo` accepts `lenses: [...]` (preferred) and `stack: '...'` (preferred). The old names `modules` and `preset` work as deprecated aliases.
- `CreditExhaustedError` now returns `structuredContent.actions` with a typed `open_url` action so rich-rendering clients can show a button.
- Five companion skills ship in the npm package: `phototology:lookup-first`, `phototology:check-credits`, `phototology:smart-stack`, `phototology:photo-shared`, `phototology:batch-analyze`.
- Every tool declares full annotations (`readOnlyHint`, `destructiveHint: false`, `idempotentHint`, `openWorldHint`).

**1.0.0 breaking change (2026-04-17):** `lookup_photo` returns the Registry v2 shape — `photo.lenses` keyed map, not `analyses[]`. `analyze_photo` accepts `refresh?: boolean` to bypass the per-user-per-photo projection cache.

## Quick Start

| Command | Action |
|---------|--------|
| `pnpm build` | Compile to `dist/` |
| `pnpm typecheck` | Type-check without emit |
| `pnpm test` | Run Jest suite |
| `PHOTOTOLOGY_API_KEY=pt_test_... node dist/index.js` | Run server locally |

## Architecture

`src/index.ts` — reads `PHOTOTOLOGY_API_KEY`, builds the server-instructions handshake payload, creates `McpServer` with stdio transport, calls `registerTools()`.

`src/tools.ts` — re-export shim. Real code lives under `src/tools/`:

| File | Purpose |
|------|---------|
| `src/tools/index.ts` | Barrel. Instantiates the `PhototologyClient` once and calls each per-tool register function. |
| `src/tools/errors.ts` | `renderToolError()` + `ToolAction` type. Maps SDK errors to MCP tool-result shape, with `structuredContent.actions` on `CreditExhaustedError`. |
| `src/tools/analyze-photo.ts` | `analyze_photo` tool. Accepts `lenses`/`stack` (preferred) or legacy `modules`/`preset`. Translates to SDK args. |
| `src/tools/analyze-batch.ts` | `analyze_batch` tool. 1-200 photos per call. Lookup-first internally (per-URL, concurrency 20), analyzes cache-misses with bounded concurrency (`ANALYZE_CONCURRENCY = 25`), surfaces `totalCacheHits`/`estimatedCreditsSaved`. |
| `src/tools/list-lenses.ts` | `list_lenses` tool. Reshapes the SDK's `{ modules, presets }` into MCP-facing `{ lenses, stacks }`. |
| `src/tools/lookup-photo.ts` | `lookup_photo` tool. Free. |
| `src/tools/get-credits.ts` | `get_credits` tool. Free. Wraps `client.usage()` for dual-pool balance reads. |
| `src/tools/purchase-credits.ts` | `purchase_credits` tool. Free. Returns the wallet deep-link with `utm_source=mcp` and a structured `open_url` action. |
| `src/tools/enrich-photo.ts` | `enrich_photo` tool. Writes cached lens output into the photo's EXIF/IPTC/XMP metadata (defaults to `["xmp"]`); optional `outputPath` writes enriched bytes to disk. Requires a prior analyze. 5 credits per call. Wraps `client.enrich()`. |

Tools are `readOnlyHint: true`, `destructiveHint: false`. Successful results return `{ content: [{ type: 'text', text: JSON }] }` plus optional `structuredContent` for rich clients.

## Companion Skills

`skills/` ships in the npm package. Each `SKILL.md` is a self-contained markdown skill the user can copy into `~/.claude/skills/<name>/`:

| Skill | When to use |
|-------|------------|
| `phototology:lookup-first` | Before any analyze. Always. |
| `phototology:check-credits` | Before big batches or bespoke calls. |
| `phototology:smart-stack` | When the user has a narrow question; picks the cheapest lens subset. |
| `phototology:photo-shared` | Whenever the user shares, attaches, drops, or references an image. Routes through the registry-first analysis path. |
| `phototology:batch-analyze` | Any job with 2+ photos. Uses `analyze_batch` (not a loop). Bulks lookups, chunks analyzes, surfaces credit savings. |

## Key Conventions

**Env var required at startup:** `PHOTOTOLOGY_API_KEY` is checked in `index.ts` before server init. Missing key writes to stderr and exits with code 1 (stdout is reserved for JSON-RPC).

**Cast workaround:** `server as any` is used in each `registerXxx()` function to avoid TS2589 from complex Zod generics in the MCP SDK. Intentional. Do not remove.

**Optional base URL:** `PHOTOTOLOGY_BASE_URL` env var overrides the default API base (useful for local dev against `phototology-api`).

**Anonymous client-discovery telemetry (2026-05-21):** `src/phone-home.ts` fires a single `POST /v1/mcp/event` (Bearer-auth with the user's existing `PHOTOTOLOGY_API_KEY`) when the MCP initialize handshake completes. Payload: the editor's stated `clientInfo.name`/`version` (Claude Desktop, Cursor, Gemini CLI, etc.) plus the MCP package version. Forwards to PostHog server-side via `phototology-api/src/v1/mcpEvent.ts`. **No PostHog project key is distributed inside this package** — that's the deliberate posture that broke the original 2026-05-17 attempt (commit `bc021f96`). Opt-out: `PHOTOTOLOGY_MCP_NO_TELEMETRY=1`. PII boundary: never sends image content, paths, tool inputs/outputs, or the API key itself (it's in the `Authorization` header, which is normal API auth, not a captured property).

**Per-tool telemetry (2026-05-31):** `src/tools/index.ts` also wraps every tool handler (a transparent `registerTool` Proxy) to fire one `mcp_tool_called` event per invocation: tool name, `ok`, `durationMs`, an `errorCode` on failure (including local-image failures that never reach the API), and analyze enrichment (`lensCount`/`creditsCharged`/`cacheHit`, batch `photoCount`/`cacheHits`). Same fire-and-forget, opt-out (`PHOTOTOLOGY_MCP_NO_TELEMETRY`), and PII boundary (counts/booleans/codes only). It is additive to the API-side `api_request` events; it exists because route-inference cannot split `analyze_photo` from `analyze_batch`, conflates `list_lenses` with the boot-time key-verify on `/modules`, and never sees local failures. Wire: `mcpToolEvent()` in `src/phone-home.ts` posts to the same `POST /v1/mcp/event` proxy (Zod-validated in `phototology-api/src/v1/mcpEvent.ts`, captured by `trackMcpEvent` in `services/posthog.ts`).

**No direct dependency on `@phototology/core`:** This package imports only `@phototology/sdk`. Never bypass the SDK to call the HTTP API directly.

**MCP-layer rename pattern:** `lenses`/`stack` are the preferred argument names on `analyze_photo` and the preferred response keys on `list_lenses`. The SDK still uses `modules` and `preset` internally; the MCP translates. New code should use the new names; old code keeps working during the 90-day deprecation window.

**Pricing model surfaced everywhere** (server instructions, tool descriptions, skills, README): 1 credit = $0.01 per lens per photo. Lookups free. Bespoke 5 credits per image plus 1 per stacked lens. Moderation free + always-on. Cache hits free. New users start with 5,000 free credits via the signup ladder (1,000 for verifying an email, 4,000 for adding a card-on-file; the card is never charged automatically). Packs at 1k/$10, 10k/$100, 100k/$1,000. First-purchase 2x bonus. No subscriptions. (Pricing v1 cutover 2026-05-17; see `docs/superpowers/specs/2026-05-17-phototology-pricing-v1-design.md`.)

## Phantom Patterns

| Pattern | Reality |
|---------|---------|
| 3, 5, or 6 tools | Seven: `analyze_photo`, `analyze_batch`, `list_lenses`, `lookup_photo`, `get_credits`, `purchase_credits`, `enrich_photo` |
| `list_modules` is a tool | Renamed to `list_lenses` in 1.1.0. No back-compat alias for the tool name. |
| `modules` / `preset` are removed | Still accepted as deprecated aliases on `analyze_photo`. Prefer `lenses` / `stack`. |
| `McpServer` constructed with auth config | Auth is handled by the SDK (`apiKey` in client config) |
| SSE or HTTP transport | Stdio only. Remote MCP is a follow-up, not in 1.1.0. |
| Stripe checkout completes inside MCP | Cannot. `purchase_credits` returns a wallet URL the user must open. |
| Direct PostHog SDK inside the MCP server | Reverted in `bc021f96` for distributing a project key in an npm package. Re-introduced 2026-05-21 via a proxy through `phototology-api` (`src/phone-home.ts` → `POST /v1/mcp/event`) so no PostHog key is bundled. API-side `api_request` events still capture `client_type=mcp` for every authenticated call. |

## Local-image helper (`src/lib/local-image.ts`)

Shared file-handling helper used by all three image-accepting tools. Single source of truth for:

- Path resolution: absolute or `~/`-prefixed only. Relative paths and `~user/` forms are rejected with `LocalImageError` (code `RELATIVE_PATH_REJECTED`).
- File reads: `lstat` (not stat) → symlink rejection → size cap (10MB raw) → magic-byte format sniff (JPEG/PNG/GIF/WebP/HEIC/AVIF/TIFF — the set the backend Sharp pipeline can decode; 1.2.1 widened from the old narrower gate that bounced AVIF the server could handle).
- Base64 validation: regex shape + length mod 4 check before `Buffer.from(...)` (which silently accepts garbage).
- Glob expansion via `fast-glob`: `onlyFiles`, `suppressErrors`, no symlink follow, 200-file cap.
- sha256 hashing via `node:crypto`.

Error type: `LocalImageError` with `code: LocalImageErrorCode` union. Rendered by `tools/errors.ts:renderToolError` as a structured tool error.

**When adding new tools that accept image input:** reuse this helper, don't reinvent. The path/format/size/base64 rules MUST be consistent across tools.

**For `lookup_photo` specifically:** local inputs run a transparent sha256→pHash cascade. The cascade short-circuits on any non-`'none'` matchType from the sha256 GET (covers both `'exact'` and the rare `'fuzzy'` case caused by the API's dummy-pHash substitution at `packages/phototology-api/src/v2/lookup.ts:266`).
