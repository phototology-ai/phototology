import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type PhototologyClient, LENS_FIELDS, PRESET_IDS, type LensId } from '@phototology/sdk';
import { renderToolError } from './errors';
import { readImage, expandGlobs, validateBase64, LocalImageError } from '../lib/local-image';

const LENS_IDS = Object.keys(LENS_FIELDS) as [LensId, ...LensId[]];

/** Hard cap per tool call. For larger jobs, the agent loops the tool. */
const MAX_BATCH = 200;
/**
 * Concurrent analyze calls in flight.
 *
 * Bounded to the API's per-user /analyze concurrency cap (`CONCURRENCY_CAP = 5`
 * in phototology-api/src/middleware/concurrencyLimiter.ts). The flat 600 RPM
 * rate limit is NOT the binding constraint — the 5-in-flight cap is, and it's a
 * separate limiter. Firing more than 5 at once returns 429
 * CONCURRENCY_LIMIT_EXCEEDED; the SDK retries (Retry-After: 5s), but on a large
 * batch the retry budget exhausts before in-flight vision calls (~10-20s each)
 * free a slot, so requests fail instead of queueing. We bound client-side here
 * so the (N+1)th photo waits for a slot rather than sending a doomed request.
 * Keep this <= the server cap; raise both together if the cap is ever lifted.
 */
const ANALYZE_CONCURRENCY = 5;
/** Concurrent lookup calls in flight (free, cheap, generous). */
const LOOKUP_CONCURRENCY = 20;

const BatchInputSchema = {
  imageUrls: z.array(z.string().url()).min(1).max(MAX_BATCH).optional()
    .describe(`List of independent, publicly fetchable image URLs to analyze separately (each photo gets its own output). 1 to ${MAX_BATCH} per call. For thousands of photos, loop this tool in slices of ${MAX_BATCH}.`),
  imagePaths: z.array(z.string()).optional()
    .describe('Array of local paths or glob patterns (e.g. ["~/vacation/*.jpg", "/Users/me/headshot.png"]) on the machine running the MCP server. Each entry can be a literal path or a glob; globs are expanded internally. Combined-with-URLs total cap is 200. NOT for paths inside an agent sandbox (e.g. Claude\'s /mnt/user-data/uploads/...) — that sandbox is invisible to a locally-installed MCP; use imagesBase64 (small) or imageUrls (hostable) for those.'),
  imagesBase64: z.array(z.string()).optional()
    .describe('Array of base64-encoded image bytes. Each entry should be under ~150KB JPEG / ~200K base64 chars; LLM-driven clients exhaust output-token budget on large base64 payloads. For larger files use imagePaths or imageUrls instead.'),
  lenses: z.array(z.enum(LENS_IDS)).optional()
    .describe('Explicit list of lenses to run on every photo. Prefer this for cheap, targeted batches. Call `list_lenses` for descriptions. Either `lenses` or `stack` must be provided.'),
  stack: z.enum([...PRESET_IDS] as [string, ...string[]]).optional()
    .describe('Named bundle of lenses to run on every photo. Different stacks contain very different numbers of lenses: `memorial` runs ~15 lenses (~15 credits per uncached photo); `automobile` runs ~3. Call `list_lenses` to see exact stack contents and per-photo cost before committing to a stack on a large batch. Ignored when `lenses` is provided.'),
  refresh: z.boolean().optional()
    .describe('Bypass the registry lookup and re-run every lens on every photo. Default false: lookup-first, only analyze cache misses. Pass true only when the user explicitly asks to re-analyze.'),
};

interface BatchArgs {
  imageUrls?: string[];
  imagePaths?: string[];
  imagesBase64?: string[];
  lenses?: LensId[];
  stack?: string;
  refresh?: boolean;
}

/**
 * Normalized per-photo input. URL inputs are lookup-first eligible; base64
 * inputs (from imagePaths or imagesBase64) skip the lookup step in v1.2.0 —
 * cache-check for local files would require running the sha256-then-pHash
 * cascade (T4's logic) per photo, which is meaningful additional complexity.
 * v1.3.0 can add local-file cache-first if usage warrants.
 */
type PhotoInput =
  | { kind: 'url'; value: string; label: string }
  | { kind: 'base64'; value: string; label: string; sourcePath?: string };

interface PhotoOutcome {
  /** Original identifier the caller submitted (URL, absolute path, or "base64[i]"). */
  input: string;
  /** Echoed URL if the input was a URL — preserves the historical key for URL callers. */
  imageUrl?: string;
  /** Echoed absolute path if the input came from imagePaths. */
  imagePath?: string;
  sha256?: string;
  source: 'cache' | 'fresh' | 'error';
  output?: Record<string, unknown>;
  creditsCharged?: number;
  error?: string;
}

interface BatchPayload {
  totalSubmitted: number;
  totalCacheHits: number;
  totalAnalyzed: number;
  totalErrors: number;
  totalCreditsCharged: number;
  estimatedCreditsSaved: number;
  results: PhotoOutcome[];
}

/** Run an async map with bounded concurrency, preserving input order. */
async function mapBounded<T, U>(items: T[], limit: number, fn: (item: T, index: number) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) {
    workers.push((async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

/** Does the cached lens output already cover every requested lens? */
function cacheCovers(cached: Record<string, unknown> | undefined, requestedLenses: string[]): boolean {
  if (!cached) return false;
  for (const lens of requestedLenses) {
    if (!cached[lens]) return false;
  }
  return true;
}

export function registerAnalyzeBatch(server: McpServer, client: PhototologyClient): void {
  const s = server as any;

  s.registerTool(
    'analyze_batch',
    {
      description: [
        `Analyze 1 to ${MAX_BATCH} INDEPENDENT photos in a single tool call. Each photo is analyzed separately and gets its own output. Use this whenever the user has 2 or more photos to process.`,
        '',
        'If photos are on the local disk, pass `imagePaths` (each entry can be a literal path or a glob like `~/vacation/*.jpg`). If you have URLs, pass `imageUrls`. If you have base64 bytes, pass `imagesBase64`. Arrays combine freely. Total inputs capped at 200 per call.',
        '',
        `Hard cap per call: ${MAX_BATCH} photos across all input sources combined. For larger jobs, loop this tool in slices of ${MAX_BATCH}.`,
        '',
        'Internal flow (registry-aware, cost-optimized):',
        '  1. Per-URL lookup for URL inputs only, with bounded concurrency (20 in flight). Free. Local-file and base64 inputs skip lookup in v1.2.0 (sha256 cascade for local files is a v1.3.0 optimization).',
        '  2. For URL images whose cached lens output covers every requested lens, return from cache (0 credits charged for that photo).',
        '  3. For the rest, run per-photo analyze with bounded concurrency (5 in flight, matching the API per-user cap so large batches queue client-side instead of getting throttled).',
        '  4. Aggregate per-photo results.',
        '',
        'Returns `{ totalSubmitted, totalCacheHits, totalAnalyzed, totalErrors, totalCreditsCharged, estimatedCreditsSaved, results: [...] }`. Each `results[i]` echoes the original input identifier (`imageUrl` or `imagePath`), `source: "cache" | "fresh" | "error"`, the per-photo output, and creditsCharged for that one photo.',
        '',
        'Results carry an `input` field with the canonical label of each entry: the URL string for `imageUrls`, the file path for `imagePaths`, or `"base64[i]"` (where `i` is the array index) for `imagesBase64` entries. Use this to correlate results back to your submission.',
        '',
        'Cost: 1 credit per lens per non-cached photo. A 100-photo batch with `lenses: ["dating"]` and 80% cache hit rate costs 20 credits ($0.20). Surface `totalCreditsCharged` and `estimatedCreditsSaved` to the user so the value of the registry is visible.',
        '',
        'Provide either `lenses: [...]` (preferred for targeted batches) or `stack: "..."` (for bundled workflows). One is required.',
        '',
        'This tool is for INDEPENDENT photos (each its own subject). For multi-angle composite analysis of one subject (e.g., 8 angles of one vehicle), use `analyze_photo` with the existing multi-image API — the batch tool does not stitch.',
        '',
        'Errors on individual photos do NOT fail the whole batch — they appear as `source: "error"` entries in the results array. A global error (auth, rate limit, out-of-credits hitting on the first call) surfaces as a tool error.',
      ].join('\n'),
      inputSchema: BatchInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ imageUrls, imagePaths, imagesBase64, lenses, stack, refresh }: BatchArgs) => {
      if (!lenses && !stack) {
        return {
          content: [{ type: 'text' as const, text: 'Error: provide either `lenses: [...]` or `stack: "..."`. Call `list_lenses` to see available options.' }],
          isError: true as const,
        };
      }

      try {
        // Build the unified inputs[] array from all three sources.
        // imagePaths globs expand here (may throw GLOB_TOO_LARGE — a
        // structural error, propagated as a whole-batch failure).
        //
        // Per-file errors (FILE_NOT_FOUND, INVALID_BASE64, etc.) are
        // isolated: the bad input is pushed to preErrors[] as a
        // source:'error' PhotoOutcome and the rest of the batch
        // continues. This matches the URL-mode batch's per-photo
        // isolation in the analyze step.
        //
        // Memory note: file reads are eager (all bytes loaded into
        // inputs[] before any worker dequeues). Peak memory at MAX_BATCH
        // (200) × 10MB raw = ~4.7GB if every input is a maxed-out local
        // file. In practice agents stay well under this; if a real fleet
        // exercises larger batches, switch to lazy reads inside the
        // worker (tradeoff: slower detection of bad files since they
        // fail during analyze rather than upfront).
        const inputs: PhotoInput[] = [];
        const preErrors: PhotoOutcome[] = [];

        if (imageUrls) {
          for (const url of imageUrls) {
            inputs.push({ kind: 'url', value: url, label: url });
          }
        }

        if (imagePaths && imagePaths.length > 0) {
          // expandGlobs throwing GLOB_TOO_LARGE is structural, not per-file
          // — let it propagate to the outer catch.
          const expanded = expandGlobs(imagePaths);
          for (const abs of expanded) {
            try {
              const bytes = readImage(abs);
              inputs.push({
                kind: 'base64',
                value: bytes.toString('base64'),
                label: abs,
                sourcePath: abs,
              });
            } catch (err: unknown) {
              const message = err instanceof LocalImageError
                ? `${err.code}: ${err.message}`
                : (err as Error).message;
              preErrors.push({
                input: abs,
                imagePath: abs,
                source: 'error',
                error: message,
              });
            }
          }
        }

        if (imagesBase64) {
          for (let i = 0; i < imagesBase64.length; i++) {
            const b64 = imagesBase64[i];
            const label = `base64[${i}]`;
            try {
              validateBase64(b64);
              inputs.push({ kind: 'base64', value: b64, label });
            } catch (err: unknown) {
              const message = err instanceof LocalImageError
                ? `${err.code}: ${err.message}`
                : (err as Error).message;
              preErrors.push({
                input: label,
                source: 'error',
                error: message,
              });
            }
          }
        }

        // Only throw zero-input when literally nothing was submitted.
        // If preErrors.length > 0, the agent did submit inputs — they
        // were all bad — return a response with only error outcomes
        // rather than a structural zero-input failure.
        if (inputs.length === 0 && preErrors.length === 0) {
          throw new LocalImageError(
            'UNSUPPORTED_FORMAT',
            'analyze_batch requires at least one of imageUrls, imagePaths, imagesBase64.',
          );
        }

        if (inputs.length + preErrors.length > MAX_BATCH) {
          throw new LocalImageError(
            'GLOB_TOO_LARGE',
            `Total inputs (${inputs.length + preErrors.length}) exceed MAX_BATCH (${MAX_BATCH}). Split the call.`,
          );
        }

        // Seed outcomes preserving submission order. Echo `imageUrl` for URL
        // inputs (back-compat with v1.1.0 batch callers) and `imagePath` for
        // path-derived inputs.
        //
        // The `source: 'fresh'` value here is a sentinel — overwritten by the
        // analyze/lookup worker. If this leaks to consumers, it means the
        // worker failed silently (which would be a bug).
        const outcomes: PhotoOutcome[] = inputs.map((input) => {
          if (input.kind === 'url') {
            return { input: input.label, imageUrl: input.value, source: 'fresh' };
          }
          return {
            input: input.label,
            ...(input.sourcePath ? { imagePath: input.sourcePath } : {}),
            source: 'fresh',
          };
        });

        // Step 1: per-URL lookup with bounded concurrency.
        //
        // Why per-URL instead of batched: the API's bulk-lookup response is
        // keyed by sha256 and does NOT echo the source URL. Mapping URL ->
        // cache entry from a batched response requires trusting the API to
        // preserve input order in its result object — an invariant the
        // OpenAPI spec doesn't formally promise. Per-URL lookups give a
        // deterministic mapping (one input URL -> one result entry) at the
        // cost of N HTTP roundtrips. Lookups are free + fast (~3ms each);
        // at LOOKUP_CONCURRENCY=20, a 200-image lookup pass completes in
        // ~30ms wall time.
        //
        // Only URL-kind inputs participate in lookup. Base64 inputs (from
        // imagePaths or imagesBase64) skip lookup in v1.2.0.
        const urlInputs = inputs
          .map((input, idx) => ({ input, idx }))
          .filter((entry) => entry.input.kind === 'url');
        const urlToCache = new Map<string, { sha256: string; lensesOutput: Record<string, unknown> }>();
        const requestedLensList = lenses ?? null;

        if (!refresh && urlInputs.length > 0) {
          await mapBounded(urlInputs, LOOKUP_CONCURRENCY, async ({ input }) => {
            try {
              const url = input.value;
              const r = await client.lookup({ images: [url] });
              const entries = Object.entries(r.results ?? {});
              if (entries.length === 0) return;
              const [sha256, res] = entries[0];
              const lensesMap = res.photo?.lenses;
              if (!lensesMap) return;
              const flat: Record<string, unknown> = {};
              for (const [lensName, lensEntry] of Object.entries(lensesMap)) {
                flat[lensName] = lensEntry.output;
              }
              urlToCache.set(url, { sha256, lensesOutput: flat });
            } catch {
              // Single-URL lookup failures are non-fatal: we'll fall
              // through to analyze for that one URL.
            }
          });
        }

        // Step 2: identify cache hits, mark misses for analysis.
        const needsAnalysis: Array<{ input: PhotoInput; idx: number }> = [];
        if (!refresh && requestedLensList) {
          inputs.forEach((input, idx) => {
            if (input.kind !== 'url') {
              needsAnalysis.push({ input, idx });
              return;
            }
            const cached = urlToCache.get(input.value);
            if (cached && cacheCovers(cached.lensesOutput, requestedLensList)) {
              outcomes[idx] = {
                input: input.label,
                imageUrl: input.value,
                sha256: cached.sha256,
                source: 'cache',
                output: Object.fromEntries(requestedLensList.map((l) => [l, cached.lensesOutput[l]])),
                creditsCharged: 0,
              };
            } else {
              needsAnalysis.push({ input, idx });
            }
          });
        } else {
          // refresh=true OR stack-mode (we cannot pre-validate stack coverage
          // without expanding the stack -> lenses map client-side).
          inputs.forEach((input, idx) => needsAnalysis.push({ input, idx }));
        }

        // Step 3: per-photo analyze with bounded concurrency. Each input
        // contributes one POST /v1/analyze call: URL inputs forward `imageUrl`,
        // base64 inputs forward `imageBase64`.
        await mapBounded(needsAnalysis, ANALYZE_CONCURRENCY, async ({ input, idx }) => {
          try {
            const inputArg = input.kind === 'url'
              ? { imageUrl: input.value }
              : { imageBase64: input.value };
            const result = await client.analyze({
              ...inputArg,
              ...(lenses ? { modules: lenses } : { preset: stack }),
              ...(refresh !== undefined ? { refresh } : {}),
            });
            outcomes[idx] = {
              input: input.label,
              ...(input.kind === 'url' ? { imageUrl: input.value } : {}),
              ...(input.kind === 'base64' && input.sourcePath ? { imagePath: input.sourcePath } : {}),
              source: 'fresh',
              output: result.output as Record<string, unknown>,
              creditsCharged: result.usage?.creditsCharged ?? 0,
            };
          } catch (err: unknown) {
            outcomes[idx] = {
              input: input.label,
              ...(input.kind === 'url' ? { imageUrl: input.value } : {}),
              ...(input.kind === 'base64' && input.sourcePath ? { imagePath: input.sourcePath } : {}),
              source: 'error',
              error: err instanceof Error ? err.message : String(err),
            };
          }
        });

        // Merge pre-validation errors (FILE_NOT_FOUND, INVALID_BASE64, etc.)
        // with the analyze/lookup outcomes. preErrors precede the analyzed
        // outcomes; this keeps the API contract that every submitted input
        // is represented in results[], even the bad ones.
        const allOutcomes: PhotoOutcome[] = [...preErrors, ...outcomes];

        const totalCacheHits = allOutcomes.filter((o) => o.source === 'cache').length;
        const totalAnalyzed = allOutcomes.filter((o) => o.source === 'fresh').length;
        const totalErrors = allOutcomes.filter((o) => o.source === 'error').length;
        const totalCreditsCharged = allOutcomes.reduce((sum, o) => sum + (o.creditsCharged ?? 0), 0);
        const lensCount = (lenses ?? []).length || 1;
        const estimatedCreditsSaved = totalCacheHits * lensCount;

        const payload: BatchPayload = {
          // Includes pre-validation errors so the count reflects everything
          // the agent submitted, not just the inputs that survived to analyze.
          totalSubmitted: inputs.length + preErrors.length,
          totalCacheHits,
          totalAnalyzed,
          totalErrors,
          totalCreditsCharged,
          estimatedCreditsSaved,
          results: allOutcomes,
        };

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload as unknown as Record<string, unknown>,
        };
      } catch (err: unknown) {
        return renderToolError(err);
      }
    },
  );
}
