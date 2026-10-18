import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PhototologyClient, LookupResponse } from '@phototology/sdk';
import { renderToolError, sandboxRefusal } from './errors';
import {
  readLocalImage,
  resolvePath,
  computeSha256,
  validateBase64,
  LocalImageError,
} from '../lib/local-image';
import { readEmbeddedRegistryId } from '../lib/registry-id';
import { toLookupEnvelope, photoResourceLink } from '../lib/envelope';
import { LookupPhotoOutputSchema } from '../schemas';

const LookupInputSchema = {
  imageUrl: z.string().url().optional()
    .describe('Publicly fetchable image URL. Server downloads and hashes it; perceptual-hash matching catches re-encodes of the same image.'),
  sha256: z.string().length(64).optional()
    .describe('SHA-256 hex digest for direct lookup. Use when you already know the hash; skips the download.'),
  // Either form passes through unchanged; the API expands hex to bits.
  pHash: z.string()
    .regex(/^(?:[01]{64}|[0-9a-fA-F]{16})$/, 'pHash must be a 64-character bit string as returned by analyze and lookup, or 16 hex characters')
    .optional()
    .describe('Perceptual hash: a 64-character bit string as returned by analyze and lookup, or 16 hex characters. Direct lookup; skips the cascade. Use when you already have a pHash from a prior call.'),
  imagePath: z.string().optional()
    .describe('Absolute local-filesystem path on the machine running the MCP server. The MCP runs a transparent sha256→pHash cascade: cheap exact-bytes match first, then on miss falls through to perceptually-similar match via server-side pHash. Both calls are free. NOT for paths inside an agent sandbox (e.g. Claude\'s /mnt/user-data/uploads/...); that sandbox is invisible to a locally-installed MCP; use imageBase64 or imageUrl for those. Accepts absolute (/Users/...) or ~/-prefixed paths; relative paths are rejected.'),
  imageBase64: z.string().optional()
    .describe('Base64-encoded image bytes (no data: URL prefix). The MCP runs the same sha256→pHash cascade as imagePath. Both calls are free. Useful for small images (under ~150KB JPEG / ~200K base64 chars); for larger files prefer imageUrl.'),
  threshold: z.number().int().min(0).max(64).optional()
    .describe('Hamming-distance threshold for pHash fuzzy matching (0-64). Default 5. Lower = stricter; higher = more matches but less precise.'),
};

/**
 * The tool result: the flattened envelope as text and structured content, plus a resource link on a match.
 * `resolvedPath` is set only when a symlinked folder led somewhere else, so the caller sees what was read.
 */
function lookupResult(res: LookupResponse, knownSha256?: string, resolvedPath?: string) {
  const { envelope: base, sha256 } = toLookupEnvelope(res, knownSha256);
  const envelope = resolvedPath ? { ...base, resolvedPath } : base;
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(envelope, null, 2) },
      ...(sha256 ? [photoResourceLink(sha256)] : []),
    ],
    structuredContent: envelope,
  };
}

interface LookupArgs {
  imageUrl?: string;
  sha256?: string;
  pHash?: string;
  imagePath?: string;
  imageBase64?: string;
  threshold?: number;
}

export function registerLookupPhoto(server: McpServer, client: PhototologyClient): void {
  // Cast: MCP SDK's registerTool generics hit TS2589 with complex Zod schemas.
  const s = server as any;

  s.registerTool(
    'lookup_photo',
    {
      title: 'Look up a photo in the registry',
      description: [
        'Check if a photo has already been analyzed and return every cached lens result. Free. Does not bill credits.',
        '',
        'Use this before `analyze_photo` whenever possible. Phototology is a registry: any photo ever analyzed (by any user on the same account) is returned here without re-running the LLM.',
        '',
        'If the photo is local, pass `imagePath` and the MCP runs a transparent sha256→pHash cascade against the registry. Both lookup paths are free. If you only have a hash, pass `sha256` or `pHash` directly to skip the file work.',
        '',
        'Input: exactly one of `imageUrl` (server fetches and hashes), `sha256` (direct hash lookup), `pHash` (direct perceptual-hash lookup), `imagePath` (local file, cascade), or `imageBase64` (in-memory bytes, cascade). When passing a URL or local file, perceptual-hash matching also catches re-encodes and re-uploads of the same image.',
        '',
        'Returns `{ matchType, photo?, hammingDistance?, pdqDistance?, matchedBy?, computedHashes?, receipts, credentials?, resource? }` for the one image asked about. `matchType` is `exact` (same file bytes), `pixels` (same decoded pixels in a different file), `pdq` (a PDQ perceptual match, with `pdqDistance`), `fuzzy` (a pHash perceptual match, with `hammingDistance`) or `none`. On anything but `exact`, `photo` is the registry record that matched, not the submitted image. On a match, `photo.lenses` maps each lens name to its last-cached output, and `resource` (also sent as a resource link) reads this registry record later for free. On `none` the photo has never been analyzed on this account: there is no `photo` and no `resource`, and `analyze_photo` is the next step. A local file that Phototology enriched carries its registry id in XMP; it is tried first, and a hit on it says `matchedBy: \'registryId\'` (an `exact` match even if the file was edited since). `receipts` holds the matched photo\'s stored receipts, newest first, at most 10. It may be empty, and a lookup carries no warning saying why: the photo was analyzed before receipts existed or its analysis got none (`analyze_photo` names the reason in `warnings`: `RECEIPT_UNAVAILABLE`, `RECEIPT_NONE_STORED`, or a `RECEIPT_NOT_ISSUED_*` code).',
      ].join('\n'),
      inputSchema: LookupInputSchema,
      outputSchema: LookupPhotoOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ imageUrl, sha256, pHash, imagePath, imageBase64, threshold }: LookupArgs) => {
      const refusal = await sandboxRefusal();
      if (refusal) return refusal;
      try {
        // Refinement: exactly one image input mode. Empty strings count as "not provided".
        const provided = [sha256, pHash, imageUrl, imagePath, imageBase64].filter(
          (v) => v !== undefined && v !== '',
        );
        if (provided.length === 0) {
          throw new LocalImageError(
            'UNSUPPORTED_FORMAT',
            'lookup_photo requires exactly one of: sha256, pHash, imageUrl, imagePath, imageBase64.',
          );
        }
        if (provided.length > 1) {
          throw new LocalImageError(
            'UNSUPPORTED_FORMAT',
            'lookup_photo accepts exactly one of sha256, pHash, imageUrl, imagePath, imageBase64. Multiple were provided.',
          );
        }

        // Backwards-compat: direct hash/URL paths forward verbatim, no cascade.
        if (sha256 !== undefined && sha256 !== '') {
          const result = await client.lookup({
            sha256,
            ...(threshold !== undefined ? { threshold } : {}),
          });
          return lookupResult(result, sha256);
        }
        if (pHash !== undefined && pHash !== '') {
          const result = await client.lookup({
            pHash,
            ...(threshold !== undefined ? { threshold } : {}),
          });
          return lookupResult(result);
        }
        if (imageUrl !== undefined && imageUrl !== '') {
          const result = await client.lookup({
            images: [imageUrl],
            ...(threshold !== undefined ? { threshold } : {}),
          });
          return lookupResult(result);
        }

        // Local input modes (imagePath or imageBase64): sha256→pHash cascade.
        let bytes: Buffer;
        let cachedBase64: string | undefined;
        // Set only when a symlinked folder led somewhere else, so the caller sees what was read.
        let resolvedPath: string | undefined;
        if (imagePath !== undefined && imagePath !== '') {
          const local = readLocalImage(resolvePath(imagePath));
          bytes = local.bytes;
          if (local.viaSymlink) resolvedPath = local.resolvedPath;
        } else {
          // imageBase64 (validated already-non-empty by the provided-count check).
          validateBase64(imageBase64!);
          bytes = Buffer.from(imageBase64!, 'base64');
          cachedBase64 = imageBase64;
        }

        // Step 0: a file enriched by Phototology carries its registry id (the
        // sha256 of its original bytes) in XMP. Try it before hashing, since
        // the enrich changed the bytes and their own sha256 will not match.
        // Only an exact match counts: the id is untrusted input (planted, or
        // copied from another file). Anything else falls through to the
        // cascade on the real bytes. A hit says `matchedBy: 'registryId'`, so
        // an exact match on a file edited since its enrich is explainable.
        const embeddedId = readEmbeddedRegistryId(bytes);
        if (embeddedId) {
          const byId = await client.lookup({ sha256: embeddedId });
          const hit = byId.results?.[embeddedId];
          if (hit?.matchType === 'exact') {
            const marked = {
              ...byId,
              results: { [embeddedId]: { ...hit, matchedBy: 'registryId' as const } },
            };
            return lookupResult(marked, embeddedId, resolvedPath);
          }
        }

        const sha = computeSha256(bytes);

        // Step 1: cheap exact-bytes lookup via sha256. Server returns cached
        // registry record if any account ever uploaded the same bytes.
        const exact = await client.lookup({ sha256: sha });
        const exactEntry = exact.results?.[sha];
        // Short-circuit on any hit. The API's sha256-only GET runs only the
        // exact tier (no pHash, no bytes), so it answers 'exact' or 'none'; a
        // miss falls through to Step 2, where the pixels and PDQ tiers run.
        if (exactEntry && exactEntry.matchType !== 'none') {
          return lookupResult(exact, sha, resolvedPath);
        }

        // Step 2: send image bytes so the server can run the byte-based tiers:
        // same decoded pixels, PDQ (re-encodes, rotations, flips), then pHash.
        const b64 = cachedBase64 ?? bytes.toString('base64');
        const fuzzy = await client.lookup({
          imagesBase64: [b64],
          ...(threshold !== undefined ? { threshold } : {}),
        });
        return lookupResult(fuzzy, sha, resolvedPath);
      } catch (err: unknown) {
        return renderToolError(err);
      }
    },
  );
}
