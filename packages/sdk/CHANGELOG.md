# @phototology/sdk Changelog

## 1.3.0 (2026-06-02)

### Changed
- **Request timeouts are now bounded end-to-end.** The per-attempt `timeout` default drops from 60s to **30s**, and a new **`maxElapsedMs`** option (default **90s**) caps total wall-clock time across all attempts + backoffs. Previously a stalled upstream could hang a single call for `(maxRetries + 1) × timeout` ≈ 4 minutes; now each attempt's timeout and every backoff are clamped to the remaining budget. Set `maxElapsedMs: 0` for unbounded (legacy) behavior.

## 1.2.0 (2026-06-01)

First coordinated 1.2.0 cut with `@phototology/mcp`. Adds the `enrich()` method, a top-level `livemode` discriminant, a single-number `total` credit balance, richer `/v1/modules` discovery fields, and removes the `estimatedCostUsd` margin leak (see Breaking Changes). No retry, auth, or constructor behavior changes.

### Added

- **`client.enrich(request): Promise<EnrichResponse>`** — POST `/v2/enrich`. Writes a photo's already-cached lens output into its EXIF/IPTC/XMP metadata and returns the enriched bytes (base64), so the intelligence travels with the file. Costs 5 credits per call and bills regardless of cache state. Requires a prior `analyze()` on the same photo, otherwise throws `ValidationError` with code `PHOTO_NOT_IN_REGISTRY`. `formats: ['c2pa']` is rejected (C2PA signing is deferred). New exported types: `EnrichRequest`, `EnrichResponse`.
- **Top-level `livemode: boolean` on every analyze response** (`AnalyzeResponseBase`). `true` for a `pt_live_` key (real model run); `false` for a `pt_test_` sandbox key (deterministic golden-fixture data, no provider call, 0 credits). Branch on `livemode`, not on `meta.provider`. `/v2/lookup` and `/v2/enrich` intentionally omit `livemode` (no sandbox duality).
- **`UsageResponse.total: number`** — the spendable credit balance, the single number to show. `community` and `purchased` remain for internal refund-to-origin accounting; they are not two balances the holder manages.
- **`ErrorCredits.total: number`** on 402 `PLAN_LIMIT_EXCEEDED` credit payloads. The 402 message now leads with `total` instead of the old `(community: X, purchased: Y)` parenthetical.
- **`LookupResult.computedHashes?: { sha256, pHash, dHash }`** — present when the lookup supplied image bytes (POST `/v2/lookup`); absent on the GET hash fast-path. Strictly additive. (Carried over from the never-published 1.1.3 intermediate; see Versioning note.)
- **`ModuleInfo` discovery fields:** `billable: boolean`, `defaultColumns: LensColumn[]`, and `internal?: true`, plus a new exported `LensColumn` type. Drives runtime discovery and the photo-to-spreadsheet projection. Mirrors the new `/v1/modules` response shape.

### Changed

- **`meta.ai_generated` widened to `boolean`** (was the literal `true`, JSDoc "always true"). The `pt_test_` sandbox now emits `false` (no model ran); every real run emits `true`. The SDK type and JSDoc are updated to match the wire. (Enrich responses keep `ai_generated: true` literal, since enrich never runs in the sandbox.)
- **`UsageResponse` JSDoc rewritten:** `total` is the number to show; the `community`/`purchased` split is internal refund accounting; `monthlyAllowance` and `resetsInDays` are flagged legacy and report 0 once the pricing v1 cutoff (2026-05-18) has bound the account.
- **`SDK_VERSION` constant bumped to `1.2.0`** (`src/client.ts`), matching `package.json`. Was `1.1.2`, which made the `User-Agent` header report a stale version to the API and to PostHog (`user_agent_short`). The constant is now in lockstep with the package version.

### Breaking Changes

- **Removed `AnalyzeUsage.estimatedCostUsd`** from the TypeScript interface and from every analyze-endpoint wire response. The field was the raw server-side provider cost; the ratio between it and `creditsCharged` exposed per-lens markup math to anyone reading the response, and "server cost" was never the same thing as "what the customer paid." Migration: if you statically referenced `result.usage.estimatedCostUsd`, remove it and use `result.usage.creditsCharged` for cost-to-customer in billing UIs. Cost is still computed server-side for internal audit. The bundled quickstart scaffold (`src/init.ts`) now logs `creditsCharged` instead.

### Fixed

- **`LensColumn.format` now includes `'count'`** (was `'string' | 'number' | 'date' | 'percentage' | 'tags' | 'hex'`). The API emits `format: 'count'` on count columns (for example `condition.observation_count`); the union now matches the wire.

> **Versioning note (1.1.3 was never published).** `package.json` briefly carried `1.1.3` for an in-tree intermediate (the `computedHashes` addition above) that was never published to npm; the last published release was `1.1.2`. Rather than publish a back-dated 1.1.3, that change is folded into this 1.2.0 release. npm goes directly `1.1.2 -> 1.2.0`.
>
> The `estimatedCostUsd` removal is a breaking type change; strict SemVer would call for a major bump. The field was an unintended internal-observability leak with no business meaning to TypeScript callers, and the coordinated release target is 1.2.0. The Breaking Changes callout above carries the disclosure.

## 1.1.2 (2026-05-19)

### Security

- **Scaffolder writes `.env` with `mode: 0o600`** (`src/init.ts:scaffold`). The file contains `PHOTOTOLOGY_API_KEY=pt_live_...`. Pre-fix permissions defaulted to the user's umask (typically `0o644` — world-readable). On shared dev machines or cloud IDEs (Codespaces, Gitpod), the key was readable by any other user on the box. Closes Audit #5 HIGH (2026-05-19).

### Fixed

- **Scaffolder example URL no longer 400s** (`src/init.ts:EXAMPLE_TEMPLATE`). Changed from `upload.wikimedia.org/wikipedia/commons/thumb/.../Golde33443.jpg` (which Wikimedia's CDN rejects for non-browser UAs, so every cold `npx @phototology/sdk` install got `IMAGE_FETCH_FAILED` on the first analyze call) to `images.unsplash.com/photo-1506905925346-21bda4d32df4` (responds 200 to a generic UA). Closes Task 2 P0-2 (2026-05-19).

### Changed

- **npm `description` field rewritten** to claim the differentiator (registry + composable lenses + structured JSON output) rather than the generic "TypeScript SDK for the Phototology AI vision API". Closes Audit #1 EC1 + Audit #2 AM-H1 (2026-05-19).
- **npm `keywords` extended** with the differentiating terms (`registry`, `photo-registry`, `perceptual-hash`, `visual-memory`, `cache-hits`, `delta-billing`, `analyze-once`, `exif-metadata`) so npm search + LLM-readable surfaces surface the actual moat. Closes Audit #1 EC2 + Audit #2 AM-H2 (2026-05-19).
- **Copy-consistency cleanup.**
  - README hero rewritten: dropped the "harness for visual intelligence" framing and the secondary "Analyze once. Remember forever." line in favor of the canonical tagline ("Persistent memory for visual intelligence.") + the package's specific role.
  - README pricing section: dropped the stale "1,000 community credits every month, free, no card required" claim. Replaced with the pricing v1 signup-grant wording (5,000 free credits at signup — 1,000 for verifying email + 4,000 for adding a card-on-file — one-time, not recurring).
  - README `client.usage()` field commentary updated to flag `monthlyAllowance` and `resetsInDays` as legacy fields that report 0 once the pricing v1 cutoff has bound the account.
  - `UsageResponse` JSDoc on `monthlyAllowance` / `resetsInDays` / `tier` rewritten to drop the "refills monthly" / "drives the monthly allowance" framing. The fields ship in the `.d.ts` to consumers, so the language now reflects post-cutoff reality.
  - `CreditExhaustedErrorOptions.communityBalance` JSDoc dropped the "(monthly-reset)" parenthetical.
  - `client.usage()` JSDoc rewritten same way (no more "monthly free pool").
- **`SDK_VERSION` constant bumped.** Now reports `1.1.2` (matches `package.json`). Was `1.0.1` since 1.0.1 was published, which made the `User-Agent` header show a stale version to the API for every request from 1.0.2 / 1.1.0 / 1.1.1 callers. Observable as `user_agent_short` in PostHog.

No public method signatures change. Tests, types, retry behavior all identical to 1.1.1.

## 1.1.1 (2026-05-18)

Metadata-only patch. No code or API changes.

- `repository.url` switched to `github.com/phototology-ai/phototology` and `repository.directory: "packages/sdk"` added. Reflects the consolidated public repo (the SDK and MCP both previously shipped from separate single-package repos at `phototology-ai/phototology-sdk` and `phototology-ai/phototology-mcp`, both now archived). The npm package page's "Repository" link points directly to `packages/sdk/` in the consolidated home.
- `bugs.url` updated to the consolidated repo's issue tracker.

## 1.1.0 (2026-05-17)

### Added

- `client.usage()` — read the authenticated account's dual-pool credit balance (`community`, `purchased`, `reserved`, `resetsInDays`). Free, no credits billed. Used by the MCP `get_credits` tool. Strictly additive — no existing method signatures change.

## 1.0.1 (2026-04-17)

Metadata-only patch. No code or API changes.

- `repository.url`, `homepage`, `bugs.url` now point at the public standalone mirror at `github.com/phototology-ai/phototology-sdk` instead of the private monorepo. Fixes broken Homepage and Repository links on npm and Libraries.io, and lets source-browsing crawlers index the package.
- `SDK_VERSION` constant (User-Agent header) bumped to match `package.json`.

## 1.0.0 (2026-04-17)

Registry v2 ships. Photos are persistent per API key: the second call on the same image bills zero credits for lenses already run.

### Breaking Changes

- **`LookupResult.analyses[]` is gone.** Replaced by `LookupResult.photo?: PhotoRecord`. A photo is now a single record keyed by `sha256`, with `lenses: Record<string, LensIndexEntry>` — one entry per lens, updated in place on refresh. Historical runs are no longer returned. See the README migration section for before/after code.
- `AnalysisRecord` type removed. Use `LensIndexEntry` (per-lens) and `PhotoRecord` (per-photo) instead.

### Added

- `AnalyzeRequest.refresh?: boolean` — pass `true` to bypass the projection cache and force a fresh LLM run for every requested lens. Billed normally.
- `AnalyzeUsage.creditsCharged?: number` — credits billed on this specific call. Zero on a full registry cache hit.
- New exported types: `PhotoRecord`, `LensIndexEntry`, `LookupResponse`, `LookupResult`, `LookupRequest`.
- Vocabulary aligned with the Phototology brand rename: "lenses" everywhere (was "modules").

## 0.2.0 (2026-03-22)

### Breaking Changes

- **`PLAN_LIMIT_EXCEEDED` HTTP status changed from 403 to 402.** If your code checks `error.status === 403` for plan limits, update to `402` or use `error instanceof PlanLimitError`.
- **`ApiKeyTier` narrowed from 4 values to 2.** Only `'starter'` and `'growth'` tiers exist. The `'free'`, `'developer'`, and `'enterprise'` tiers are removed.

### Added

- `PlanLimitError` -- new error subclass for `PLAN_LIMIT_EXCEEDED` (HTTP 402). Thrown when a Starter tier user exceeds their free image quota.

## 0.1.1 (2026-03-21)

- Initial release
