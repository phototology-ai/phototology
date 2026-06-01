import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PhototologyClient } from '@phototology/sdk';
import { renderToolError } from './errors';
import {
  readImage,
  resolvePath,
  computeSha256,
  validateBase64,
  LocalImageError,
} from '../lib/local-image';

const LookupInputSchema = {
  imageUrl: z.string().url().optional()
    .describe('Publicly fetchable image URL. Server downloads and hashes it; perceptual-hash matching catches re-encodes of the same image.'),
  sha256: z.string().length(64).optional()
    .describe('SHA-256 hex digest for direct lookup. Use when you already know the hash; skips the download.'),
  pHash: z.string().length(16).regex(/^[0-9a-f]+$/, 'pHash must be 16-char lowercase hex').optional()
    .describe('Perceptual hash (16-char lowercase hex). Direct lookup; skips the cascade. Use when you already have a pHash from a prior call.'),
  imagePath: z.string().optional()
    .describe('Absolute local-filesystem path on the machine running the MCP server. The MCP runs a transparent sha256→pHash cascade: cheap exact-bytes match first, then on miss falls through to perceptually-similar match via server-side pHash. Both calls are free. NOT for paths inside an agent sandbox (e.g. Claude\'s /mnt/user-data/uploads/...) — that sandbox is invisible to a locally-installed MCP; use imageBase64 or imageUrl for those. Accepts absolute (/Users/...) or ~/-prefixed paths; relative paths are rejected.'),
  imageBase64: z.string().optional()
    .describe('Base64-encoded image bytes (no data: URL prefix). The MCP runs the same sha256→pHash cascade as imagePath. Both calls are free. Useful for small images (under ~150KB JPEG / ~200K base64 chars); for larger files prefer imageUrl.'),
  threshold: z.number().int().min(0).max(64).optional()
    .describe('Hamming-distance threshold for pHash fuzzy matching (0-64). Default 5. Lower = stricter; higher = more matches but less precise.'),
};

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
      description: [
        'Check if a photo has already been analyzed and return every cached lens result. Free. Does not bill credits.',
        '',
        'Use this before `analyze_photo` whenever possible. Phototology is a registry: any photo ever analyzed (by any user on the same account) is returned here without re-running the LLM.',
        '',
        'If the photo is local, pass `imagePath` — the MCP runs a transparent sha256→pHash cascade against the registry. Both lookup paths are free. If you only have a hash, pass `sha256` or `pHash` directly to skip the file work.',
        '',
        'Input: exactly one of `imageUrl` (server fetches and hashes), `sha256` (direct hash lookup), `pHash` (direct perceptual-hash lookup), `imagePath` (local file, cascade), or `imageBase64` (in-memory bytes, cascade). When passing a URL or local file, perceptual-hash matching also catches re-encodes and re-uploads of the same image.',
        '',
        'Returns `results[sha256].photo.lenses` — a map from lens name to its last-cached output. An empty `lenses` map means the photo has never been analyzed on this account.',
      ].join('\n'),
      inputSchema: LookupInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ imageUrl, sha256, pHash, imagePath, imageBase64, threshold }: LookupArgs) => {
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
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }
        if (pHash !== undefined && pHash !== '') {
          const result = await client.lookup({
            pHash,
            ...(threshold !== undefined ? { threshold } : {}),
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }
        if (imageUrl !== undefined && imageUrl !== '') {
          const result = await client.lookup({
            images: [imageUrl],
            ...(threshold !== undefined ? { threshold } : {}),
          });
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
          };
        }

        // Local input modes (imagePath or imageBase64): sha256→pHash cascade.
        let bytes: Buffer;
        let cachedBase64: string | undefined;
        if (imagePath !== undefined && imagePath !== '') {
          const abs = resolvePath(imagePath);
          bytes = readImage(abs);
        } else {
          // imageBase64 (validated already-non-empty by the provided-count check).
          validateBase64(imageBase64!);
          bytes = Buffer.from(imageBase64!, 'base64');
          cachedBase64 = imageBase64;
        }

        const sha = computeSha256(bytes);

        // Step 1: cheap exact-bytes lookup via sha256. Server returns cached
        // registry record if any account ever uploaded the same bytes.
        const exact = await client.lookup({ sha256: sha });
        const exactEntry = exact.results?.[sha];
        // Short-circuit if the sha256 lookup returned ANY hit. The API's GET path
        // substitutes a dummy '0'.repeat(16) pHash when only sha256 is submitted
        // (packages/phototology-api/src/v2/lookup.ts:266), so we can receive
        // matchType 'exact' (sha256 match) OR rarely 'fuzzy' (pHash collision with
        // near-zero phash). Either means Step 2 has nothing left to add.
        if (exactEntry && exactEntry.matchType !== 'none') {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(exact, null, 2) }],
          };
        }

        // Step 2: send image bytes so the server can compute pHash and check
        // for perceptually-similar matches (re-encodes, resizes, recompresses).
        const b64 = cachedBase64 ?? bytes.toString('base64');
        const fuzzy = await client.lookup({
          imagesBase64: [b64],
          ...(threshold !== undefined ? { threshold } : {}),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(fuzzy, null, 2) }],
        };
      } catch (err: unknown) {
        return renderToolError(err);
      }
    },
  );
}
