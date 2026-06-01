# @phototology/sdk

**Persistent memory for visual intelligence.**

TypeScript SDK for the [Phototology API](https://api.phototology.com/v1/docs). The first call on a photo bills 1 credit per lens; subsequent calls on the same image return cached lens results for free.

[![npm version](https://img.shields.io/npm/v/@phototology/sdk)](https://www.npmjs.com/package/@phototology/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

## Migrating from 0.2.0 to 1.0.0

Registry v2 replaced the historical `analyses[]` array with a per-lens map on a single `PhotoRecord`. If you previously used `client.lookup()`:

```typescript
// 0.2.0 (old)
const result = lookupResponse.results[sha];
for (const analysis of result.analyses ?? []) {
  console.log(analysis.modulesUsed, analysis.output);
}

// 1.0.0 (new)
const result = lookupResponse.results[sha];
if (result.photo) {
  for (const [lensName, entry] of Object.entries(result.photo.lenses)) {
    console.log(lensName, entry.output, entry.version, entry.producedAt);
  }
}
```

A photo is now a single record keyed by sha256. Each lens produces one entry and is updated in place on refresh. See the `client.lookup()` reference below.

## Install

```bash
npm install @phototology/sdk
```

## Quick Start

```typescript
import { PhototologyClient } from '@phototology/sdk';

const client = new PhototologyClient({ apiKey: 'pt_live_...' });

const result = await client.analyze({
  imageUrl: 'https://example.com/photo.jpg',
  preset: 'full-analysis',
});

console.log(result.output);           // Structured analysis data
console.log(result.usage.totalTokens); // Token usage
```

## Scaffolding CLI

Get started instantly with zero configuration:

```bash
npx @phototology/sdk
```

This creates a `.env` file and a working `analyze-example.ts` script. Set `PHOTOTOLOGY_API_KEY` beforehand or paste it when prompted.

Keys starting with `pt_test_` use the test sandbox (instant responses, zero cost, deterministic fixtures). Detect a sandbox response at runtime with `result.livemode === false` (live runs are `true`) — the fixture payload is the same for every image, so never treat it as facts about a real photo.

## API Reference

### `client.analyze(request)`

Analyze one or more images with AI vision.

```typescript
const result = await client.analyze({
  // Image input (one of):
  imageUrl: 'https://example.com/photo.jpg',
  imageBase64: '...',           // or base64-encoded image
  images: [{ url: '...' }],    // or multiple images

  // Module selection (one of):
  preset: 'full-analysis',      // full-analysis | quick-scan | automobile | claims | property | ecommerce | memorial | vehicle-condition
  modules: ['dating', 'people', 'location'], // or explicit module list
  modulesAdd: ['entities'],    // add to preset
  modulesRemove: ['moderation'],  // remove from preset

  // Context
  context: {
    knownPeople: [{ name: 'Alice', birthYear: 1950 }],
    vehicle: { vin: '...', mileage: 45000 },
    customInstructions: 'Focus on architectural details',
  },

  // Options
  options: {
    includeEmbedding: true,     // 1408-dim vector for similarity search
    includeFingerprint: true,   // pHash, dHash, sha256
  },

  // Registry v2
  refresh: false,               // true = bypass projection cache, re-run LLM for every requested lens (billed normally)
});

result.id;                      // "ana_7f3a9c2e"
result.livemode;                // true on pt_live_, false on the pt_test_ sandbox
result.outputSchema;            // "photo" | "vehicle"
result.output;                  // Structured analysis data
result.usage.totalTokens;       // Token count
result.usage.estimatedCostUsd;  // Cost estimate
result.usage.creditsCharged;    // Credits billed on this call (0 on a full registry cache hit)
result.embedding;               // number[] (if requested)
result.fingerprint;             // { pHash, dHash, sha256 } (if requested)
result.warnings;                // string[]
result.meta.processingTimeMs;   // Processing time
```

#### Delta billing

Phototology keys each photo to your API key by perceptual hash. The second call on the same image bills zero credits for every lens that was already run. Only lenses that are new to this photo are sent to the LLM and counted. A full cache hit returns instantly with `usage.creditsCharged === 0`.

Pass `refresh: true` to force every requested lens to re-run. The call is billed normally.

### `client.lookup(request)`

Look up previously analyzed photos by fingerprint or image. Free, no credits charged.

```typescript
// Direct fingerprint lookup (GET fast path)
const byHash = await client.lookup({ sha256: 'e3b0c442...' });

// Or fuzzy lookup by pHash (Hamming distance)
const byPhash = await client.lookup({ pHash: 'fc1c149afbf4c899', threshold: 5 });

// Or submit one or more images (POST path)
const byImage = await client.lookup({
  images: ['https://example.com/photo.jpg'],
});

const record = byHash.results['e3b0c442...'];
record.matchType;             // 'exact' | 'fuzzy' | 'none'
record.hammingDistance;       // number (fuzzy matches only)
record.photo;                 // PhotoRecord — omitted on 'none'

if (record.photo) {
  record.photo.sha256;
  record.photo.firstAnalyzedAt;
  record.photo.lastAnalyzedAt;
  record.photo.totalCreditsSpent;
  record.photo.analyzeCallCount;
  record.photo.lenses;        // Record<string, LensIndexEntry>

  for (const [lens, entry] of Object.entries(record.photo.lenses)) {
    entry.output;             // Full lens output
    entry.version;            // Lens schema version
    entry.producedAt;         // When this lens last ran
    entry.coRunHash;          // Stable hash of the sibling-lens set at that run
    entry.provider;           // 'gemini' | 'openai' | 'anthropic'
  }
}
```

### `client.modules()`

List available lenses (individual analysis dimensions) and curated stacks (pre-bundled lenses for specific domains / use-cases).

```typescript
const { modules, presets } = await client.modules();

// modules:  lenses          [{ name, description, category, outputFields }]
// presets:  curated stacks  [{ name, description, modules }]
```

> **Naming note.** The concept words are **lens** (a single analysis dimension) and **stack** (a curated or custom bundle of lenses). On the wire, the request body and `client.modules()` response use the field names `modules` and `preset`/`presets` for backward compatibility with existing SDK callers. The MCP server exposes the same units to AI agents as `lenses` and `stacks`. Both naming conventions refer to the same units.

### `client.usage()`

Read the authenticated key's credit balance. Free, no credits charged. Call this before a batch of analyze calls to warn the user, pick a cheaper subset of lenses, or surface a purchase link before hitting the out-of-credits error.

```typescript
const usage = await client.usage();

usage.tier;                          // "starter" | "growth" | ...
usage.total;                         // Spendable credit balance — the number to show
usage.reserved;                      // Credits held against in-flight analyze calls

// Effective spendable after in-flight holds:
const spendable = usage.total - usage.reserved;

// The community / purchased breakdown is retained for back-compat (it powers
// refund-to-origin accounting); it is NOT two balances the holder manages.
usage.community.balance;             // Signup-grant landing pool (part of total)
usage.community.monthlyAllowance;    // Legacy field; 0 for accounts created post-cutoff
usage.community.referralBonus;       // Extra credits earned via referrals
usage.community.resetsInDays;        // Legacy field; 0 once the pricing v1 cutoff has bound the account
usage.purchased.balance;             // Pack-bought credits (part of total)
```

`total` added 2026-05-29 (credit-pools relabel). Strictly additive: the dual-pool fields remain, no method signatures change.

## Pricing

- **1 credit = $0.01 = one lens run on one photo.** Stack five lenses on a photo = 5 credits = $0.05.
- **5,000 free credits when you sign up.** 1,000 for verifying your email, 4,000 for adding a card-on-file. The card is never charged automatically. One-time, not recurring.
- **Lookups, lens discovery, balance reads, and purchase links are always free.**
- **Cache hits cost zero.** Re-running the same lens on the same photo returns the cached output for free.
- **Bespoke schema extraction = 5 credits per image** (plus 1 per additional stacked lens).
- **Moderation is free and always-on.** It is safety infrastructure, never billed.

### Credit packs (all at $0.01/credit, no volume discount)

| Pack | Credits | Price |
|------|---------|-------|
| Starter | 1,000 | $10 |
| Pro | 10,000 | $100 |
| Business | 100,000 | $1,000 |

**First purchase doubles.** Your first pack ever credits 2x. A Starter $10 buys 2,000 credits the first time. No subscriptions; pay-as-you-go via packs only.

## Error Handling

All API errors extend `PhototologyError` with typed subclasses for ergonomic catch patterns:

```typescript
import {
  PhototologyError,
  AuthenticationError,
  ValidationError,
  RateLimitedError,
  ParseError,
  InternalError,
  ProviderError,
} from '@phototology/sdk';

try {
  await client.analyze({ imageUrl: '...' });
} catch (err) {
  if (err instanceof RateLimitedError) {
    // 429 — retry after backoff
    console.log(`Rate limited. Retry after ${err.retryAfter}s`);
  } else if (err instanceof AuthenticationError) {
    // 401 — invalid or expired API key
    console.log('Check your API key');
  } else if (err instanceof ValidationError) {
    // 400 — bad input, invalid image, content filtered
    console.log(`Validation error: ${err.message}`);
  } else if (err instanceof ProviderError) {
    // 502 — upstream AI provider unavailable (retryable)
    console.log(`Provider issue: ${err.message}`);
  } else if (err instanceof ParseError) {
    // 500 — AI returned unparseable output (retryable)
    console.log(`Parse error: ${err.message}`);
  } else if (err instanceof InternalError) {
    // 500 — server error (not retryable)
    console.log(`Internal error: ${err.message}`);
  } else if (err instanceof PhototologyError) {
    // Base class catch-all
    console.log(`${err.code}: ${err.message} (retryable: ${err.retryable})`);
  }
}
```

Every error includes: `code` (string), `status` (HTTP status), `retryable` (boolean), `requestId` (string).

## Configuration

```typescript
const client = new PhototologyClient({
  apiKey: 'pt_live_...',       // Required (or set PHOTOTOLOGY_API_KEY env var)
  baseUrl: 'https://...',      // Default: https://api.phototology.com
  maxRetries: 3,               // Default: 3 (retries on retryable errors)
  timeout: 60_000,             // Default: 60s
});
```

### Self-Hosted

Point the SDK at your own Phototology API instance:

```typescript
const client = new PhototologyClient({
  apiKey: 'pt_live_...',
  baseUrl: 'https://your-instance.example.com',
});
```

## TypeScript

All types are exported:

```typescript
import type {
  AnalyzeRequest,
  AnalyzeResponse,
  PhotoAnalyzeResponse,
  VehicleAnalyzeResponse,
  ModulesResponse,
  LookupRequest,
  LookupResponse,
  LookupResult,
  PhotoRecord,
  LensIndexEntry,
  UsageResponse,
  PhototologyClientConfig,
} from '@phototology/sdk';
```

The response is a discriminated union on `outputSchema` — narrow with a type guard:

```typescript
if (result.outputSchema === 'photo') {
  // result is PhotoAnalyzeResponse
}
```

## Built-in Retry

The SDK automatically retries on retryable errors (429, 502, 500 with `PARSE_FAILED`) with exponential backoff. Rate limit headers (`x-ratelimit-remaining`, `x-ratelimit-reset`) are respected for pre-emptive backoff.

## Lens reference

Each lens owns a set of top-level output fields. Pick lenses explicitly via `modules: [...]` to bill only for what you need. Import the `LensId` type for compile-time safety:

```ts
import type { LensId } from '@phototology/sdk';
const lenses: LensId[] = ['dating', 'people', 'atmosphere'];
```

<!-- LENSES:START -->

| Lens | Owned output fields |
|------|---------------------|
| `dating` | `estimatedDate`, `techAnchors`, `temporalMarkers`, `title`, `genre`, `caption`, `dateAnchors`, `season`, `holiday`, `event`, `visibleDates`, `reproduction` |
| `people` | `physicalObservations`, `collectionDynamics`, `peopleCount` |
| `location` | `location` |
| `atmosphere` | `atmosphere`, `emotions`, `warmCaption`, `semanticDescription` |
| `entities` | `entities` |
| `accessibility` | `accessibility` |
| `photo-quality` | `quality`, `visualFaults`, `rotation`, `documentClassification`, `scan` |
| `text-content` | `textContent` |
| `composition` | `composition` |
| `moderation` | `moderation` |
| `describe` | `describe` |
| `condition` | `condition` |
| `authenticity` | `authenticity` |
| `color-palette` | `colorPalette` |
| `automobile` | `automobile` |
| `vehicle-condition` | `overallCondition`, `componentGrades`, `observations`, `accidentIndicators`, `photoQuality`, `missingViews`, `vehicleContext`, `photos`, `sellerSummary` |

<!-- LENSES:END -->

The registry is the source of truth. Runtime callers can also hit `client.modules()` to enumerate lenses + curated stacks with descriptions.

## Links

- [API Documentation](https://api.phototology.com/v1/docs)
- [OpenAPI Spec](https://api.phototology.com/v1/openapi.json)
- [MCP Server](https://www.npmjs.com/package/@phototology/mcp) — use Phototology from AI coding assistants
- [GitHub](https://github.com/phototology-ai/phototology-sdk)

## License

MIT
