import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  resolvePath,
  readImage,
  computeSha256,
  expandGlobs,
  validateBase64,
  LocalImageError,
} from '../src/lib/local-image';

describe('resolvePath', () => {
  it('returns absolute paths unchanged', () => {
    expect(resolvePath('/Users/alice/photo.jpg')).toBe('/Users/alice/photo.jpg');
  });

  it('expands ~/ to the current user home', () => {
    const expected = path.join(os.homedir(), 'photos/portrait.jpg');
    expect(resolvePath('~/photos/portrait.jpg')).toBe(expected);
  });

  it('rejects relative paths', () => {
    expect(() => resolvePath('photos/portrait.jpg')).toThrow(LocalImageError);
    try {
      resolvePath('photos/portrait.jpg');
    } catch (err) {
      expect((err as LocalImageError).code).toBe('RELATIVE_PATH_REJECTED');
    }
  });

  it('rejects ~user/ bash-style other-home expansion', () => {
    expect(() => resolvePath('~alice/photo.jpg')).toThrow(LocalImageError);
    try {
      resolvePath('~alice/photo.jpg');
    } catch (err) {
      expect((err as LocalImageError).code).toBe('RELATIVE_PATH_REJECTED');
    }
  });

  it('rejects bare ~ with no slash', () => {
    expect(() => resolvePath('~')).toThrow(LocalImageError);
  });

  it('rejects empty string', () => {
    expect(() => resolvePath('')).toThrow(LocalImageError);
  });
});

describe('readImage', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-local-image-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Minimal valid JPEG magic bytes: FF D8 FF E0 + JFIF marker + tiny payload
  const JPEG_BYTES = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
  ]);
  // PNG magic: 89 50 4E 47 0D 0A 1A 0A
  const PNG_BYTES = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk header
  ]);

  it('reads a valid JPEG file', () => {
    const filePath = path.join(tmpDir, 'tiny.jpg');
    fs.writeFileSync(filePath, JPEG_BYTES);
    const bytes = readImage(filePath);
    expect(bytes).toEqual(JPEG_BYTES);
  });

  it('reads a valid PNG file', () => {
    const filePath = path.join(tmpDir, 'tiny.png');
    fs.writeFileSync(filePath, PNG_BYTES);
    const bytes = readImage(filePath);
    expect(bytes).toEqual(PNG_BYTES);
  });

  it('throws FILE_NOT_FOUND for missing files', () => {
    expect(() => readImage(path.join(tmpDir, 'missing.jpg'))).toThrow(LocalImageError);
    try {
      readImage(path.join(tmpDir, 'missing.jpg'));
    } catch (err) {
      expect((err as LocalImageError).code).toBe('FILE_NOT_FOUND');
    }
  });

  it('throws FILE_TOO_LARGE for files over 10MB', () => {
    const bigPath = path.join(tmpDir, 'big.jpg');
    // 10MB + 1 byte. First 4 bytes are JPEG magic so format check passes.
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    JPEG_BYTES.copy(big);
    fs.writeFileSync(bigPath, big);
    try {
      readImage(bigPath);
      fail('expected throw');
    } catch (err) {
      expect((err as LocalImageError).code).toBe('FILE_TOO_LARGE');
      expect((err as LocalImageError).sizeBytes).toBe(10 * 1024 * 1024 + 1);
    }
  });

  it('throws UNSUPPORTED_FORMAT for random bytes', () => {
    const trashPath = path.join(tmpDir, 'trash.bin');
    fs.writeFileSync(trashPath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]));
    try {
      readImage(trashPath);
      fail('expected throw');
    } catch (err) {
      expect((err as LocalImageError).code).toBe('UNSUPPORTED_FORMAT');
    }
  });

  it('rejects symbolic links', () => {
    const realFile = path.join(tmpDir, 'real.jpg');
    fs.writeFileSync(realFile, JPEG_BYTES);
    const linkPath = path.join(tmpDir, 'link.jpg');
    fs.symlinkSync(realFile, linkPath);
    try {
      readImage(linkPath);
      fail('expected throw');
    } catch (err) {
      expect((err as LocalImageError).code).toBe('SYMLINK_REJECTED');
    }
  });
});

describe('computeSha256', () => {
  it('produces the canonical hex digest for known input', () => {
    // Known sha256 of empty buffer: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    expect(computeSha256(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('produces the canonical hex digest for "abc"', () => {
    expect(computeSha256(Buffer.from('abc', 'utf8'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('validateBase64', () => {
  it('accepts valid base64', () => {
    expect(() => validateBase64('SGVsbG8gV29ybGQ=')).not.toThrow();
    expect(() => validateBase64('YWFh')).not.toThrow();
  });

  it('rejects empty string', () => {
    try {
      validateBase64('');
      fail('expected throw');
    } catch (err) {
      expect((err as LocalImageError).code).toBe('INVALID_BASE64');
    }
  });

  it('rejects strings with non-base64 chars', () => {
    try {
      validateBase64('hello world!');
      fail('expected throw');
    } catch (err) {
      expect((err as LocalImageError).code).toBe('INVALID_BASE64');
    }
  });

  it('rejects strings with bad length mod 4', () => {
    try {
      validateBase64('SGVsbG8gV29yb');  // length 13, not 0 mod 4
      fail('expected throw');
    } catch (err) {
      expect((err as LocalImageError).code).toBe('INVALID_BASE64');
    }
  });
});

describe('expandGlobs', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-glob-test-'));
    // Build a small fixture tree
    fs.writeFileSync(path.join(tmpDir, 'a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    fs.writeFileSync(path.join(tmpDir, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    fs.writeFileSync(path.join(tmpDir, 'c.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(tmpDir, 'doc.txt'), Buffer.from('hello'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('expands a simple glob to matching files', () => {
    const result = expandGlobs([`${tmpDir}/*.jpg`]);
    expect(result.sort()).toEqual([
      path.join(tmpDir, 'a.jpg'),
      path.join(tmpDir, 'b.jpg'),
    ].sort());
  });

  it('passes through literal paths', () => {
    const literal = path.join(tmpDir, 'c.png');
    const result = expandGlobs([literal]);
    expect(result).toEqual([literal]);
  });

  it('combines globs and literals; deduplicates', () => {
    const literal = path.join(tmpDir, 'a.jpg');
    const result = expandGlobs([literal, `${tmpDir}/*.jpg`]);
    expect(result.sort()).toEqual([
      path.join(tmpDir, 'a.jpg'),
      path.join(tmpDir, 'b.jpg'),
    ].sort());
  });

  it('returns empty array for a glob with no matches (does not throw)', () => {
    const result = expandGlobs([`${tmpDir}/*.tiff`]);
    expect(result).toEqual([]);
  });

  it('expands ~/ in glob patterns', () => {
    // Just verify it doesn't throw and the expansion happens. We can't easily
    // assert specific paths without polluting the real home dir.
    expect(() => expandGlobs(['~/nonexistent-test-pattern-*'])).not.toThrow();
  });

  it('throws GLOB_TOO_LARGE when total expansion exceeds 200', () => {
    const manyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-many-test-'));
    for (let i = 0; i < 205; i++) {
      fs.writeFileSync(path.join(manyDir, `f${i}.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    }
    try {
      expandGlobs([`${manyDir}/*.jpg`]);
      fail('expected throw');
    } catch (err) {
      expect((err as LocalImageError).code).toBe('GLOB_TOO_LARGE');
    } finally {
      fs.rmSync(manyDir, { recursive: true, force: true });
    }
  });
});
