import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type PhototologyClient, PRESET_IDS, type LensId } from '@phototology/sdk';
import { SELECTABLE_LENS_IDS } from '../lib/lens-ids';
import { renderToolError } from './errors';
import { readLocalImage, resolvePath, validateBase64, LocalImageError } from '../lib/local-image';
import { toAnalyzeEnvelope, photoResourceLink, analyzedPhotoSha256 } from '../lib/envelope';
import { AnalyzePhotoOutputSchema } from '../schemas';

// Stack-only lenses (vehicle-condition) stay out of the selectable enum.
const LENS_IDS = SELECTABLE_LENS_IDS;

const AnalyzeInputSchema = {
  imageUrl: z.string().url().optional()
    .describe('Publicly fetchable image URL. JPEG, PNG, GIF, WebP, AVIF, or TIFF (HEIC is not decoded yet; convert to JPEG first). The server fetches it server-side. Use when you have a URL.'),
  imageBase64: z.string().optional()
    .describe('Base64-encoded image bytes (no data: URL prefix). Useful for small images (under ~150KB JPEG / ~200K base64 chars); for larger files prefer `imageUrl` or `imagePath`. LLM-driven clients exhaust output-token budget before the MCP receives the payload on large base64 strings: a 3.4MB JPEG produces ~4.57M chars.'),
  imagePath: z.string().optional()
    .describe('Absolute local-filesystem path on the machine running the MCP server. The MCP reads the file from disk and forwards bytes to the API. Use this when the photo lives on the user\'s local disk that this MCP process can see. NOT for photos uploaded into an agent\'s sandbox (e.g. Claude\'s /mnt/user-data/uploads/...); that sandbox is invisible to a locally-installed MCP. For agent-sandboxed uploads, prefer `imageBase64` (small images) or `imageUrl` (hostable images of any size). Accepts absolute (/Users/...) or ~/-prefixed paths; relative paths are rejected.'),
  stack: z.enum([...PRESET_IDS] as [string, ...string[]])
    .default('full-analysis')
    .describe('Named bundle of lenses (a stack) to run together. Stacks differ widely in size and price. Call `list_lenses` for each stack\'s lenses, its `credits` and its `usdPerPhoto` before committing to a stack on a large batch. Use when the workflow matches the stack name (e.g. `automobile` for vehicle photos, `memorial` for tribute photos). Ignored when `lenses` is provided. (Previously named `preset`; that name is still accepted as a deprecated alias.)'),
  preset: z.enum([...PRESET_IDS] as [string, ...string[]]).optional()
    .describe('Deprecated alias for `stack`. Prefer `stack` in new code.'),
  lenses: z.array(z.enum(LENS_IDS)).optional()
    .describe('Explicit list of lenses to run. Prefer this over `stack` when you only need a few; it bills only for the lenses you pick. Call `list_lenses` for descriptions of each lens. (The previous parameter name was `modules`, still accepted as an alias during the rename.)'),
  modules: z.array(z.enum(LENS_IDS)).optional()
    .describe('Deprecated alias for `lenses`. Prefer `lenses` in new code; this name still works for backward compatibility.'),
  includeEmbedding: z.boolean().default(false)
    .describe('Include the 1408-dim embedding vector for similarity search. Adds tokens to the response; leave false unless you need it.'),
  refresh: z.boolean().optional()
    .describe('Force the LLM to re-run every requested lens, bypassing the per-account projection cache. Only pass `true` when the user explicitly asks to "re-analyze" or "refresh"; default cache reuse saves credits.'),
};

interface AnalyzeArgs {
  imageUrl?: string;
  imageBase64?: string;
  imagePath?: string;
  stack: string;
  /** @deprecated Use `stack`. Accepted for backward compatibility. */
  preset?: string;
  lenses?: LensId[];
  /** @deprecated Use `lenses`. Accepted for backward compatibility. */
  modules?: LensId[];
  includeEmbedding: boolean;
  refresh?: boolean;
}

export function registerAnalyzePhoto(server: McpServer, client: PhototologyClient): void {
  // Cast: MCP SDK's registerTool generics hit TS2589 with complex Zod schemas.
  const s = server as any;

  s.registerTool(
    'analyze_photo',
    {
      title: 'Analyze a photo',
      description: [
        'Analyze a photo with AI vision and return structured facts. Use when the user has an image URL and needs information about it (dates, people, location, condition, entities, etc.).',
        '',
        'If the photo is on the local disk, pass `imagePath` (absolute path or `~/`-prefixed). If you have a URL, pass `imageUrl`. If you already have the base64 bytes in memory, pass `imageBase64`. Pick the one the user gave you.',
        '',
        'Before calling this, prefer `lookup_photo` first. If the photo has been analyzed before (any user on this account), the cached lens result is returned for free.',
        '',
        'Cost: 1 credit per lens ($0.01). The `full-analysis` stack runs every lens in the catalog; call `list_lenses` to see the current count. To stay cheap, pass `lenses: ["dating", "people"]` with only the lenses you need. Re-running the same lens on the same photo costs zero (delta billing).',
        '',
        'Lens / stack selection: call `list_lenses` if you do not know which lens owns the field you need, or which stack matches the workflow. Each lens names its output fields explicitly; each stack names the lenses it contains.',
        '',
        'Output: `{ photo, output, lenses, usage, cacheHit, receipts, credentials?, resource?, livemode }`. `photo` names the image by `sha256` and its perceptual hashes. `output` is flat JSON keyed by field name (e.g. `estimatedDate`, `peopleCount`, `warmCaption`). Dates: `estimatedDate.yearRange` (`{ from, to }`) is the estimate; `estimatedDate.year` is the single best year (kept for older clients); `rangeLabel` reads like "c. 1975–1985". Quote the range, not just the year, when confidence is `low` or `medium`. `dateSource` says where `year` came from: `exif` is the capture date the camera wrote, read from the original file before resizing (then `capturedAt` holds the timestamp, `yearRange` is that one year, and the visual guess is in `visualEstimate`); `visual` is the visual estimate. `notAfterYear` is a latest-possible year from a scan or save date. These are absent on older results. `usage.creditsCharged` is the actual cost, `usage.creditsSaved` is what the registry saved, and `usage.usd` gives both in dollars. Surface the cost to the user when greater than zero. `resource`, when present (also sent as a resource link), reads this photo\'s registry record later for free; a `pt_test_` result for a URL has none. `receipts` may be empty; `warnings` then names why (`RECEIPT_UNAVAILABLE`, `RECEIPT_NONE_STORED`, or a `RECEIPT_NOT_ISSUED_*` code). Today only `pt_test_` keys receive receipts, so a `pt_live_` key gets `RECEIPT_UNAVAILABLE` on a fresh analyze and `RECEIPT_NONE_STORED` on a registry hit.',
        '',
        'Test vs live: a `pt_test_` key returns deterministic golden-fixture data, not a real analysis: `livemode` is `false`, `usage.creditsCharged` is `0`, `meta.provider` is `test-sandbox`, and the same payload comes back regardless of the image. Treat `livemode: false` output as an integration/wiring check, never as facts about the actual photo. A `pt_live_` key returns real model output with `livemode: true`.',
        '',
        'Out of credits: returns an error whose first text line is JSON with `code: "OUT_OF_CREDITS"` and `actionUrl`, a wallet deep-link. Show the URL to the user verbatim. Do not retry the call.',
      ].join('\n'),
      inputSchema: AnalyzeInputSchema,
      outputSchema: AnalyzePhotoOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ imageUrl, imageBase64, imagePath, stack, preset, lenses, modules, includeEmbedding, refresh }: AnalyzeArgs) => {
      try {
        // Refinement: exactly one image input mode. Empty strings count as "not provided".
        const inputCount = [imageUrl, imageBase64, imagePath].filter(
          (v) => v !== undefined && v !== '',
        ).length;
        if (inputCount === 0) {
          throw new LocalImageError(
            'UNSUPPORTED_FORMAT',
            'analyze_photo requires exactly one of: imageUrl, imageBase64, imagePath.',
          );
        }
        if (inputCount > 1) {
          throw new LocalImageError(
            'UNSUPPORTED_FORMAT',
            'analyze_photo accepts exactly one of imageUrl, imageBase64, imagePath. Multiple were provided.',
          );
        }

        // Resolve local input modes to base64. imageUrl is forwarded as-is.
        let resolvedBase64: string | undefined;
        // Set only when a symlinked folder led somewhere else, so the caller sees what was read.
        let resolvedPath: string | undefined;
        if (imagePath) {
          const local = readLocalImage(resolvePath(imagePath));
          resolvedBase64 = local.bytes.toString('base64');
          if (local.viaSymlink) resolvedPath = local.resolvedPath;
        } else if (imageBase64) {
          validateBase64(imageBase64);
          resolvedBase64 = imageBase64;
        }

        // Agents may pass `lenses` (preferred) or `modules` (deprecated alias),
        // and `stack` (preferred) or `preset` (deprecated alias). The SDK + API
        // still expect `modules` and `preset`; we translate here so the rename
        // lives entirely at the MCP surface.
        const chosenLenses = lenses ?? modules;
        const chosenStack = preset ?? stack;
        const result = await client.analyze({
          ...(imageUrl ? { imageUrl } : { imageBase64: resolvedBase64 }),
          ...(chosenLenses ? { modules: chosenLenses } : { preset: chosenStack }),
          // A live fingerprint names the photo in the result and its resource link.
          options: { includeEmbedding, includeFingerprint: true },
          ...(refresh !== undefined ? { refresh } : {}),
        });
        const sha256 = analyzedPhotoSha256(result, resolvedBase64);
        const base = toAnalyzeEnvelope(result, sha256);
        const envelope = resolvedPath ? { ...base, resolvedPath } : base;
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(envelope, null, 2) },
            ...(sha256 ? [photoResourceLink(sha256)] : []),
          ],
          structuredContent: envelope,
        };
      } catch (err: unknown) {
        return renderToolError(err);
      }
    },
  );
}
