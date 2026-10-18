# Changelog

All notable changes to `@phototology/mcp` are tracked here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning follows [SemVer](https://semver.org/).

## [2.0.0] - 2026-10-18

### Breaking
Four tool results changed shape, so this is a major release. `analyze_batch` returns `{ summary, results[] }` instead of top-level `totalSubmitted`, `totalCacheHits` and other `total*` counters, and a failed photo is `{ input, error }` instead of a `source: 'error'` row. `lookup_photo` returns one flattened result for the image asked about instead of `results[sha256]`. `enrich_photo` returns a typed envelope (`mode`, `usage`, `sidecar`, `sidecarSavedTo`) and takes two new inputs, `overwrite` and `breakCredentials`; `outputPath` now refuses an existing file unless `overwrite: true`. `get_credits` keeps only `total` and `usd` as always present, and its legacy pool fields (`tier`, `community`, `purchased`, `reserved`) are optional. The details are under Changed and Security.

Typed results. Every tool now declares an `outputSchema` and returns `structuredContent` that matches it, next to the same JSON in a text block. The schemas are open objects, so a field the API adds later never makes a client reject a result. Several result shapes changed; the old field names are listed under Changed.

### Added
- **`outputSchema` and `structuredContent` on all seven tools.** Prices appear in dollars beside credits everywhere: `usage.usd` on analyze results, `summary.usd` on batches, `usd` on `get_credits`, `usage.usd.charged` on `enrich_photo`, and `credits` plus `usdPerPhoto` on each `list_lenses` lens and stack (1 credit = $0.01).
- **`analyze_batch` `dryRun: true`.** Looks up every input (URLs, local files and base64), bills nothing and analyzes nothing. Each row is `{ input, matchType, cachedLenses, missingLenses, resource? }`, and `summary.estimate` holds `{ photos, cacheHits, creditsNeeded, usd }`. Every batch, dry or not, also carries `summary.estimate` and a one-line estimate in text. On a real run the estimate for local-file and base64 inputs is an upper bound, since those are not looked up before analysis. With `refresh: true` a dry run still looks every photo up, so rows keep their real `matchType`, while the estimate prices every lens. A `stack` batch whose lens catalog is unreachable still runs, with `estimate: null` and `summary.warnings: ['ESTIMATE_UNAVAILABLE']`.
- **Resources.** `phototology://lenses` serves the lens and stack catalog (the same data as `list_lenses`). `phototology://photo/{sha256}` serves one registry record, free to read; a photo not in the registry reads as `PHOTO_NOT_IN_REGISTRY`.
- **`resource_link` blocks.** `analyze_photo`, `analyze_batch` and `lookup_photo` link each named photo to its `phototology://photo/{sha256}` resource, and say the same in a `resource` field.
- **`enrich_photo` preview.** When the API returns enriched bytes, the result carries an `image` content block: a JPEG of the enriched photo with its longest edge at most 1024 px (never enlarged), quality 80, EXIF rotation applied. Full-size bytes still go to `outputPath` or `imageBase64` as before. Adds `sharp` as a dependency, loaded only when a preview is made: if its native binary cannot load, the tools still start and `enrich_photo` returns its result with a `warnings` entry instead of the preview.
- **`enrich_photo` keeps content credentials.** When the photo carries a valid or trusted content credential, the API leaves the photo untouched and returns the analysis as an XMP sidecar (`mode: 'sidecar'`, with `reason`). With `imagePath` the sidecar is saved beside the original as `<imagePath>.xmp` and named in `sidecarSavedTo`, under the same rules as `outputPath` (an existing `.xmp` is left alone unless `overwrite: true`; the call then returns an error whose JSON first line still carries the packet in `sidecar.xmp`, with `sidecarPath`); otherwise it comes back in `sidecar.xmp`. `breakCredentials: true` writes the copy anyway; when that breaks a credential, the result warns `CREDENTIAL_INVALIDATED`. A `note` says in plain words why the photo was left untouched, or what a copy lost. Billed the same either way.
- **Receipts and content credentials on results.** `analyze_photo`, `analyze_batch` rows and `lookup_photo` carry `receipts` (an empty list when the API sends none) and `credentials` when the API includes them. A batch row served from the registry without a fresh analyze carries an empty `receipts` list; `lookup_photo` or the `phototology://photo/{sha256}` resource returns the stored ones. Verify a receipt with `verifyReceiptSignature` or `verifyReceipt` from `@phototology/sdk`.

### Changed
- Bundles **`@phototology/sdk@2.0.0`** (receipts, content credentials, image identity fields, `getPhoto`).
- **Tool errors carry no `structuredContent`.** The official client (`@modelcontextprotocol/sdk` 1.32) validates `structuredContent` against the tool's `outputSchema` even when `isError` is true, so an error carrying it reached the agent as "-32602 Structured content does not match the tool's output schema" and its text was lost. That applied to the out-of-credits error's `actions` payload as well. Every error from the API now puts its machine fields in the first text line as JSON (`code`, `retryable`, and `retryAfterSeconds`, `actionUrl`, `creditsRequired` or `balance` where they apply), followed by the sentence. The out-of-credits wallet link is `actionUrl` there. Local path and file errors (`FILE_NOT_FOUND`, `PATH_OUTSIDE_ALLOWED_DIRS`, `OUTPUT_EXISTS` and the rest) use the same shape: a one-line JSON head with `code`, `retryable: false` and the path fields, then the sentence.
- **The handshake never waits on the network.** The server connects first and checks the key afterwards with one attempt and a 5 s budget, so `initialize` answers at once even when the API is slow or rate-limited (it took 90 s on a rate-limited launch, past the client's 60 s timeout). A failed check logs one warning. Only a key the API rejected marks the session, and every tool error then repeats it; a timeout, network failure or rate limit at start-up says nothing about the key and marks nothing. An invalid key no longer exits the process. A `pt_test_` key gets one `GET /v1/usage` instead, which the API serves before its anonymous limiter, so start-up spends none of the sandbox's requests; its answer tells the anonymous sandbox from an account-linked test key.
- **Rate limits return at once.** A tool hit by a rate limit returns `isError` with code `RATE_LIMITED` and `retryAfterSeconds` instead of waiting out the window (the SDK's new wait cap); a wait over 600 s is marked `retryable: false`, since no retry inside an agent session helps. With a sandbox key the text adds the sandbox limits: 2 requests a minute and 10 a day per IP.
- **A slow or dead API returns a tool error within 55 s.** The tools' SDK client now has a 55 s total budget, just under an MCP client's 60 s request timeout (it was the SDK's 90 s, past it) and keeps the 10 s rate-limit wait cap. A timeout reads as code `TIMEOUT`, retryable; an unreachable API (`NETWORK_ERROR`) names the base URL in use and `PHOTOTOLOGY_BASE_URL`.
- **Sandbox keys get a plain answer.** `lookup_photo`, `get_credits` and `enrich_photo` with a `pt_test_` key return code `SANDBOX_KEY` (not retryable, with a signup link) instead of "auth failed", and the `phototology://photo/{sha256}` resource reads as the same sentence instead of a protocol error. Once the start-up probe confirms the key has no account, they answer locally without a request, so they never spend the anonymous quota or show RATE_LIMITED in a closed window; an account-linked `pt_test_` key (the web app issues them) keeps working. The server instructions say the lookup-first and credits-first steps apply to account keys.
- **Key links go to the signup page** (https://phototology.com/signup) in errors, `--help`, interactive setup and the README.
- **Claude Code setup** names `claude mcp add phototology --scope user ... -- npx -y @phototology/mcp`, `~/.claude.json` and a project `.mcp.json` in `--help` and the README; interactive setup writes `~/.claude.json` (through a temp file renamed into place, removed if the write fails, and through a symlink to the real file rather than over the link), not `~/.claude/settings.json`, names `claude mcp add` and `.mcp.json` after writing it, and leaves any config file it cannot parse untouched, printing what to add instead.
- **The server instructions list only selectable lenses.** `vehicle-condition` comes only from its stack, which the instructions now say, since the API refuses it in `lenses`.
- **`analyze_photo` result** is `{ photo: { sha256, pHash, dHash, ... }, output, lenses, usage: { creditsCharged, creditsSaved, usd: { charged, saved }, modulesUsed }, cacheHit, receipts, credentials?, resource?, livemode }`. `id`, `meta`, `warnings` and `embedding` are still there as extra fields.
- **`analyze_batch` result** is `{ summary, results }`. `summary` holds `photos`, `cacheHits`, `analyzed`, `errors`, `creditsCharged`, `creditsSaved`, `usd: { charged, saved }`, `estimate` (null when it could not be priced), `dryRun?` and `warnings?`. It replaces `totalCacheHits`, `totalCreditsCharged` and `estimatedCreditsSaved`. Each `results[i]` is the `analyze_photo` result plus `input` (and `matchType` when the registry served it), or `{ input, error: { code, message } }` for a photo that failed, replacing the old `source: 'error'` rows.
- **`lookup_photo` result** is flattened to the one image asked about: `{ matchType, photo?, hammingDistance?, pdqDistance?, matchedBy?, computedHashes?, receipts, credentials?, resource? }`. `matchedBy: 'registryId'` marks a local file matched by the registry id a prior enrich wrote into its XMP. Cached lens output moves from `results[sha256].photo.lenses` to `photo.lenses`. `matchType` is `exact`, `pixels`, `pdq`, `fuzzy` or `none`.
- **`get_credits`** adds `usd`. Only `total` and `usd` are always present; `tier`, `community`, `purchased` and `reserved` are optional, so a dropped legacy field never fails a balance read. An older API without `total` gets it summed from the two pools.
- **`list_lenses`** adds `credits` to each lens and `credits` plus `usdPerPhoto` to each stack.
- **`purchase_credits`** documents its `{ url, actions }` shape; no field changed.
- **`enrich_photo` result** is `{ mode, savedTo?, imageBase64?, sidecar?, formatsWritten, lensVersions, sha256, registryId?, credentials?, reason?, usage: { creditsCharged, usd: { charged } }, warnings?, meta? }`. `usage.creditsCharged` is the canonical cost field; `meta.creditsCharged` is still present for compatibility. The top-level `creditsCharged` that the `outputPath` path used to return is gone, and so is `object`. `mode` is `file` when the metadata went into the image, or `sidecar` when the API returned an XMP packet instead and left the file untouched; a sidecar result writes nothing to `outputPath`.

### Security
Trust patch: local file reads and writes are bounded, and an output never replaces a file you did not ask to replace.
- **`enrich_photo` `overwrite`.** `outputPath` refuses an existing file with `OUTPUT_EXISTS` unless you pass `overwrite: true`. The check runs before any credits are spent, and the write itself opens the file exclusively, so a file that appears during the call is refused too.
- **The output is never the input.** `outputPath` naming the input file, or a link to it, is refused with `OUTPUT_IS_INPUT`, even with `overwrite: true`.
- **Symlinks are never written through.** A symlink at `outputPath` is refused with `OUTPUT_IS_SYMLINK`, even with `overwrite: true`, and the write opens the file without following links. A symlinked file passed as an input is still refused with `SYMLINK_REJECTED`.
- **`PHOTOTOLOGY_MCP_ALLOWED_DIRS`.** An optional list of folders, separated by `:` (`;` on Windows), that bounds reads (`imagePath`, `imagePaths`), the `enrich_photo` output path and `analyze_batch` globs. Paths are judged after symlinks are resolved, and a path outside the folders is refused with `PATH_OUTSIDE_ALLOWED_DIRS`. A glob whose fixed folder part is outside them comes back as one error row naming only the pattern, and a match that leads outside is skipped. While the variable is set, any path or pattern with a `..` segment is refused. Unset, any path the server process can open is allowed, as before.
- **`resolvedPath`.** A result read through a symlinked folder (`analyze_photo`, `analyze_batch` rows, `lookup_photo`, `enrich_photo`) names the real file that was read in `resolvedPath`. It is absent for a plain path.
- **Tool titles.** Every tool carries a human-readable `title`: "Analyze a photo", "Analyze a batch of photos", "List lenses and stacks", "Look up a photo in the registry", "Check credit balance", "Buy credits" and "Write analysis into a copy of the photo".
- **`server.json`.** Registry metadata for the MCP Registry under the name `com.phototology/mcp`, listing the npm package, its stdio transport and its environment variables.
- **`SECURITY.md`.** Says what the server reads, what it sends, what it never sends, what is not a security boundary, and how to report a vulnerability.
- **Telemetry stays off in tests and under `DO_NOT_TRACK`.** No event is sent when `NODE_ENV=test` (a test opts back in with `PHOTOTOLOGY_MCP_TELEMETRY_IN_TESTS`), or when `DO_NOT_TRACK` or `PHOTOTOLOGY_MCP_NO_TELEMETRY` is `1`, `true`, `yes` or `on`.

## [1.3.0] - 2026-06-02

### Changed
- Bundles **`@phototology/sdk@1.3.0`**, which **bounds total request time** (30s per attempt + a 90s overall wall-clock budget) so a stalled upstream can't hang a call for minutes. No MCP API change.

### Fixed
- README `analyze_batch` description corrected to "5 in flight", the actual per-photo analyze concurrency since 1.2.1 (the 1.2.1 tarball shipped a stale "25 in flight").

## [1.2.1] - 2026-06-01

Patch release hardening the local-file path from live dogfooding. All additive/non-breaking.

### Added
- **AVIF + TIFF accepted** by the local-file/base64 gate, matching what the backend Sharp pipeline already decodes. Previously these bounced with `UNSUPPORTED_FORMAT` despite the server handling them. The `UNSUPPORTED_FORMAT` message now lists the full accepted set and suggests a one-line conversion for RAW/other formats.

### Fixed
- **`analyze_batch` no longer self-throttles.** Concurrency lowered from 25 to 5 to match the API's per-user `/analyze` cap, so large batches queue client-side instead of getting 429'd. (The previous 25 accounted only for the 600 RPM rate limit, not the separate concurrency limiter.)
- **`estimatedCreditsSaved` now counts local-file savings.** It derives from each photo's real `creditsCharged` (a zero-charge analyze is a cache hit), so server-side delta savings on local files are no longer invisible.
- **`vehicle-condition` removed from the selectable `lenses`/`modules` enum**: it is stack-only and the API rejects it on direct selection.

> Related: `warmCaption` no longer truncates mid-word and its cap was raised 150→240. That fix lives in `@phototology/core` (the analysis backend) and reaches you via the API, not this package.

## [1.2.0] - 2026-06-01

First coordinated 1.2.0 cut with `@phototology/sdk`. Adds a seventh tool (`enrich_photo`), local-file and base64 image input on every image-accepting tool, and per-tool usage telemetry. Existing `imageUrl` callers see no behavior change.

### Added

- **`enrich_photo` tool (the seventh tool).** Writes a photo's already-cached lens output into its EXIF/IPTC/XMP metadata so the intelligence travels with the file. Accepts `imageUrl`, `imageBase64`, or `imagePath`, plus an optional `outputPath` to save the enriched bytes to local disk. Costs 5 credits per call and requires a prior analyze on the same photo. Wraps the SDK's new `client.enrich()`.
- **Local-file and base64 input on `analyze_photo`, `analyze_batch`, and `lookup_photo`.** New input modes: `imagePath` (absolute or `~/`-prefixed) and `imageBase64`; `analyze_batch` also adds `imagePaths` (glob patterns via fast-glob) and `imagesBase64`. A new shared helper, `src/lib/local-image.ts`, is the single source of truth for path resolution, reads, sha256 hashing, base64 validation, and glob expansion. Caps: 10MB per image, 200 inputs per call, 200-file glob. Relative paths and symlinks are rejected; formats (JPEG, PNG, GIF, WebP, HEIC) are magic-byte sniffed, not extension-trusted. Schema-additive and fully backward-compatible.
- **`lookup_photo` runs a transparent sha256 to pHash cascade** on local or byte input, short-circuiting on any sha256 hit. Both lookup calls stay free.
- **Per-tool usage telemetry.** One `mcp_tool_called` PostHog event per tool invocation (fire-and-forget, PII-free: ok, duration, error code, plus analyze enrichment counts like lens count, credits charged, cache hit, and batch photo/cache-hit counts). It complements the initialize-time discovery beacon shipped in 1.1.3. Opt out with `PHOTOTOLOGY_MCP_NO_TELEMETRY=1` (same flag as the discovery beacon).
- Server instructions and the companion skills (`photo-shared`, `batch-analyze`, `lookup-first`) updated for local-file input and the `enrich_photo` tool.

### Changed

- **`list_lenses` surfaces per-lens `billable`, `defaultColumns`, and `internal`** flags, mirroring the API's `/v1/modules`.
- **`analyze_batch` per-photo error isolation extended to local inputs.** One bad file (missing, oversized, or malformed) surfaces as a `source: 'error'` outcome instead of failing the whole batch.
- **Server instructions and the test-vs-live block updated for `livemode`.** Sandbox `pt_test_` keys report `livemode: false`; live `pt_live_` keys report `livemode: true`. Branch on `livemode`, not on `meta.provider`.
- **`get_credits` and the 402 copy lead with `total`** (the spendable balance). The community/purchased split is described as back-compat plumbing, not two balances the user manages.

### Fixed

- **README `analyze_batch` description corrected.** Removed the stale "chunks analyzes into batches of 50" claim; the tool is lookup-first (per URL, free) then analyzes only cache misses with bounded concurrency.
- **Tool-count copy corrected** across the post-install setup message (six -> seven tools, now including `enrich_photo`) and the README ("6 tools registered" -> "7 tools registered").
- **GitHub link repointed** from the archived standalone `phototology-mcp` repo to the consolidated `phototology` monorepo at `packages/mcp`.
- Telemetry enrichment fields corrected: `enrich_photo` reads `meta.creditsCharged`; analyze normalizes `meta.cacheHit` to an explicit boolean.

### Dependencies

- Added `fast-glob ^3.3.2` for local-image glob expansion (no native bindings).

## [1.1.3] - 2026-05-21

### Added

- **Anonymous client-discovery telemetry.** `src/phone-home.ts` fires a single `POST /v1/mcp/event` to `api.phototology.com` when the MCP initialize handshake completes, carrying the editor's stated `clientInfo.name`/`.version` (e.g. `claude-desktop 0.7.0`, `cursor 0.42`) and the MCP package version. Closes the discovery gap left by the api-side `api_request` event, which only fires after a keyed HTTP call lands and therefore can't see the "downloaded MCP, ran handshake, never made a real tool call" funnel. Posture: no third-party SDK bundled (this is what triggered the 2026-05-17 revert in `bc021f96`); the only outbound destination is `api.phototology.com`, the same host every analyze + lookup call already goes through. Authentication uses the user's existing `PHOTOTOLOGY_API_KEY`. Errors are swallowed completely (telemetry must never crash the MCP). **Opt out with `PHOTOTOLOGY_MCP_NO_TELEMETRY=1`** in the same env block as your API key. PII boundary: image content, paths, prompts, tool inputs/outputs, and the API key itself are never sent.

### Security

- **Editor-config writes now use `mode: 0o600`** (`src/setup.ts:writeJsonConfig` + `writeTomlConfig`). The written files contain `PHOTOTOLOGY_API_KEY=pt_live_...`. Pre-fix permissions defaulted to the user's umask (typically `0o644`, world-readable). On shared dev machines or cloud IDEs (Codespaces, Gitpod), the key was readable by any other user on the box. Closes Audit #5 HIGH (2026-05-19).

### Changed

- **npm `description` field rewritten** to claim the differentiator (registry + composable lenses + structured JSON output) rather than the generic "MCP server for Phototology AI vision API". Closes Audit #1 EC1 + Audit #2 AM-H1 (2026-05-19).
- **npm `keywords` extended** with the differentiating terms (`registry`, `photo-registry`, `perceptual-hash`, `visual-memory`, `cache-hits`, `delta-billing`, `analyze-once`, `mcp-server`) so npm search + LLM-readable surfaces surface the actual moat. Closes Audit #1 EC2 + Audit #2 AM-H2 (2026-05-19).
- **Copy consistency cleanup.** Removed stale lens-count claims ("16 lenses", "~16 credits per photo") across server instructions, tool descriptions, README, and companion skills. Lens catalog size now lives entirely at runtime: agents call `list_lenses` for the current count. The `full-analysis` stack is now described as "runs every lens in the catalog" instead of naming a fixed credit total.
- **Signup grant wording aligned.** `photo-shared` skill no longer claims "1,000 free community credits per month" (a pricing-v0 leftover). Server instructions now state the signup grant is "one-time, not recurring" to prevent agents inferring monthly cadence.
- **`get_credits` description.** "preset" → "stack" (matches 1.1.0 rename), dropped the misleading "~16 credits per photo" line.
- **`analyze_batch` description.** Concurrency claims now match the code: per-URL lookups at 20 in flight (was "chunked into 50s server-side"), per-photo analyze at 25 in flight (was "5 in flight").

No tool surface changes. The only behavioral delta vs 1.1.2 is the new initialize-time telemetry beacon to `api.phototology.com/v1/mcp/event` (see Added above). Set `PHOTOTOLOGY_MCP_NO_TELEMETRY=1` to disable.

## [1.1.2] - 2026-05-18

### Changed

- `repository.url` switched to `github.com/phototology-ai/phototology` and `repository.directory: "packages/mcp"` added. Reflects the consolidated public repo (formerly distributed from a separate `phototology-ai/phototology-mcp` repo, now archived). The npm package page's "Repository" link points directly to `packages/mcp/` in the consolidated home.
- `bugs.url` updated to the consolidated repo's issue tracker.

No functional changes. Tool surface, server instructions, skills, and dependencies all identical to 1.1.1.

## [1.1.1] - 2026-05-17

### Changed

- Update server instructions, README, and `phototology:check-credits` skill to reflect the pricing v1 launch: 5,000-credit signup ladder (1,000 for verifying an email + 4,000 for adding a card-on-file) replaces the prior 1,000/month community grant. Pack table ($10 / $100 / $1,000 for 1,000 / 10,000 / 100,000 credits), $/credit, and the first-purchase 2x bonus are unchanged. `buildServerInstructions` is now exported for testability.

## [1.1.0] - 2026-05-17

### Added

- `get_credits` tool. Free. Reads the dual-pool balance (`community.balance + purchased.balance - reserved`) via the SDK's new `client.usage()` method. Use before any analyze loop to warn the user before spending.
- `purchase_credits` tool. Free. Returns a deep-link to the Phototology wallet with `utm_source=mcp`. The tool description teaches the new pack catalog and the first-purchase 2x bonus.
- `analyze_batch` tool. Analyze 1 to 200 INDEPENDENT photos in a single call. Internally bulk-looks-up against the registry (chunked into 50s, free), serves cache hits at 0 credits, runs per-photo analyze with bounded concurrency (5 in flight) for the misses. Returns per-photo outcomes plus `totalCacheHits`, `totalAnalyzed`, `totalCreditsCharged`, and `estimatedCreditsSaved` so the registry's value is visible. For thousands of photos, the agent loops the tool in slices of 200.
- Structured `actions` payload on `CreditExhaustedError`. Rich-rendering MCP clients (Claude Code, Cursor, future Claude.ai) now receive a typed `open_url` action alongside the text fallback. Built against MCP spec 2025-11-25. Legacy clients keep seeing the URL in the text.
- Five companion skills shipped under `node_modules/@phototology/mcp/skills/`:
  - `phototology:lookup-first`: always check the registry before spending credits (single photo).
  - `phototology:check-credits`: pre-flight balance read before a big batch.
  - `phototology:smart-stack`: smart-pick the cheapest lens subset for a specific question.
  - `phototology:photo-shared`: when the user attaches, drops, or references an image, route it through Phototology for the cheapest accurate answer.
  - `phototology:batch-analyze`: any job with 2 or more photos. Uses `analyze_batch` (not a loop of `analyze_photo`). Documents the loop pattern for thousand-photo jobs.
- Optional Claude Code `UserPromptSubmit` hook documented in the README: auto-trigger Phototology suggestions when the user attaches an image.
- Explicit tool annotations on every tool: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint` (true for outward calls, false for `list_lenses`).
- Dogfood kit at `scripts/dogfood/`: a 50-line mock server that returns 402 on `/v1/analyze`, plus a 5-minute walkthrough for verifying the structured-action rendering in a real Claude Code session.

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

## [1.0.1] - 2026-04-17

- Initial public release of the stdio MCP server wrapping `@phototology/sdk`.
- Three tools: `analyze_photo`, `list_modules`, `lookup_photo`.
- Interactive setup wizard for 6 editors.
- Test sandbox via `pt_test_` keys.
- `lookup_photo` returns the Registry v2 shape (`photo.lenses` keyed map).
- `analyze_photo` accepts `refresh?: boolean` to bypass the projection cache.
