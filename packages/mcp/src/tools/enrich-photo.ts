import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PhototologyClient } from '@phototology/sdk';
import { renderToolError } from './errors';
import { readImage, resolvePath, validateBase64, LocalImageError } from '../lib/local-image';

/**
 * enrich_photo MCP tool (item-048).
 *
 * Writes cached lens output back into a photo's EXIF/IPTC/XMP metadata
 * blocks so the structured intelligence travels with the file. The photo
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
    .describe('Base64-encoded image bytes (no data: URL prefix). Useful for small images; for large files prefer imageUrl or imagePath.'),
  imagePath: z.string().optional()
    .describe('Absolute local-filesystem path on the machine running the MCP server. The MCP reads the file and forwards bytes. Accepts absolute (/Users/...) or ~/-prefixed paths.'),
  formats: z.array(z.enum(['exif', 'iptc', 'xmp'])).optional()
    .describe('Which metadata blocks to write. Defaults to ["xmp"] — smallest and most portable. Use ["exif", "iptc", "xmp"] to write all three. c2pa signing is deferred to a future release.'),
  outputPath: z.string().optional()
    .describe('Optional absolute local-filesystem path to write the enriched photo back to disk. Accepts absolute or ~/-prefixed paths. When provided, the tool writes the enriched bytes to this path and returns { savedTo, formatsWritten, lensVersions, creditsCharged } — agents can use this to enrich-in-place without handling base64 themselves. When omitted, the response carries the enriched bytes as imageBase64.'),
};

interface EnrichArgs {
  imageUrl?: string;
  imageBase64?: string;
  imagePath?: string;
  formats?: ('exif' | 'iptc' | 'xmp')[];
  outputPath?: string;
}

export function registerEnrichPhoto(server: McpServer, client: PhototologyClient): void {
  // Cast: MCP SDK's registerTool generics hit TS2589 with complex Zod schemas.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s = server as any;

  s.registerTool(
    'enrich_photo',
    {
      description: [
        'Write cached lens output back into the image file\'s EXIF/IPTC/XMP metadata blocks. The photo must have been analyzed before (analyze_photo or analyze_batch).',
        '',
        'The enriched photo carries its structured intelligence in standard metadata fields any downstream tool can read — no Phototology API call needed to access the analysis after enrichment. Useful when handing a photo off to another app or archiving it.',
        '',
        'Cost: 5 credits per call. Bills regardless of cache state — the write-back work is its own billable operation.',
        '',
        'For local files, the optional `outputPath` parameter writes the enriched bytes back to disk so you don\'t have to handle the base64 yourself. Without it, the tool returns the enriched bytes as `imageBase64`.',
        '',
        'If the photo has not been analyzed before, returns a PHOTO_NOT_IN_REGISTRY error. Call `analyze_photo` first, then `enrich_photo`.',
      ].join('\n'),
      inputSchema: EnrichInputSchema,
      annotations: {
        readOnlyHint: false, // writes bytes (returned or saved to disk)
        destructiveHint: false, // never destroys; creates a new enriched file
        idempotentHint: true, // same inputs → same enriched bytes
        openWorldHint: true,
      },
    },
    async ({ imageUrl, imageBase64, imagePath, formats, outputPath }: EnrichArgs) => {
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
        if (imagePath) {
          const abs = resolvePath(imagePath);
          const bytes = readImage(abs);
          resolvedBase64 = bytes.toString('base64');
        } else if (imageBase64) {
          validateBase64(imageBase64);
          resolvedBase64 = imageBase64;
        }

        // Validate outputPath early — fail before spending credits if the
        // destination directory is missing.
        let resolvedOutputPath: string | undefined;
        if (outputPath) {
          resolvedOutputPath = resolvePath(outputPath);
          const dir = path.dirname(resolvedOutputPath);
          if (!fs.existsSync(dir)) {
            throw new LocalImageError(
              'FILE_NOT_FOUND',
              `outputPath directory does not exist: ${dir}`,
              { path: dir },
            );
          }
        }

        const result = await client.enrich({
          ...(imageUrl ? { imageUrl } : { imageBase64: resolvedBase64 }),
          formats: requestedFormats,
        });

        if (resolvedOutputPath) {
          // Write enriched bytes to disk; respond with savedTo metadata.
          const enrichedBytes = Buffer.from(result.imageBase64, 'base64');
          fs.writeFileSync(resolvedOutputPath, enrichedBytes);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                savedTo: resolvedOutputPath,
                formatsWritten: result.formatsWritten,
                lensVersions: result.lensVersions,
                sha256: result.sha256,
                creditsCharged: result.meta.creditsCharged,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err: unknown) {
        return renderToolError(err);
      }
    },
  );
}
