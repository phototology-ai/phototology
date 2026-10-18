/**
 * Hand-written envelopes for every MCP tool's `structuredContent`.
 *
 * Shapes follow spec §10.1 of the MCP gold-standard design. `receipts` and
 * `credentials` are deliberately loose here; a later row tightens them.
 * Dollar amounts are strings with two decimals ("0.05"), credits are numbers.
 */
import { z } from 'zod';
import { LensOutputSchema } from './lens-output';

/** Two-decimal dollar string, e.g. "0.05". */
const Usd = z.string();

export const PhotoIdentitySchema = z.looseObject({
  sha256: z.string(),
  pixelsSha256: z.string().optional(),
  pHash: z.string(),
  dHash: z.string(),
  pdq: z.looseObject({ hash: z.string(), quality: z.number() }).optional(),
  iscc: z.string().optional(),
});
export type PhotoIdentity = z.infer<typeof PhotoIdentitySchema>;

export const UsageSchema = z.looseObject({
  creditsCharged: z.number(),
  creditsSaved: z.number(),
  usd: z.looseObject({ charged: Usd, saved: Usd }),
  modulesUsed: z.array(z.string()),
});
export type Usage = z.infer<typeof UsageSchema>;

const Receipts = z.array(z.unknown());
const Credentials = z.unknown().optional();

export const AnalyzePhotoOutputSchema = z.looseObject({
  photo: PhotoIdentitySchema,
  output: LensOutputSchema,
  lenses: z.array(z.string()),
  usage: UsageSchema,
  cacheHit: z.boolean(),
  receipts: Receipts,
  credentials: Credentials,
  /** Absent when the photo has no name to link to (a URL analyzed by the `pt_test_` sandbox). */
  resource: z.string().optional(),
  livemode: z.boolean(),
  /** The real file read, present only when a local path went through a symlinked folder. */
  resolvedPath: z.string().optional(),
});
export type AnalyzePhotoOutput = z.infer<typeof AnalyzePhotoOutputSchema>;

const MatchType = z.enum(['exact', 'pixels', 'pdq', 'fuzzy', 'none']);

/**
 * One analyzed photo inside a batch: the analyze_photo envelope plus the
 * caller's input echo. A row served from the registry carries the lookup's
 * `matchType`; on a non-exact match `photo` is the matched record, not the input.
 */
const BatchPhotoResultSchema = AnalyzePhotoOutputSchema.extend({
  input: z.string().optional(),
  matchType: MatchType.optional(),
});

/** One photo that failed inside a batch; the batch itself still succeeds. */
const BatchErrorResultSchema = z.looseObject({
  error: z.looseObject({ code: z.string(), message: z.string() }),
  input: z.string(),
  /** The real file read, present only when a local path went through a symlinked folder. */
  resolvedPath: z.string().optional(),
});

/** One photo in a `dryRun: true` batch: what the registry knows, nothing billed. */
const BatchDryRunResultSchema = z.looseObject({
  input: z.string(),
  matchType: MatchType,
  cachedLenses: z.array(z.string()),
  missingLenses: z.array(z.string()),
  resource: z.string().optional(),
  /** The real file read, present only when a local path went through a symlinked folder. */
  resolvedPath: z.string().optional(),
});

export const AnalyzeBatchOutputSchema = z.looseObject({
  summary: z.looseObject({
    photos: z.number(),
    cacheHits: z.number(),
    creditsCharged: z.number(),
    creditsSaved: z.number(),
    usd: z.looseObject({ charged: Usd, saved: Usd }),
    /** Null when a stack could not be priced because the lens catalog was unreachable. */
    estimate: z.looseObject({
      photos: z.number(),
      cacheHits: z.number(),
      creditsNeeded: z.number(),
      usd: Usd,
    }).nullable(),
    dryRun: z.boolean().optional(),
    /** Machine codes for degraded runs, e.g. `ESTIMATE_UNAVAILABLE`. */
    warnings: z.array(z.string()).optional(),
  }),
  results: z.array(z.union([BatchPhotoResultSchema, BatchErrorResultSchema, BatchDryRunResultSchema])),
});
export type AnalyzeBatchOutput = z.infer<typeof AnalyzeBatchOutputSchema>;

const LensIndexEntrySchema = z.looseObject({
  eventId: z.string(),
  output: z.record(z.string(), z.unknown()),
  version: z.string(),
  producedAt: z.string(),
  coRunHash: z.string(),
  provider: z.string(),
});

/** Registry record returned by a lookup: identity plus per-lens cached output. */
const PhotoRecordSchema = PhotoIdentitySchema.extend({
  firstAnalyzedAt: z.string(),
  lastAnalyzedAt: z.string(),
  totalCreditsSpent: z.number(),
  analyzeCallCount: z.number(),
  lenses: z.record(z.string(), LensIndexEntrySchema),
});

export const LookupPhotoOutputSchema = z.looseObject({
  matchType: MatchType,
  hammingDistance: z.number().optional(),
  pdqDistance: z.number().optional(),
  photo: PhotoRecordSchema.optional(),
  computedHashes: z.looseObject({ sha256: z.string(), pHash: z.string(), dHash: z.string() }).optional(),
  receipts: Receipts,
  credentials: Credentials,
  resource: z.string().optional(),
  /** The real file read, present only when a local path went through a symlinked folder. */
  resolvedPath: z.string().optional(),
});
export type LookupPhotoOutput = z.infer<typeof LookupPhotoOutputSchema>;

export const ListLensesOutputSchema = z.looseObject({
  lenses: z.array(
    z.looseObject({
      name: z.string(),
      description: z.string(),
      category: z.string(),
      outputFields: z.array(z.string()),
      billable: z.boolean(),
      credits: z.union([z.literal(1), z.literal(0)]),
      defaultColumns: z.array(
        z.looseObject({
          label: z.string(),
          jsonPath: z.string(),
          format: z.enum(['string', 'number', 'date', 'percentage', 'tags', 'hex', 'count']).optional(),
        }),
      ),
      internal: z.literal(true).optional(),
    }),
  ),
  stacks: z.array(
    z.looseObject({
      name: z.string(),
      description: z.string(),
      lenses: z.array(z.string()),
      credits: z.number(),
      usdPerPhoto: Usd,
    }),
  ),
});
export type ListLensesOutput = z.infer<typeof ListLensesOutputSchema>;

/**
 * Only `total` and `usd` are required. The tier and the pool breakdown are
 * legacy detail: if a future API drops one, the SDK's output validation must
 * not turn a balance read into a tool error.
 */
export const GetCreditsOutputSchema = z.looseObject({
  tier: z.string().optional(),
  total: z.number(),
  community: z.looseObject({
    balance: z.number().optional(),
    monthlyAllowance: z.number().optional(),
    referralBonus: z.number().optional(),
    resetsInDays: z.number().optional(),
  }).optional(),
  purchased: z.looseObject({ balance: z.number().optional() }).optional(),
  reserved: z.number().optional(),
  /** Dollar value of `total`. */
  usd: Usd,
});
export type GetCreditsOutput = z.infer<typeof GetCreditsOutputSchema>;

export const PurchaseCreditsOutputSchema = z.looseObject({
  url: z.string(),
  actions: z.array(z.looseObject({ type: z.literal('open_url'), label: z.string(), url: z.string() })),
});
export type PurchaseCreditsOutput = z.infer<typeof PurchaseCreditsOutputSchema>;

export const EnrichPhotoOutputSchema = z.looseObject({
  mode: z.enum(['file', 'sidecar']),
  savedTo: z.string().optional(),
  sidecarSavedTo: z.string().optional(),
  imageBase64: z.string().optional(),
  sidecar: z.looseObject({ xmp: z.string() }).optional(),
  formatsWritten: z.array(z.enum(['exif', 'iptc', 'xmp'])),
  lensVersions: z.record(z.string(), z.string()),
  sha256: z.string(),
  registryId: z.string().optional(),
  credentials: Credentials,
  reason: z.string().optional(),
  usage: z.looseObject({ creditsCharged: z.number(), usd: z.looseObject({ charged: Usd }) }),
  /** The real file read, present only when a local path went through a symlinked folder. */
  resolvedPath: z.string().optional(),
});
export type EnrichPhotoOutput = z.infer<typeof EnrichPhotoOutputSchema>;
