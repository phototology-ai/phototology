/**
 * The downscaled preview `enrich_photo` returns as an `image` content block
 * (spec §10.3), so an agent can see the photo it just enriched without
 * pulling full-resolution bytes into its context.
 *
 * sharp is a native module, so it loads lazily on the first preview: a binary
 * that fails to load on the user's machine costs only the preview (the caller
 * turns the rejection into a warning), never the server's startup.
 */

/** Longest edge of the preview, in pixels. Smaller inputs are never upscaled. */
export const PREVIEW_MAX_EDGE = 1024;
/** JPEG quality of the preview. */
export const PREVIEW_QUALITY = 80;

/**
 * Decode `bytes`, apply its EXIF orientation, shrink the longest edge to
 * 1024 px (never enlarging), and re-encode as JPEG quality 80. Rejects when
 * sharp cannot load or the bytes are not a decodable image.
 */
export async function makePreview(bytes: Buffer): Promise<{ data: string; mimeType: 'image/jpeg' }> {
  const { default: sharp } = await import('sharp');
  const jpeg = await sharp(bytes)
    .rotate()
    .resize({ width: PREVIEW_MAX_EDGE, height: PREVIEW_MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: PREVIEW_QUALITY })
    .toBuffer();
  return { data: jpeg.toString('base64'), mimeType: 'image/jpeg' };
}
