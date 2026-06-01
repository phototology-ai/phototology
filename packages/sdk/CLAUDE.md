# @phototology/sdk Development Protocol
> **Version:** 1.0.2 | **Architecture:** Typed fetch wrapper, exponential backoff, CommonJS | **Updated:** 2026-05-17

## What This Is

Public TypeScript SDK for the Phototology AI vision API. Consumed by external developers and by `@phototology/mcp`. This is NOT a monorepo-internal package — it is published to npm and must be self-contained.

## Quick Start

| Command | Action |
|---------|--------|
| `pnpm build` | Compile to `dist/` |
| `pnpm typecheck` | Type-check without emit |
| `pnpm test` | Run Jest tests |
| `node bin/init.js` | Interactive project scaffold CLI |

## Known State Issues

### Consumers need a built `dist/` after fresh checkout

The SDK ships `dist/` from `pnpm build`, not from source — `dist/` is git-ignored. Consumers (DrVin, phototology-mcp, phototology-web) typecheck against the emitted `.d.ts` files. After a fresh worktree checkout or `git clean -xfd`, run:

```bash
pnpm --filter @phototology/core build && pnpm --filter @phototology/sdk build
```

Otherwise the consumer's `tsc --noEmit` emits TS2307 (`Cannot find module '@phototology/sdk'`) and TS7006 (`Parameter implicitly has an 'any' type`) at every SDK import site. These look identical to genuine type-debt but are environmental — don't reach for narrowing fixes until the build has run. Memory entry: `feedback_pnpm_build_sdk_after_checkout.md`.

---

## Architecture

Single class (`PhototologyClient`) wraps five API endpoints:

- `client.analyze(request)` — POST `/v1/analyze` (or `/v2/analyze` when `request.extract` is set), returns discriminated union `AnalyzeResponse`
- `client.modules()` — GET `/v1/modules`, returns modules/presets discovery
- `client.lookup(request)` — POST `/v2/lookup` (or GET fast-path with `sha256`/`pHash`), returns the registry projection. Free.
- `client.usage()` — GET `/v1/usage`, returns the dual-pool credit balance (`community`, `purchased`, `reserved`, `resetsInDays`). Free. Added in 1.0.2 (2026-05-17); strictly additive — no existing method signatures change.
- `client.enrich(request)` — POST `/v2/enrich`, writes cached lens output into the photo's EXIF/IPTC/XMP metadata and returns the enriched bytes. Requires a prior `analyze()` on the same photo (else throws `ValidationError` with `PHOTO_NOT_IN_REGISTRY`). Costs 5 credits per call.

Retry logic lives in `retry.ts` (`fetchWithRetry`), called by the private `request()` method. The client tracks rate limit state in-memory via `x-ratelimit-remaining`/`x-ratelimit-reset` headers and pre-emptively backs off before the next request.

## Key Conventions

**Error classes:** This package defines its own error hierarchy rooted at `PhototologyError`. Do NOT use `AppError` from `@phototology/shared` — the SDK has no monorepo dependencies and must be standalone. Error subclasses: `AuthenticationError`, `ValidationError`, `RateLimitedError`, `ParseError`, `InternalError`, `ProviderError`, `PlanLimitError`, and `CreditExhaustedError` (extends `PlanLimitError`; the richer 402 `PLAN_LIMIT_EXCEEDED` subtype carrying credit-pool detail + purchase URL). All are constructed via `PhototologyError.fromResponse()`.

**API key redaction:** Every error message passes through `redactApiKeys()` before being set on the `Error` instance. The regex matches `pt_(live|test)_*` — never logs or surfaces raw keys.

**Retry behavior:** Exponential backoff (500ms, 1s, 2s, 4s, capped at 8s). Respects `Retry-After` header exactly. Non-retryable errors throw immediately (no backoff). Default: 3 retries, 60s timeout.

**API key resolution:** Constructor reads `config.apiKey` first, falls back to `PHOTOTOLOGY_API_KEY` env var. Throws `PhototologyError` with `code: 'CONFIG_ERROR'` if neither is present.

**Output discriminated union:** `AnalyzeResponse` is `PhotoAnalyzeResponse | VehicleAnalyzeResponse`. Narrow on `result.outputSchema === 'vehicle'` before accessing vehicle-specific fields. `PhotoOutput` and `VehicleOutput` are opaque `Record<string, unknown>` — field availability depends on which modules were used.

**`bin/init.js` CLI:** Reads `PHOTOTOLOGY_API_KEY` from env or prompts interactively. Writes `.env` and `analyze-example.ts` into `cwd()`. Entry module is `src/init.ts`; the bin shim is `bin/init.js`.

**No named exports from `@phototology/shared`:** Zero monorepo dependencies. No `AppError`, no `Result`, no Drizzle.

**CommonJS only:** `"module": "CommonJS"` in tsconfig. No `.js` extensions on relative imports. No `"type": "module"` in package.json.

## Phantom Patterns

| Pattern | Reality |
|---------|---------|
| `AppError`, `Result` | Not present — SDK uses its own `PhototologyError` hierarchy |
| `client.query()`, `client.embed()` | Only `analyze()`, `modules()`, `lookup()`, `usage()`, and `enrich()` exist |
| `PhototologyClient.create()` factory | Use `new PhototologyClient(config?)` |
| Default export | Named exports only — `import { PhototologyClient } from '@phototology/sdk'` |
| `outputSchema: 'photo'` as default assumption | Always check the discriminant before reading output fields |
