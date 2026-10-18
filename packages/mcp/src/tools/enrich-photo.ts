import * as fs from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PhototologyClient, EnrichResponse } from '@phototology/sdk';
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
 * Sidecar mode (row 3): when the photo carries a valid or trusted content
 * credential, the API returns `mode: 'sidecar'` with an XMP packet instead of
 * enriched bytes, because writing into the file would break the credential.
 * With `imagePath` the packet is saved as `<imagePath>.xmp` beside the
 * original, under the same write rules as `outputPath` (allow-list,
 * O_NOFOLLOW, never the input, `overwrite`); otherwise it is returned inline.
 * An existing `<imagePath>.xmp` (darktable and digiKam write one by default)
 * does not stop the call, since most photos carry no credential and get a
 * copy; if a sidecar comes back, that file is left alone (unless `overwrite`)
 * and the packet is returned inline. `breakCredentials: true` sends
 * `preserveCredentials: false` to force a copy; the field is always sent,
 * because the API treats a request without it as a client that cannot read a sidecar.
 *
 * Composition pattern: agents call this AFTER analyze_photo / analyze_batch
 * for any photo they want to be self-describing downstream. Once enriched,
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
    .describe('Allow outputPath, or the <imagePath>.xmp sidecar, to replace an existing file. Defaults to false. Never permits writing over the input file (imagePath), even when true.'),
  breakCredentials: z.boolean().optional()
    .describe('Write the enriched copy even when the photo carries a valid content credential. Pass true only if the user accepts that the written copy loses its content credential. By default the analysis goes into a sidecar file next to the photo and the photo is left untouched. When true, the result warns CREDENTIAL_INVALIDATED.'),
};

interface EnrichArgs {
  imageUrl?: string;
  imageBase64?: string;
  imagePath?: string;
  formats?: ('exif' | 'iptc' | 'xmp')[];
  outputPath?: string;
  overwrite?: boolean;
  breakCredentials?: boolean;
}

const SIDECAR_LABEL = 'sidecar path';
const BROKE_NOTE = "This write broke the photo's content credential because breakCredentials was true.";
const UNREAD_NOTE = "The photo's content credential could not be read in time, so this copy was written without checking for one. " +
  'If the photo carries a content credential, this copy does not keep it.';

/** A plain-words note for a copy when the API warned CREDENTIAL_INVALIDATED or CREDENTIALS_UNREAD (warnings, not errors). */
function copyNote(result: EnrichResponse): { note?: string } {
  const notes = [
    ...(result.warnings?.includes('CREDENTIAL_INVALIDATED') ? [BROKE_NOTE] : []),
    ...(result.warnings?.includes('CREDENTIALS_UNREAD') ? [UNREAD_NOTE] : []),
  ];
  return notes.length > 0 ? { note: notes.join(' ') } : {};
}

/** Plain-words note for a sidecar result: what was left alone, why, and where the metadata went. */
function sidecarNote(where: string, outputPath: string | undefined): string {
  const skipped = outputPath ? ` No copy was written to ${outputPath}.` : '';
  return "The photo was left untouched because writing into it would break the photo's content credential. " +
    `The analysis was ${where} as an XMP sidecar instead.${skipped}`;
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
        'Returns `{ mode, savedTo?, sidecarSavedTo?, imageBase64?, sidecar?, formatsWritten, lensVersions, sha256, registryId?, credentials?, reason?, note?, usage: { creditsCharged, usd: { charged } }, warnings?, meta?, resolvedPath? }`. `mode` is `file` when the metadata went into the image bytes, or `sidecar` when the API left the file untouched and returned an XMP packet instead (`reason` says why): `sidecarSavedTo` names the `.xmp` file it was saved to, otherwise the packet is in `sidecar.xmp`. `credentials` is what the API read from the photo\'s content credential. `note` says in plain words why the photo was left untouched, or what a copy lost. `usage.creditsCharged` is the credits this call spent and `usage.usd.charged` its dollar value (e.g. "0.05"). `warnings` carries the API\'s `CREDENTIAL_INVALIDATED` or `CREDENTIALS_UNREAD`, and a line when the preview could not be made. `meta` is the API\'s request metadata (request id, timing). `resolvedPath` is present only when a symlinked folder led to a different file than the one named.',
        '',
        'When the result has image bytes, it also carries an `image` content block: a JPEG preview of the enriched photo, longest edge at most 1024 px, so you can see the photo without loading the full-resolution bytes.',
        '',
        'If the photo carries a valid content credential, writing the analysis into the file would break its content credential, so the tool leaves the photo untouched and returns the analysis as an XMP sidecar instead. With `imagePath`, the sidecar is saved beside the original as `<imagePath>.xmp` (same overwrite rules as `outputPath`); otherwise it comes back as `sidecar.xmp`. Pass `breakCredentials: true` to write the copy anyway. Billed the same either way.',
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
    async ({ imageUrl, imageBase64, imagePath, formats, outputPath, overwrite, breakCredentials }: EnrichArgs) => {
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
        // The answer may be a sidecar at <imagePath>.xmp, so check that path's structure before
        // spending credits: allow-list, folder, symlink, never the input. An existing file there does
        // not stop the call (photo editors write one beside every photo, and most photos get a copy);
        // it is handled only if a sidecar comes back. Skipped with breakCredentials: no sidecar can come back.
        const sidecarPath = resolvedInputPath && breakCredentials !== true ? `${resolvedInputPath}.xmp` : undefined;
        const sidecarTarget = sidecarPath
          ? assertWritableOutput(resolvedInputPath, sidecarPath, true, SIDECAR_LABEL)
          : undefined;

        const result = await client.enrich({
          ...(imageUrl ? { imageUrl } : { imageBase64: resolvedBase64 }),
          formats: requestedFormats,
          preserveCredentials: breakCredentials !== true,
        });

        if (result.mode === 'sidecar') {
          const xmp = result.sidecar?.xmp;
          if (xmp === undefined) {
            throw new Error('The API answered in sidecar mode without an XMP packet. The photo was left untouched; nothing was saved.');
          }
          // No image in sidecar mode, so no preview. The envelope carries the packet inline until it is saved.
          const base: EnrichPhotoOutput = toEnrichEnvelope(result, { keepBytes: false });
          const where = resolvedPath ? { resolvedPath } : {};
          if (sidecarPath && sidecarTarget) {
            // Beside the original, checked before the call; the original itself is never opened for writing.
            try {
              if (overwrite !== true && fs.existsSync(sidecarTarget)) {
                throw new LocalImageError(
                  'OUTPUT_EXISTS',
                  `${SIDECAR_LABEL} ${sidecarPath} already exists, so it was left untouched. Pass overwrite: true to replace it.`,
                  { path: sidecarPath },
                );
              }
              // O_EXCL still refuses a file that appears between the check above and this open.
              writeOutputFile(sidecarTarget, Buffer.from(xmp, 'utf8'), overwrite === true, SIDECAR_LABEL);
            } catch (err: unknown) {
              if (!(err instanceof LocalImageError)) throw err;
              // Charged already: hand back the packet (text and structuredContent.sidecar) so the paid work is not lost.
              const failed = {
                error: {
                  code: err.code,
                  message: `The sidecar was not saved: ${err.message} The XMP packet is returned below as sidecar.xmp.`,
                  path: sidecarPath,
                },
                ...base,
                note: sidecarNote('returned below', resolvedOutputPath),
                ...where,
              };
              return {
                content: [{ type: 'text' as const, text: JSON.stringify(failed, null, 2) }],
                structuredContent: failed,
                isError: true as const,
              };
            }
            // Saved: the packet lives in the file now, so it is not repeated inline.
            const { sidecar: _saved, ...rest } = base;
            const savedEnvelope: EnrichPhotoOutput = {
              ...rest,
              sidecarSavedTo: sidecarPath,
              note: sidecarNote(`saved beside it at ${sidecarPath}`, resolvedOutputPath),
              ...where,
            };
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(savedEnvelope, null, 2) }],
              structuredContent: savedEnvelope,
            };
          }
          const inlineEnvelope: EnrichPhotoOutput = {
            ...base,
            note: sidecarNote('returned in sidecar.xmp', resolvedOutputPath),
            ...where,
          };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(inlineEnvelope, null, 2) }],
            structuredContent: inlineEnvelope,
          };
        }

        if (result.imageBase64 === undefined) {
          throw new Error('The API answered without the enriched copy. Nothing was saved.');
        }

        const enrichedBytes = Buffer.from(result.imageBase64, 'base64');
        const savedTo = resolvedOutputPath && writeTarget ? resolvedOutputPath : undefined;
        if (savedTo && writeTarget) {
          // Refuses (never replaces) a file that appeared during the enrich call unless overwrite.
          writeOutputFile(writeTarget, enrichedBytes, overwrite === true);
        }

        const base = toEnrichEnvelope(result, { keepBytes: !resolvedOutputPath, savedTo });
        const envelope: EnrichPhotoOutput = {
          ...base,
          ...copyNote(result),
          ...(resolvedPath ? { resolvedPath } : {}),
        };

        // The preview is a convenience: a decode failure, or sharp failing to
        // load, never fails the paid call; it becomes a warning beside the result.
        let preview: { data: string; mimeType: 'image/jpeg' } | undefined;
        try {
          preview = await makePreview(enrichedBytes);
        } catch (previewErr: unknown) {
          const why = previewErr instanceof Error ? previewErr.message : String(previewErr);
          envelope.warnings = [...(envelope.warnings ?? []), `No preview: the preview could not be made (${why}).`];
        }

        // registryId (passed through from the API, present only when the write
        // stored it): the id in the file's XMP, which lookup_photo reads back.
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
