# Changelog

All notable changes to `@phototology/mcp` are tracked here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [SemVer](https://semver.org/).

## [1.1.3] — 2026-05-21

### Added

- **Anonymous client-discovery telemetry.** `src/phone-home.ts` fires a single `POST /v1/mcp/event` to `api.phototology.com` when the MCP initialize handshake completes, carrying the editor's stated `clientInfo.name`/`.version` (e.g. `claude-desktop 0.7.0`, `cursor 0.42`) and the MCP package version. Closes the discovery gap left by the api-side `api_request` event, which only fires after an authenticated HTTP call lands and therefore can't see the "downloaded MCP, ran handshake, never made a real tool call" funnel. Posture: no third-party SDK bundled (this is what triggered the 2026-05-17 revert in `bc021f96`); the only outbound destination is `api.phototology.com` — the same host every analyze + lookup call already goes through. Authentication uses the user's existing `PHOTOTOLOGY_API_KEY`. Errors are swallowed completely (telemetry must never crash the MCP). **Opt out with `PHOTOTOLOGY_MCP_NO_TELEMETRY=1`** in the same env block as your API key. PII boundary: image content, paths, prompts, tool inputs/outputs, and the API key itself are never sent.

### Security

- **Editor-config writes now use `mode: 0o600`** (`src/setup.ts:writeJsonConfig` + `writeTomlConfig`). The written files contain `PHOTOTOLOGY_API_KEY=pt_live_...`. Pre-fix permissions defaulted to the user's umask (typically `0o644` — world-readable). On shared dev machines or cloud IDEs (Codespaces, Gitpod), the key was readable by any other user on the box. Closes Audit #5 HIGH (2026-05-19).

### Changed

- **npm `description` field rewritten** to claim the differentiator (registry + composable lenses + structured JSON output) rather than the generic "MCP server for Phototology AI vision API". Closes Audit #1 EC1 + Audit #2 AM-H1 (2026-05-19).
- **npm `keywords` extended** with the differentiating terms (`registry`, `photo-registry`, `perceptual-hash`, `visual-memory`, `cache-hits`, `delta-billing`, `analyze-once`, `mcp-server`) so npm search + LLM-readable surfaces surface the actual moat. Closes Audit #1 EC2 + Audit #2 AM-H2 (2026-05-19).
- **Copy consistency cleanup.** Removed stale lens-count claims ("16 lenses", "~16 credits per photo") across server instructions, tool descriptions, README, and companion skills. Lens catalog size now lives entirely at runtime — agents call `list_lenses` for the current count. The `full-analysis` stack is now described as "runs every lens in the catalog" instead of naming a fixed credit total.
- **Signup grant wording aligned.** `photo-shared` skill no longer claims "1,000 free community credits per month" (a pricing-v0 leftover). Server instructions now state the signup grant is "one-time, not recurring" to prevent agents inferring monthly cadence.
- **`get_credits` description.** "preset" → "stack" (matches 1.1.0 rename), dropped the misleading "~16 credits per photo" line.
- **`analyze_batch` description.** Concurrency claims now match the code: per-URL lookups at 20 in flight (was "chunked into 50s server-side"), per-photo analyze at 25 in flight (was "5 in flight").

No tool surface changes. The only behavioral delta vs 1.1.2 is the new initialize-time telemetry beacon to `api.phototology.com/v1/mcp/event` (see Added above). Set `PHOTOTOLOGY_MCP_NO_TELEMETRY=1` to disable.

## [1.1.2] — 2026-05-18

### Changed

- `repository.url` switched to `github.com/phototology-ai/phototology` and `repository.directory: "packages/mcp"` added. Reflects the consolidated public repo (formerly distributed from a separate `phototology-ai/phototology-mcp` repo, now archived). The npm package page's "Repository" link points directly to `packages/mcp/` in the consolidated home.
- `bugs.url` updated to the consolidated repo's issue tracker.

No functional changes. Tool surface, server instructions, skills, and dependencies all identical to 1.1.1.

## [1.1.1] — 2026-05-17

### Changed

- Update server instructions, README, and `phototology:check-credits` skill to reflect the pricing v1 launch: 5,000-credit signup ladder (1,000 for verifying an email + 4,000 for adding a card-on-file) replaces the prior 1,000/month community grant. Pack table ($10 / $100 / $1,000 for 1,000 / 10,000 / 100,000 credits), $/credit, and the first-purchase 2x bonus are unchanged. `buildServerInstructions` is now exported for testability.

## [1.1.0] — 2026-05-17

### Added

- `get_credits` tool. Free. Reads the dual-pool balance (`community.balance + purchased.balance - reserved`) via the SDK's new `client.usage()` method. Use before any analyze loop to warn the user before spending.
- `purchase_credits` tool. Free. Returns a deep-link to the Phototology wallet with `utm_source=mcp`. The tool description teaches the new pack catalog and the first-purchase 2x bonus.
- `analyze_batch` tool. Analyze 1 to 200 INDEPENDENT photos in a single call. Internally bulk-looks-up against the registry (chunked into 50s, free), serves cache hits at 0 credits, runs per-photo analyze with bounded concurrency (5 in flight) for the misses. Returns per-photo outcomes plus `totalCacheHits`, `totalAnalyzed`, `totalCreditsCharged`, and `estimatedCreditsSaved` so the registry's value is visible. For thousands of photos, the agent loops the tool in slices of 200.
- Structured `actions` payload on `CreditExhaustedError`. Rich-rendering MCP clients (Claude Code, Cursor, future Claude.ai) now receive a typed `open_url` action alongside the text fallback. Built against MCP spec 2025-11-25. Legacy clients keep seeing the URL in the text.
- Five companion skills shipped under `node_modules/@phototology/mcp/skills/`:
  - `phototology:lookup-first` — always check the registry before spending credits (single photo).
  - `phototology:check-credits` — pre-flight balance read before a big batch.
  - `phototology:smart-stack` — smart-pick the cheapest lens subset for a specific question.
  - `phototology:photo-shared` — when the user attaches, drops, or references an image, route it through Phototology for the cheapest accurate answer.
  - `phototology:batch-analyze` — any job with 2 or more photos. Uses `analyze_batch` (not a loop of `analyze_photo`). Documents the loop pattern for thousand-photo jobs.
- Optional Claude Code `UserPromptSubmit` hook documented in the README — auto-trigger Phototology suggestions when the user attaches an image.
- Explicit tool annotations on every tool: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint` (true for outward calls, false for `list_lenses`).
- Dogfood kit at `scripts/dogfood/` — a 50-line mock server that returns 402 on `/v1/analyze`, plus a 5-minute walkthrough for verifying the structured-action rendering in a real Claude Code session.

### Changed

- **Brand vocabulary alignment.**
  - `list_modules` tool renamed to `list_lenses`. The response shape was reshaped from `{ modules, presets }` to `{ lenses, stacks }`; the inner `modules` field on each stack was also renamed to `lenses` for consistency.
  - `analyze_photo` now accepts `lenses: [...]` (preferred) and `stack: '...'` (preferred). The previous names `modules: [...]` and `preset: '...'` still work as deprecated aliases during the rename. The MCP translates them to the SDK's `modules` and `preset` internally; the SDK and API are unchanged.
- Tool descriptions rewritten end-to-end per Anthropic's tool-design rules. Each description names the cost, when to use, what to chain with, and the response shape.
- Server instructions (the system-level handshake context) rewritten to lead with the registry/persistence differentiator and the new pricing model (1¢/lens, lookups free, bespoke 5 credits + 1 per stacked lens, moderation free, 1,000 community credits/month free, packs at $10/$100/$1,000 for 1k/10k/100k credits, first-purchase 2x bonus, no subscriptions).
- README rebuilt Context7-style: hero tagline, npx one-liner, Without/With contrast, 6-tool quick table with cost column, full pricing section, install snippets verified for 7 editors (Claude Code, Claude Desktop, Cursor, VS Code Copilot, Windsurf, Gemini CLI, Codex CLI), first-5-minutes walkthrough, companion skills, FAQ.

### Internal

- `src/tools.ts` split into per-tool files under `src/tools/`. The historical `src/tools.ts` is now a re-export shim so existing imports keep working.
- New `src/tools/errors.ts` centralizes `renderToolError()` and the structured-action shape.
- Test coverage: 28 tests across 6 suites (up from 18 across 3). New: `errors.test.ts`, `get-credits.test.ts`, `purchase-credits.test.ts`. Updated: `tools.test.ts` asserts the new 6-tool registration and the annotations on each.

### SDK companion

- `@phototology/sdk@1.0.2` ships a strictly additive `client.usage()` method returning the dual-pool balance from `GET /v1/usage`. No existing SDK method signatures change.

## [1.0.1] — 2026-04-17

- Initial public release of the stdio MCP server wrapping `@phototology/sdk`.
- Three tools: `analyze_photo`, `list_modules`, `lookup_photo`.
- Interactive setup wizard for 6 editors.
- Test sandbox via `pt_test_` keys.
- `lookup_photo` returns the Registry v2 shape (`photo.lenses` keyed map).
- `analyze_photo` accepts `refresh?: boolean` to bypass the projection cache.
