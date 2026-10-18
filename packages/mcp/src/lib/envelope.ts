/**
 * Builds the typed `structuredContent` for analyze results (spec §9.2, §10.1).
 *
 * One credit is one billable lens run on one photo and costs $0.01. The API
 * reports `usage.creditsSaved` and `usage.usd`; an older API that omits them
 * gets the same numbers computed here from `creditsCharged` and
 * `meta.cacheHit`.
 */
import type { AnalyzeResponse, EnrichResponse, LookupResponse } from '@phototology/sdk';
import type { AnalyzePhotoOutput, EnrichPhotoOutput, LookupPhotoOutput } from '../schemas';
import { computeSha256 } from './local-image';

/**
 * Modules that never bill a credit. Mirrors `NON_BILLABLE_MODULES` in
 * phototology-api/src/services/moduleComposition.ts: moderation is free
 * safety screening, `vehicle-condition` is stack-only, and the rest are
 * prompt-engine internals that produce no output of their own.
 */
const NON_BILLABLE_MODULES = new Set([
  'base',
  'moderation',
  'multi-image',
  'multi-image-vehicle',
  'vehicle-base',
  'vehicle-condition',
]);

/** Modules that are prompt-engine internals: they own no output and never appear in the registry. */
const BEHAVIORAL_MODULES = new Set(['base', 'multi-image', 'multi-image-vehicle', 'vehicle-base']);

/** The lenses in `modules` that bill a credit each. */
export function billableLenses(modules: readonly string[]): string[] {
  return modules.filter((m) => !NON_BILLABLE_MODULES.has(m));
}

/** The lenses in `modules` that own output, so a registry entry can hold them. */
export function outputLenses(modules: readonly string[]): string[] {
  return modules.filter((m) => !BEHAVIORAL_MODULES.has(m));
}

/** Dollar amount for a credit count, as a string with two decimals ("0.05"). */
export function usdFromCredits(n: number): string {
  return (n / 100).toFixed(2);
}

/** The MCP resource that serves a photo's registry record. */
export function photoResourceUri(sha256: string): string {
  return `phototology://photo/${sha256}`;
}

/**
 * The sha256 that names an analyzed photo. Only a live response's fingerprint
 * counts: the `pt_test_` sandbox answers with a placeholder (64 zeros) that
 * names no real photo. Otherwise the bytes the caller sent are hashed; a URL
 * with no live fingerprint has no name, and the result is ''.
 */
export function analyzedPhotoSha256(res: AnalyzeResponse, base64?: string): string {
  const live = res.livemode === true ? res.fingerprint?.sha256 : undefined;
  return live ?? (base64 ? computeSha256(Buffer.from(base64, 'base64')) : '');
}

/** A `resource_link` content block pointing at the photo resource. */
export function photoResourceLink(sha256: string): {
  type: 'resource_link';
  uri: string;
  name: string;
  mimeType: 'application/json';
} {
  return { type: 'resource_link', uri: photoResourceUri(sha256), name: sha256, mimeType: 'application/json' };
}

/**
 * Reshape an SDK analyze response into the `analyze_photo` envelope.
 *
 * `photoSha256` names the photo (see `analyzedPhotoSha256`). When it is empty
 * the photo has no resource and `resource` is omitted. The fingerprint's
 * perceptual hashes are used only from a live response, since the sandbox's
 * are placeholders too.
 *
 * `id`, `meta`, `warnings` and `embedding` ride along as extra fields so
 * nothing the old text result carried is lost.
 */
export function toAnalyzeEnvelope(res: AnalyzeResponse, photoSha256: string): AnalyzePhotoOutput {
  const usage = res.usage ?? ({} as AnalyzeResponse['usage']);
  const modulesUsed = Array.isArray(usage.modulesUsed) ? usage.modulesUsed : [];
  const cacheHit = (res.meta as { cacheHit?: unknown } | undefined)?.cacheHit === true;
  const creditsCharged = usage.creditsCharged ?? 0;
  const creditsSaved = usage.creditsSaved ?? (cacheHit ? billableLenses(modulesUsed).length : 0);
  const usd = usage.usd ?? { charged: usdFromCredits(creditsCharged), saved: usdFromCredits(creditsSaved) };
  const proof = res as unknown as { receipts?: unknown; credentials?: unknown };
  const fingerprint = res.livemode === true ? res.fingerprint : undefined;

  return {
    id: res.id,
    photo: {
      // SDK interfaces (Fingerprint, PdqFingerprint) carry no index signature,
      // so TypeScript will not match them to the loose identity schema even
      // though the fields line up; the schema tests parse the result.
      ...(fingerprint as Record<string, unknown> | undefined),
      sha256: photoSha256,
      pHash: fingerprint?.pHash ?? '',
      dHash: fingerprint?.dHash ?? '',
    },
    output: res.output,
    lenses: modulesUsed,
    usage: { ...usage, creditsCharged, creditsSaved, usd, modulesUsed },
    cacheHit,
    receipts: Array.isArray(proof.receipts) ? proof.receipts : [],
    ...(proof.credentials !== undefined ? { credentials: proof.credentials } : {}),
    ...(photoSha256 ? { resource: photoResourceUri(photoSha256) } : {}),
    // A response without `livemode` is never presented as real model output.
    livemode: res.livemode === true,
    meta: res.meta,
    warnings: res.warnings,
    ...(res.embedding ? { embedding: res.embedding } : {}),
  };
}

/**
 * Flatten an SDK lookup response into the `lookup_photo` envelope.
 *
 * A lookup asks about one image, so `results` holds at most one entry; an
 * empty map (the API could not fingerprint the image) reads as a miss.
 * `matchType`, `photo`, `hammingDistance` and `computedHashes` pass through.
 * `receipts` defaults to `[]` and `credentials` appears only when the API
 * sends it. On a match, `resource` names the matched registry record (on a
 * fuzzy match that is the record's sha256, not the input's), falling back to
 * `knownSha256`, the hash of the bytes the caller sent; with neither it is
 * omitted. `meta` rides along so the request id is not lost.
 *
 * Returns the envelope and the sha256 its resource names ('' on a miss), so
 * the caller can add the matching resource link.
 */
export function toLookupEnvelope(
  res: LookupResponse,
  knownSha256?: string,
): { envelope: LookupPhotoOutput; sha256: string } {
  const entry = (Object.values(res.results ?? {})[0] ?? { matchType: 'none' }) as LookupResponse['results'][string] & {
    receipts?: unknown;
    credentials?: unknown;
  };
  const { receipts, credentials, ...rest } = entry;
  const sha256 = (entry.matchType !== 'none' && (entry.photo?.sha256 || knownSha256)) || '';
  const envelope: LookupPhotoOutput = {
    // The SDK's PhotoRecord / LensIndexEntry are interfaces, which carry no
    // index signature, so TypeScript will not match them to the loose envelope
    // even though the fields line up; the schema tests parse the result.
    ...(rest as Pick<LookupPhotoOutput, 'matchType' | 'photo' | 'hammingDistance' | 'pdqDistance' | 'matchedBy' | 'computedHashes'>),
    receipts: Array.isArray(receipts) ? receipts : [],
    ...(credentials !== undefined ? { credentials } : {}),
    ...(sha256 ? { resource: photoResourceUri(sha256) } : {}),
    ...(res.meta ? { meta: res.meta } : {}),
  };
  return { envelope, sha256 };
}

/**
 * Reshape an SDK enrich response into the `enrich_photo` envelope.
 *
 * `mode` is the API's when it sends one; an API that predates the field
 * always wrote into the file, so bytes mean `file` and no bytes mean
 * `sidecar`. `imageBase64` is kept only when `keepBytes` is true (the caller
 * gave no `outputPath`); `savedTo` names the file the bytes were written to.
 * `sidecar`, `registryId`, `credentials` and `reason` pass through when the
 * API sends them, and `meta` rides along so the request id is not lost.
 */
export function toEnrichEnvelope(
  res: EnrichResponse,
  opts: { keepBytes: boolean; savedTo?: string },
): EnrichPhotoOutput {
  const extra = res as EnrichResponse & {
    mode?: 'file' | 'sidecar';
    sidecar?: { xmp: string };
    registryId?: string;
    credentials?: unknown;
    reason?: string;
  };
  const hasBytes = typeof res.imageBase64 === 'string' && res.imageBase64 !== '';
  const creditsCharged = res.meta?.creditsCharged ?? 0;
  return {
    mode: extra.mode ?? (hasBytes ? 'file' : 'sidecar'),
    ...(opts.savedTo ? { savedTo: opts.savedTo } : {}),
    ...(hasBytes && opts.keepBytes ? { imageBase64: res.imageBase64 } : {}),
    ...(extra.sidecar !== undefined ? { sidecar: extra.sidecar } : {}),
    formatsWritten: res.formatsWritten,
    lensVersions: res.lensVersions,
    sha256: res.sha256,
    ...(extra.registryId !== undefined ? { registryId: extra.registryId } : {}),
    ...(extra.credentials !== undefined ? { credentials: extra.credentials } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
    usage: { creditsCharged, usd: { charged: usdFromCredits(creditsCharged) } },
    ...(res.meta ? { meta: res.meta } : {}),
  };
}
