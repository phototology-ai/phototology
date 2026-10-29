/**
 * makePreview: the downscaled JPEG enrich_photo returns as an `image` block.
 * Longest edge 1024 px, never upscaled, EXIF orientation applied, quality 80.
 */
import sharp from 'sharp';
import { makePreview } from '../src/lib/preview';

/** A JPEG with a smooth gradient, so its size is realistic rather than trivially small. */
async function gradientJpeg(width: number, height: number, orientation?: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[i] = Math.floor((x / width) * 255);
      raw[i + 1] = Math.floor((y / height) * 255);
      raw[i + 2] = (x + y) % 256;
    }
  }
  let img = sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 });
  if (orientation) img = img.withMetadata({ orientation });
  return img.toBuffer();
}

describe('makePreview', () => {
  it('downscales a 3000x2000 JPEG to 1024x683, under 300 KB', async () => {
    const preview = await makePreview(await gradientJpeg(3000, 2000));
    expect(preview.mimeType).toBe('image/jpeg');
    const bytes = Buffer.from(preview.data, 'base64');
    const meta = await sharp(bytes).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(683);
    expect(bytes.length).toBeLessThan(300 * 1024);
  }, 30_000); // image work: slow on shared CI runners

  it('does not upscale a 400x300 input', async () => {
    const preview = await makePreview(await gradientJpeg(400, 300));
    const meta = await sharp(Buffer.from(preview.data, 'base64')).metadata();
    expect(meta.width).toBe(400);
    expect(meta.height).toBe(300);
  });

  it('applies EXIF orientation, so a rotated photo previews upright', async () => {
    // Orientation 6 = rotate 90 degrees clockwise to display.
    const preview = await makePreview(await gradientJpeg(300, 200, 6));
    const meta = await sharp(Buffer.from(preview.data, 'base64')).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(300);
  });

  it('rejects bytes that are not an image', async () => {
    await expect(makePreview(Buffer.from('not an image'))).rejects.toThrow();
  });
});
