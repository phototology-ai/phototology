import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PhototologyClient } from '@phototology/sdk';
import { renderToolError } from './errors';
import { readLocalImage, resolvePath, validateBase64, assertWritableOutput, writeOutputFile, LocalImageError } from '../lib/local-image';
import { toEnrichEnvelope } from '../lib/envelope';
import { makePreview } from '../lib/preview';
import { EnrichPhotoOutputSchema, type EnrichPhotoOutput } from '../schemas';

/**
 * enrich_photo MCP tool (item-048).
 *
 * Writes cached lens output into the EXIF/IPTC/XMP metadata blocks of an
 * enriched copy of a photo (the original is never written) so the structured intelligence travels with the file. The photo
 * MUST have been analyzed before (the registry has a lens projection for
 * this account + sha256); otherwise the tool surfaces PHOTO_NOT_IN_REGISTRY.
 *
 * Composition pattern: agents call this AFTER analyze_photo / analyze_batch
 * for any photo they want to be self-describing downstream — once enriched,
 * the photo doesn't need Phototology to surface its lens output (any photo
 * app that reads EXIF/IPTC/XMP can).
 */

const EnrichInputSchema = {
  imageUrl: z.string().url().optional()
    .describe('Publicly fetchable image URL. Server fetches, computes sha256, looks up the registry, writes the enriched bytes, and returns them as base64.'),
  imageBase64: z.string().optional()
    .describe('Base64-encoded image bytes (no data: URL prefix). Keep it under about 150 KB; for larger files prefer imageUrl or imagePath.'),
  imagePath: z.string().optional()
    .describe('Absolute local-filesystem path on the machine running the MCP server. The MCP reads the file and forwards bytes. Accepts absolute (/Users/...) or ~/-prefixed paths.'),
  formats: z.array(z.enum(['exif', 'iptc', 'xmp'])).optional()
    .describe('Which metadata blocks to write. Defaults to ["xmp"], the smallest and most portable. Use ["exif", "iptc", "xmp"] to write all three. c2pa signing is deferred to a future release.'),
  outputPath: z.string().optional()
    .describe('Optional absolute local-filesystem path where the enriched copy is saved. Accepts absolute or ~/-prefixed paths. When provided, the tool writes the enriched bytes to this path and returns savedTo instead of imageBase64, so agents can enrich a local file without handling base64 themselves. This is always a new file: the original photo is never written. When omitted, the response carries the enriched bytes as imageBase64. Refuses an existing file unless overwrite is true, and always refuses the input file itself.'),
  overwrite: z.boolean().optional()
    .describe('Allow outputPath to replace an existing file. Defaults to false. Never permits writing over the input file (imagePath), even when true.'),
};

interface EnrichArgs {
  imageUrl?: string;
  imageBase64?: string;
  imagePath?: string;
  formats?: ('exif' | 'iptc' | 'xmp')[];
  outputPath?: string;
  overwrite?: boolean;
}

export function registerEnrichPhoto(server: McpServer, client: PhototologyClient): void {
  // Cast: MCP SDK's registerTool generics hit TS2589 with complex Zod schemas.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = server as any;

  s.registerTool(
    'enrich_photo',
    {
      title: 'Write analysis into a copy of the photo',
      description: [
        'Write cached lens output into the EXIF/IPTC/XMP metadata blocks of an enriched copy of the photo. The original is never written: the copy comes back as base64, or is saved to a new `outputPath`. The photo must have been analyzed before (analyze_photo or analyze_batch). Never overwrites an existing file unless you pass `overwrite: true`, and never writes over the input file.',
        '',
        'The enriched photo carries its structured intelligence in standard metadata fields any downstream tool can read. No Phototology API call is needed to access the analysis after enrichment. Useful when handing a photo off to another app or archiving it.',
        '',
        'Cost: 5 credits per call. Bills regardless of cache state; writing the enriched copy is its own billable operation.',
        '',
        'For local files, the optional `outputPath` parameter saves the enriched copy to that new path so you don\'t have to handle the base64 yourself. Without it, the tool returns the enriched bytes as `imageBase64`. Base64 input over about 150 KB is discouraged; pass `imageUrl` or `imagePath` instead.',
        '',
        'Returns `{ mode, savedTo?, imageBase64?, sidecar?, formatsWritten, lensVersions, sha256, registryId?, credentials?, reason?, usage: { creditsCharged, usd: { charged } }, warnings?, meta?, resolvedPath? }`. `mode` is `file` when the metadata went into the image bytes, or `sidecar` when the API left the file untouched and returned an XMP packet in `sidecar.xmp` instead (`reason` says why). `usage.creditsCharged` is the credits this call spent and `usage.usd.charged` its dollar value (e.g. "0.05"). `warnings` is present when the preview could not be made. `meta` is the API\'s request metadata (request id, timing). `resolvedPath` is present only when a symlinked folder led to a different file than the one named.',
        '',
        'When the result has image bytes, it also carries an `image` content block: a JPEG preview of the enriched photo, longest edge at most 1024 px, so you can see the photo without loading the full-resolution bytes.',
        '',
        'If the photo has not been analyzed before, returns a PHOTO_NOT_IN_REGISTRY error. Call `analyze_photo` first, then `enrich_photo`.',
      ].join('\n'),
      inputSchema: EnrichInputSchema,
      outputSchema: EnrichPhotoOutputSchema,
      annotations: {
        readOnlyHint: false, // writes bytes (returned or saved to disk)
        destructiveHint: false, // refuses existing outputs unless overwrite: true; never the input file
        idempotentHint: true, // same inputs → same enriched bytes
        openWorldHint: true,
      },
    },
    async ({ imageUrl, imageBase64, imagePath, formats, outputPath, overwrite }: EnrichArgs) => {
      try {
        // Refinement: exactly one image input mode.
        const inputCount = [imageUrl, imageBase64, imagePath].filter(
          (v) => v !== undefined && v !== '',
        ).length;
        if (inputCount === 0) {
          throw new LocalImageError(
            'UNSUPPORTED_FORMAT',
            'enrich_photo requires exactly one of: imageUrl, imageBase64, imagePath.',
          );
        }
        if (inputCount > 1) {
          throw new LocalImageError(
            'UNSUPPORTED_FORMAT',
            'enrich_photo accepts exactly one of imageUrl, imageBase64, imagePath. Multiple were provided.',
          );
        }

        const requestedFormats = formats ?? ['xmp'];

        // Resolve local input modes to base64.
        let resolvedBase64: string | undefined;
        let resolvedInputPath: string | undefined;
        // Set only when a symlinked folder led somewhere else, so the caller sees what was read.
        let resolvedPath: string | undefined;
        if (imagePath) {
          const abs = resolvePath(imagePath);
          resolvedInputPath = abs;
          const local = readLocalImage(abs);
          resolvedBase64 = local.bytes.toString('base64');
          if (local.viaSymlink) resolvedPath = local.resolvedPath;
        } else if (imageBase64) {
          validateBase64(imageBase64);
          resolvedBase64 = imageBase64;
        }

        // Validate outputPath early, before spending credits: inside the allowed
        // folders, destination directory exists, not the input file, and an
        // existing file is only replaced with overwrite: true.
        let resolvedOutputPath: string | undefined;
        // Where the bytes really go (the folder's real path plus the file name); writes use only this.
        let writeTarget: string | undefined;
        if (outputPath) {
          resolvedOutputPath = resolvePath(outputPath);
          writeTarget = assertWritableOutput(resolvedInputPath, resolvedOutputPath, overwrite === true);
        }

        const result = await client.enrich({
          ...(imageUrl ? { imageUrl } : { imageBase64: resolvedBase64 }),
          formats: requestedFormats,
        });

        const enrichedBytes = result.imageBase64 ? Buffer.from(result.imageBase64, 'base64') : undefined;
        // Sidecar mode carries no bytes, so there is nothing to write to outputPath.
        const savedTo = enrichedBytes && resolvedOutputPath && writeTarget ? resolvedOutputPath : undefined;
        if (savedTo && writeTarget && enrichedBytes) {
          // Refuses (never replaces) a file that appeared during the enrich call unless overwrite.
          writeOutputFile(writeTarget, enrichedBytes, overwrite === true);
        }

        const base = toEnrichEnvelope(result, { keepBytes: !resolvedOutputPath, savedTo });
        const envelope: EnrichPhotoOutput = resolvedPath ? { ...base, resolvedPath } : base;

        // The preview is a convenience: a decode failure, or sharp failing to
        // load, never fails the paid call; it becomes a warning beside the result.
        let preview: { data: string; mimeType: 'image/jpeg' } | undefined;
        if (enrichedBytes) {
          try {
            preview = await makePreview(enrichedBytes);
          } catch (previewErr: unknown) {
            const why = previewErr instanceof Error ? previewErr.message : String(previewErr);
            envelope.warnings = [`No preview: the preview could not be made (${why}).`];
          }
        }

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(envelope, null, 2) },
            ...(preview ? [{ type: 'image' as const, data: preview.data, mimeType: preview.mimeType }] : []),
          ],
          structuredContent: envelope,
        };
      } catch (err: unknown) {
        return renderToolError(err);
      }
    },
  );
}
