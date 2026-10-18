import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type PhototologyClient, type LookupResult, PRESET_IDS, type LensId } from '@phototology/sdk';
import { SELECTABLE_LENS_IDS } from '../lib/lens-ids';
import { renderToolError } from './errors';
import { readLocalImage, expandGlobs, validateBase64, LocalImageError, assertNotHeic, detectBase64Format } from '../lib/local-image';
import {
  toAnalyzeEnvelope, photoResourceLink, photoResourceUri, usdFromCredits, billableLenses, outputLenses, analyzedPhotoSha256,
} from '../lib/envelope';
import { AnalyzeBatchOutputSchema, type AnalyzeBatchOutput, type AnalyzePhotoOutput } from '../schemas';

// Stack-only lenses (vehicle-condition) stay out of the selectable enum.
const LENS_IDS = SELECTABLE_LENS_IDS;

/** Hard cap per tool call. For larger jobs, the agent loops the tool. */
const MAX_BATCH = 200;
/**
 * Concurrent analyze calls in flight.
 *
 * Bounded to the API's per-user /analyze concurrency cap (`CONCURRENCY_CAP = 5`
 * in phototology-api/src/middleware/concurrencyLimiter.ts). The flat 600 RPM
 * rate limit is NOT the binding constraint; the 5-in-flight cap is, and it's a
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
    .describe('Array of local paths or glob patterns (e.g. ["~/vacation/*.jpg", "/Users/me/headshot.png"]) on the machine running the MCP server. Each entry can be a literal path or a glob; globs are expanded internally. Combined-with-URLs total cap is 200. NOT for paths inside an agent sandbox (e.g. Claude\'s /mnt/user-data/uploads/...); that sandbox is invisible to a locally-installed MCP; use imagesBase64 (small) or imageUrls (hostable) for those.'),
  imagesBase64: z.array(z.string()).optional()
    .describe('Array of base64-encoded image bytes. Each entry should be under ~150KB JPEG / ~200K base64 chars; LLM-driven clients exhaust output-token budget on large base64 payloads. For larger files use imagePaths or imageUrls instead.'),
  lenses: z.array(z.enum(LENS_IDS)).optional()
    .describe('Explicit list of lenses to run on every photo. Prefer this for cheap, targeted batches. Call `list_lenses` for descriptions. Either `lenses` or `stack` must be provided.'),
  stack: z.enum([...PRESET_IDS] as [string, ...string[]]).optional()
    .describe('Named bundle of lenses to run on every photo. Stacks differ widely in size and price. Call `list_lenses` for each stack\'s lenses, its `credits` and its `usdPerPhoto` before committing to a stack on a large batch. Ignored when `lenses` is provided.'),
  refresh: z.boolean().optional()
    .describe('Bypass the registry lookup and re-run every lens on every photo. Default false: lookup-first, only analyze cache misses. Pass true only when the user explicitly asks to re-analyze.'),
  dryRun: z.boolean().optional()
    .describe('Run the free registry lookup only and report what is already known and what the rest would cost. Nothing is analyzed and nothing is charged. Default false.'),
};

interface BatchArgs {
  imageUrls?: string[];
  imagePaths?: string[];
  imagesBase64?: string[];
  lenses?: LensId[];
  stack?: string;
  refresh?: boolean;
  dryRun?: boolean;
}

/**
 * Normalized per-photo input. `label` is what the caller submitted (URL,
 * absolute path, or "base64[i]") and comes back as the row's `input`. Base64
 * inputs (from imagePaths or imagesBase64) are looked up only on a dry run.
 */
type PhotoInput =
  | { kind: 'url'; value: string; label: string }
  | { kind: 'base64'; value: string; label: string; resolvedPath?: string };

/** One row of `results[]`: an analyze envelope, an inline error, or a dry-run row. */
type BatchRow = AnalyzeBatchOutput['results'][number];
type PhotoRow = AnalyzePhotoOutput & { input: string };
type ErrorRow = { input: string; error: { code: string; message: string } };

/** What the free lookup pass learned about one input. */
interface Known {
  matchType: 'exact' | 'pixels' | 'pdq' | 'fuzzy' | 'none';
  /** Registry record for a hit; absent on 'none'. */
  photo?: NonNullable<LookupResult['photo']>;
  /** The matched photo's stored receipts, as the lookup returned them. */
  receipts?: LookupResult['receipts'];
  /** The lookup's content credentials report, when it sent one. */
  credentials?: LookupResult['credentials'];
}

/**
 * Envelope for a photo served whole from the registry: nothing billed, every
 * requested billable lens counted as saved. Registry entries are written only
 * by live analyses (the `pt_test_` sandbox never writes one), so the output is
 * real model output and `livemode` is true. `matchType` says how the lookup
 * matched: on anything but 'exact', `photo` is the matched record, not the input.
 * `receipts` and `credentials` are the ones the lookup returned for that photo.
 */
function registryRow(
  input: string,
  known: Known & { photo: NonNullable<LookupResult['photo']> },
  lenses: string[],
): PhotoRow {
  const { matchType, photo } = known;
  const output: Record<string, unknown> = {};
  for (const lens of lenses) Object.assign(output, photo.lenses[lens]?.output ?? {});
  const creditsSaved = billableLenses(lenses).length;
  return {
    input,
    matchType,
    photo: { sha256: photo.sha256, pHash: photo.pHash, dHash: photo.dHash },
    output,
    lenses,
    usage: {
      creditsCharged: 0,
      creditsSaved,
      usd: { charged: usdFromCredits(0), saved: usdFromCredits(creditsSaved) },
      modulesUsed: lenses,
    },
    cacheHit: true,
    receipts: Array.isArray(known.receipts) ? [...known.receipts] : [],
    // Spread: the SDK interface has no index signature, the open envelope object does.
    ...(known.credentials !== undefined ? { credentials: { ...known.credentials } } : {}),
    resource: photoResourceUri(photo.sha256),
    livemode: true,
  };
}

/** One-line estimate shown to the agent alongside the JSON. */
function estimateLine(e: AnalyzeBatchOutput['summary']['estimate'], dryRun: boolean): string {
  const line = e
    ? `Estimate: ${e.photos} photos, ${e.cacheHits} already in the registry, ${e.creditsNeeded} credits needed ($${e.usd}).`
    : 'Estimate unavailable: the lens catalog could not be read, so the stack could not be priced.';
  return dryRun ? `${line} Dry run: nothing was analyzed or charged.` : line;
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

/** A row's `error.code` for a failure that carries no code of its own. */
function errorRow(input: string, err: unknown, fallbackCode: string): ErrorRow {
  const code = (err as { code?: unknown })?.code;
  return {
    input,
    error: { code: typeof code === 'string' ? code : fallbackCode, message: err instanceof Error ? err.message : String(err) },
  };
}

/**
 * The lenses a curated stack runs, read from the free lens catalog. Null when
 * the catalog cannot be read: the batch still runs, unpriced. A stack the
 * catalog does not list is a request error.
 */
async function stackLenses(client: PhototologyClient, stack: string): Promise<string[] | null> {
  let catalog: Awaited<ReturnType<PhototologyClient['modules']>>;
  try {
    catalog = await client.modules();
  } catch {
    return null;
  }
  const preset = catalog.presets.find((p) => p.name === stack);
  if (!preset) {
    throw new Error(`Stack "${stack}" is not in the lens catalog. Call list_lenses to see the available stacks.`);
  }
  return preset.modules;
}

export function registerAnalyzeBatch(server: McpServer, client: PhototologyClient): void {
  const s = server as any;

  s.registerTool(
    'analyze_batch',
    {
      title: 'Analyze a batch of photos',
      description: [
        `Analyze 1 to ${MAX_BATCH} INDEPENDENT photos in a single tool call. Each photo is analyzed separately and gets its own output. Use this whenever the user has 2 or more photos to process.`,
        '',
        'If photos are on the local disk, pass `imagePaths` (each entry can be a literal path or a glob like `~/vacation/*.jpg`). If you have URLs, pass `imageUrls`. If you have base64 bytes, pass `imagesBase64`. Arrays combine freely. Total inputs capped at 200 per call.',
        '',
        `Hard cap per call: ${MAX_BATCH} photos across all input sources combined. For larger jobs, loop this tool in slices of ${MAX_BATCH}.`,
        '',
        'Internal flow (registry-aware, cost-optimized):',
        '  1. Per-URL lookup for URL inputs, with bounded concurrency (20 in flight). Free. Local-file and base64 inputs skip this step; the server still bills them only for lenses it has not already run on those bytes.',
        '  2. Estimate, fixed before anything is analyzed: how many photos, how many the registry already covers, and the credits the rest need (each missing billable lens on each photo, $0.01 per credit). Local-file and base64 inputs were not looked up, so on a real run the estimate counts every lens on them as missing: an upper bound. A dry run looks them up, so its estimate is exact.',
        '  3. URL photos whose cached output covers every requested lens come back from the registry at 0 credits.',
        '  4. The rest run through analyze with bounded concurrency (5 in flight, matching the API per-user cap so large batches queue client-side instead of getting throttled).',
        '',
        'Pass `dryRun: true` to see which photos the registry already knows and what the rest would cost, without spending. A dry run also looks up local-file and base64 inputs, and each of its results is `{ input, matchType, cachedLenses, missingLenses, resource? }`. With `refresh: true` a dry run still looks every photo up, so each row keeps its real `matchType` and lens lists, but the estimate prices every lens on every photo, because a refresh re-runs them all.',
        '',
        'Returns `{ summary, results }`. `summary` holds `photos`, `cacheHits`, `analyzed`, `errors`, `creditsCharged`, `creditsSaved`, `usd: { charged, saved }`, `estimate: { photos, cacheHits, creditsNeeded, usd }` and `warnings?`. When a `stack` cannot be priced because the lens catalog is unreachable, the batch still runs: `estimate` is null and `warnings` holds `ESTIMATE_UNAVAILABLE`. Each `results[i]` is the `analyze_photo` result for one photo plus `input`, or `{ input, error: { code, message } }` for a photo that failed. `input` is the URL for `imageUrls`, the file path for `imagePaths`, or `"base64[i]"` (where `i` is the array index) for `imagesBase64`. A row served from the registry also carries `matchType`; on anything but `exact`, its `photo` is the registry record that matched, not the submitted image. Each named photo also comes back as a resource link to its registry record (a `pt_test_` result for a URL has no name and no link). An analyzed row\'s `receipts` may be empty; its `warnings` then names why (`RECEIPT_UNAVAILABLE`, `RECEIPT_NONE_STORED`, or a `RECEIPT_NOT_ISSUED_*` code). A row served from the registry carries the stored receipts the lookup returned for that photo, with no receipt warning; an empty list there means no stored receipt covers it.',
        '',
        'Cost: 1 credit per billable lens per non-cached photo. A 100-photo batch with `lenses: ["dating"]` and 80% cache hit rate costs 20 credits ($0.20). Surface `summary.usd.charged` and `summary.usd.saved` to the user so the value of the registry is visible.',
        '',
        'Provide either `lenses: [...]` (preferred for targeted batches) or `stack: "..."` (for bundled workflows). One is required.',
        '',
        'This tool is for INDEPENDENT photos (each its own subject). For multi-angle composite analysis of one subject (e.g., 8 angles of one vehicle), use `analyze_photo` with the existing multi-image API; the batch tool does not stitch.',
        '',
        'Errors on individual photos do NOT fail the whole batch: they appear inline in `results` as `{ input, error }`. Problems with the request itself (no inputs, more than 200, an unknown stack) surface as a tool error.',
      ].join('\n'),
      inputSchema: BatchInputSchema,
      outputSchema: AnalyzeBatchOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ imageUrls, imagePaths, imagesBase64, lenses, stack, refresh, dryRun }: BatchArgs) => {
      if (!lenses && !stack) {
        return {
          content: [{ type: 'text' as const, text: 'Error: provide either `lenses: [...]` or `stack: "..."`. Call `list_lenses` to see available options.' }],
          isError: true as const,
        };
      }

      try {
        // Build the unified inputs[] array from all three sources.
        // imagePaths globs expand here (may throw GLOB_TOO_LARGE, a
        // structural error, propagated as a whole-batch failure).
        //
        // Per-file errors (FILE_NOT_FOUND, INVALID_BASE64, etc.) are
        // isolated: the bad input becomes an inline error row and the rest
        // of the batch continues, matching the per-photo isolation of the
        // analyze step.
        //
        // Memory note: file reads are eager (all bytes loaded into
        // inputs[] before any worker dequeues). Peak memory at MAX_BATCH
        // (200) x 10MB raw = ~4.7GB if every input is a maxed-out local
        // file. In practice agents stay well under this; if a real fleet
        // exercises larger batches, switch to lazy reads inside the
        // worker (tradeoff: slower detection of bad files since they
        // fail during analyze rather than upfront).
        const inputs: PhotoInput[] = [];
        const preErrors: ErrorRow[] = [];

        if (imageUrls) {
          for (const url of imageUrls) {
            inputs.push({ kind: 'url', value: url, label: url });
          }
        }

        if (imagePaths && imagePaths.length > 0) {
          // expandGlobs throwing GLOB_TOO_LARGE is structural, not per-file:
          // let it propagate to the outer catch. A glob refused by the
          // allow-list becomes one error row naming only the pattern.
          const expanded = expandGlobs(imagePaths, (pattern, err) => {
            preErrors.push(errorRow(pattern, err, 'READ_FAILED'));
          });
          for (const abs of expanded) {
            try {
              const local = readLocalImage(abs);
              inputs.push({
                kind: 'base64',
                value: local.bytes.toString('base64'),
                label: abs,
                ...(local.viaSymlink ? { resolvedPath: local.resolvedPath } : {}),
              });
            } catch (err: unknown) {
              preErrors.push(errorRow(abs, err, 'READ_FAILED'));
            }
          }
        }

        if (imagesBase64) {
          for (let i = 0; i < imagesBase64.length; i++) {
            const b64 = imagesBase64[i];
            const label = `base64[${i}]`;
            try {
              validateBase64(b64);
              // Refuse HEIC bytes here too; the API would only answer 422 IMAGE_INVALID.
              assertNotHeic(detectBase64Format(b64), label);
              inputs.push({ kind: 'base64', value: b64, label });
            } catch (err: unknown) {
              preErrors.push(errorRow(label, err, 'INVALID_BASE64'));
            }
          }
        }

        // Only throw zero-input when literally nothing was submitted. When
        // every input was bad, return a result holding only error rows.
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

        // The lenses each photo needs. A stack is expanded through the free
        // catalog so it can be priced and checked against the registry.
        // Null when the catalog is unreachable: the batch runs unpriced and
        // nothing is served from the registry, since coverage is unknown.
        const requested = lenses ?? await stackLenses(client, stack as string);
        const coverLenses = requested ? outputLenses(requested) : null;

        // Step 1: lookup pass, one free lookup per photo, bounded concurrency.
        //
        // Why per-photo instead of batched: the API's bulk-lookup response is
        // keyed by sha256 and does NOT echo the source URL, and the OpenAPI
        // spec doesn't promise input order. One request per photo gives a
        // deterministic mapping. Lookups are free and fast (~3ms each); at
        // LOOKUP_CONCURRENCY=20 a 200-image pass completes in ~30ms.
        //
        // URL inputs are looked up always. Base64 inputs are looked up only on
        // a dry run: on a real run their bytes go to analyze anyway, where the
        // server bills only lenses it has not run, so sending them twice
        // would only cost upload time. A real refresh skips the lookup (it
        // re-runs everything); a dry refresh still looks up so its rows report
        // what the registry knows.
        const known: Known[] = inputs.map(() => ({ matchType: 'none' }));
        if (!refresh || dryRun) {
          const toLookUp = inputs
            .map((input, idx) => ({ input, idx }))
            .filter(({ input }) => input.kind === 'url' || dryRun);
          await mapBounded(toLookUp, LOOKUP_CONCURRENCY, async ({ input, idx }) => {
            try {
              const r = await client.lookup(input.kind === 'url' ? { images: [input.value] } : { imagesBase64: [input.value] });
              const first = Object.values(r.results ?? {})[0];
              if (first) {
                known[idx] = {
                  matchType: first.matchType,
                  ...(first.photo ? { photo: first.photo } : {}),
                  ...(first.receipts ? { receipts: first.receipts } : {}),
                  ...(first.credentials ? { credentials: first.credentials } : {}),
                };
              }
            } catch {
              // A failed lookup is non-fatal: the photo is treated as unknown.
            }
          });
        }

        // Step 2: plan and estimate, fixed before any analyze call. With the
        // stack's lenses unknown, a row lists what the registry holds and
        // nothing is priced. A refresh bills every lens whatever is cached.
        const plans = inputs.map((input, idx) => {
          const cached = known[idx].photo?.lenses ?? {};
          if (!coverLenses) {
            return { input, idx, cachedLenses: Object.keys(cached), missingLenses: [] as string[], billed: [] as string[], covered: false };
          }
          const cachedLenses = coverLenses.filter((l) => l in cached);
          const missingLenses = coverLenses.filter((l) => !(l in cached));
          const covered = !refresh && !!known[idx].photo && missingLenses.length === 0;
          return { input, idx, cachedLenses, missingLenses, billed: refresh ? coverLenses : missingLenses, covered };
        });
        const misses = plans.filter((p) => !p.covered);
        const creditsNeeded = misses.reduce((n, p) => n + billableLenses(p.billed).length, 0);
        // `photos` counts every submitted input, bad ones included, matching summary.photos.
        const estimate = coverLenses
          ? {
            photos: inputs.length + preErrors.length,
            cacheHits: plans.length - misses.length,
            creditsNeeded,
            usd: usdFromCredits(creditsNeeded),
          }
          : null;

        const rows: BatchRow[] = new Array(plans.length);
        const shas: string[] = new Array(plans.length).fill('');

        if (dryRun) {
          for (const p of plans) {
            const photo = known[p.idx].photo;
            rows[p.idx] = {
              input: p.input.label,
              matchType: known[p.idx].matchType,
              cachedLenses: p.cachedLenses,
              missingLenses: p.missingLenses,
              ...(photo ? { resource: photoResourceUri(photo.sha256) } : {}),
            };
            if (photo) shas[p.idx] = photo.sha256;
          }
        } else {
          // Step 3: photos the registry covers come back from it, free.
          for (const p of plans) {
            const photo = known[p.idx].photo;
            if (p.covered && photo && coverLenses) {
              rows[p.idx] = registryRow(p.input.label, { ...known[p.idx], photo }, coverLenses);
              shas[p.idx] = photo.sha256;
            }
          }

          // Step 4: analyze the rest, one POST /v1/analyze per photo.
          await mapBounded(misses, ANALYZE_CONCURRENCY, async ({ input, idx }) => {
            try {
              const result = await client.analyze({
                ...(input.kind === 'url' ? { imageUrl: input.value } : { imageBase64: input.value }),
                ...(lenses ? { modules: lenses } : { preset: stack }),
                // A live fingerprint names the photo in its row and resource link.
                options: { includeFingerprint: true },
                ...(refresh !== undefined ? { refresh } : {}),
              });
              const sha256 = analyzedPhotoSha256(result, input.kind === 'base64' ? input.value : undefined);
              rows[idx] = { input: input.label, ...toAnalyzeEnvelope(result, sha256) };
              shas[idx] = sha256;
            } catch (err: unknown) {
              rows[idx] = errorRow(input.label, err, 'ANALYZE_FAILED');
            }
          });
        }

        // A path read through a symlinked folder names the real file it read.
        for (const { input, idx } of plans) {
          if (input.kind === 'base64' && input.resolvedPath) rows[idx] = { ...rows[idx], resolvedPath: input.resolvedPath };
        }

        // Pre-validation errors come first, so every submitted input is
        // represented in results[], even the bad ones.
        const results: BatchRow[] = [...preErrors, ...rows];
        const photoRows = rows.filter((r): r is PhotoRow => 'photo' in r);
        const creditsCharged = photoRows.reduce((n, r) => n + r.usage.creditsCharged, 0);
        const creditsSaved = photoRows.reduce((n, r) => n + r.usage.creditsSaved, 0);
        const payload: AnalyzeBatchOutput = {
          summary: {
            photos: inputs.length + preErrors.length,
            // A dry run serves nothing; its cache hits are the ones it found.
            cacheHits: dryRun ? (estimate?.cacheHits ?? 0) : photoRows.filter((r) => r.cacheHit).length,
            analyzed: photoRows.filter((r) => !r.cacheHit).length,
            errors: results.filter((r) => 'error' in r).length,
            creditsCharged,
            creditsSaved,
            usd: { charged: usdFromCredits(creditsCharged), saved: usdFromCredits(creditsSaved) },
            estimate,
            ...(dryRun ? { dryRun: true } : {}),
            ...(estimate ? {} : { warnings: ['ESTIMATE_UNAVAILABLE'] }),
          },
          results,
        };

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(payload, null, 2) },
            { type: 'text' as const, text: estimateLine(estimate, !!dryRun) },
            ...[...new Set(shas.filter(Boolean))].map(photoResourceLink),
          ],
          structuredContent: payload,
        };
      } catch (err: unknown) {
        return renderToolError(err);
      }
    },
  );
}
