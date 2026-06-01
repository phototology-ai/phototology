# @phototology/sdk Changelog

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
