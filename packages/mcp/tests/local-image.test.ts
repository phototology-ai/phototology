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
  readLocalImage,
  resolveReal,
  assertInsideAllowedDirs,
  writeOutputFile,
  assertWritableOutput,
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
  // AVIF: ISO-BMFF ftyp box with brand "avif" (bytes 4-7 "ftyp", 8-11 "avif")
  const AVIF_BYTES = Buffer.from([
    0x00, 0x00, 0x00, 0x18, // box size
    0x66, 0x74, 0x79, 0x70, // "ftyp"
    0x61, 0x76, 0x69, 0x66, // "avif"
    0x00, 0x00, 0x00, 0x00, // minor version
  ]);
  // TIFF little-endian: "II*\0" (49 49 2A 00) + IFD offset
  const TIFF_BYTES = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
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

  // The backend's Sharp pipeline decodes AVIF + TIFF; the MCP gate must not be
  // stricter than the server (regression: 11 AVIFs bounced live 2026-06-01).
  it('reads a valid AVIF file', () => {
    const filePath = path.join(tmpDir, 'tiny.avif');
    fs.writeFileSync(filePath, AVIF_BYTES);
    const bytes = readImage(filePath);
    expect(bytes).toEqual(AVIF_BYTES);
  });

  it('reads a valid TIFF file', () => {
    const filePath = path.join(tmpDir, 'tiny.tiff');
    fs.writeFileSync(filePath, TIFF_BYTES);
    const bytes = readImage(filePath);
    expect(bytes).toEqual(TIFF_BYTES);
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
      // The error must stay actionable: list the accepted set + a conversion route.
      expect((err as LocalImageError).message).toContain('AVIF, TIFF');
      expect((err as LocalImageError).message).toContain('sips -s format jpeg');
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

  it('rejects oversized base64 (> 10MB) with FILE_TOO_LARGE, before the format check', () => {
    // ~15M chars is safely over the 10MB per-image cap (~13.98M base64 chars).
    // 'A' is a valid base64 char, so this proves the SIZE check fires first,
    // not the regex/mod-4 checks.
    const oversized = 'A'.repeat(15_000_000);
    try {
      validateBase64(oversized);
      fail('expected throw');
    } catch (err) {
      expect((err as LocalImageError).code).toBe('FILE_TOO_LARGE');
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

  it('refuses a relative glob before expanding it; an absolute glob still expands', () => {
    // A relative glob would expand from the server's working directory, which
    // varies by host, so it is refused like a relative literal path.
    const cwd = process.cwd();
    process.chdir(tmpDir); // a relative '*.jpg' would match a.jpg and b.jpg here
    try {
      for (const pattern of ['*.jpg', './*.jpg', '../*/*.jpg', '~other/*.jpg']) {
        expect(() => expandGlobs([pattern])).toThrow(
          expect.objectContaining({ code: 'RELATIVE_PATH_REJECTED' }),
        );
      }
    } finally {
      process.chdir(cwd);
    }
    expect(expandGlobs([`${tmpDir}/*.jpg`])).toHaveLength(2);
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

describe('real paths and PHOTOTOLOGY_MCP_ALLOWED_DIRS', () => {
  const JPEG = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
  ]);
  const ENV = 'PHOTOTOLOGY_MCP_ALLOWED_DIRS';
  let base: string;
  let savedEnv: string | undefined;

  function codeOf(fn: () => unknown): string | undefined {
    try {
      fn();
    } catch (err) {
      return (err as LocalImageError).code;
    }
    return undefined;
  }

  beforeAll(() => {
    // Real path of the temp root, so macOS's /var -> /private/var link never colors a result.
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-allowed-dirs-')));
    for (const d of ['a', 'a2', 'b', 'outside', 'real']) fs.mkdirSync(path.join(base, d));
    for (const d of ['a', 'a2', 'b', 'outside', 'real']) fs.writeFileSync(path.join(base, d, 'photo.jpg'), JPEG);
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'linked'));
    fs.symlinkSync(path.join(base, 'outside', 'photo.jpg'), path.join(base, 'a', 'escape.jpg'));
    fs.symlinkSync(path.join(base, 'outside'), path.join(base, 'a', 'escape-dir'));
  });

  beforeEach(() => {
    savedEnv = process.env[ENV];
    delete process.env[ENV];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('a file under a symlinked parent folder is read and reported with resolvedPath when no allow-list is set', () => {
    const viaLink = path.join(base, 'linked', 'photo.jpg');
    const real = path.join(base, 'real', 'photo.jpg');
    expect(resolveReal(viaLink)).toEqual({ resolved: real, viaSymlink: true });
    const out = readLocalImage(viaLink);
    expect(out.bytes.equals(JPEG)).toBe(true);
    expect(out.viaSymlink).toBe(true);
    expect(out.resolvedPath).toBe(real);
    // readImage keeps its Buffer-returning signature.
    expect(readImage(viaLink).equals(JPEG)).toBe(true);
  });

  test('a plain path reports viaSymlink false', () => {
    const plain = path.join(base, 'real', 'photo.jpg');
    expect(resolveReal(plain)).toEqual({ resolved: plain, viaSymlink: false });
    expect(readLocalImage(plain).viaSymlink).toBe(false);
  });

  test('resolveReal maps a missing file to FILE_NOT_FOUND', () => {
    expect(codeOf(() => resolveReal(path.join(base, 'real', 'missing.jpg')))).toBe('FILE_NOT_FOUND');
  });

  test('PHOTOTOLOGY_MCP_ALLOWED_DIRS=/a rejects /a2/photo.jpg with PATH_OUTSIDE_ALLOWED_DIRS', () => {
    process.env[ENV] = path.join(base, 'a');
    expect(codeOf(() => readImage(path.join(base, 'a2', 'photo.jpg')))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    expect(codeOf(() => assertInsideAllowedDirs(path.join(base, 'a2', 'photo.jpg')))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    // The folder itself and anything under it pass.
    expect(readImage(path.join(base, 'a', 'photo.jpg')).equals(JPEG)).toBe(true);
    expect(() => assertInsideAllowedDirs(path.join(base, 'a'))).not.toThrow();
  });

  test('PHOTOTOLOGY_MCP_ALLOWED_DIRS=/a rejects a symlink inside /a that resolves outside /a', () => {
    process.env[ENV] = path.join(base, 'a');
    expect(codeOf(() => readImage(path.join(base, 'a', 'escape.jpg')))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    expect(codeOf(() => readImage(path.join(base, 'a', 'escape-dir', 'photo.jpg')))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
  });

  test('a refusal names the path as given, never where an outside link points', () => {
    process.env[ENV] = path.join(base, 'a');
    let message = '';
    try {
      readImage(path.join(base, 'a', 'escape.jpg'));
    } catch (err) {
      message = (err as Error).message;
    }
    expect({
      namesGivenPath: message.includes(path.join(base, 'a', 'escape.jpg')),
      revealsLinkTarget: message.includes(path.join(base, 'outside')),
    }).toEqual({ namesGivenPath: true, revealsLinkTarget: false });
  });

  test('PHOTOTOLOGY_MCP_ALLOWED_DIRS with two entries accepts a file under the second', () => {
    process.env[ENV] = [path.join(base, 'a'), path.join(base, 'b')].join(path.delimiter);
    expect(readImage(path.join(base, 'b', 'photo.jpg')).equals(JPEG)).toBe(true);
    expect(codeOf(() => readImage(path.join(base, 'outside', 'photo.jpg')))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
  });

  test('an allow-list entry given through a symlink is resolved to its real path', () => {
    process.env[ENV] = path.join(base, 'linked');
    expect(readImage(path.join(base, 'real', 'photo.jpg')).equals(JPEG)).toBe(true);
  });

  test('an allow-list made only of unusable entries refuses everything instead of allowing everything', () => {
    process.env[ENV] = ['relative/dir', ''].join(path.delimiter);
    expect(codeOf(() => readImage(path.join(base, 'a', 'photo.jpg')))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
  });

  test('a blank PHOTOTOLOGY_MCP_ALLOWED_DIRS means no allow-list', () => {
    process.env[ENV] = '  ';
    expect(readImage(path.join(base, 'outside', 'photo.jpg')).equals(JPEG)).toBe(true);
  });

  test('a missing file outside the allowed folders answers PATH_OUTSIDE_ALLOWED_DIRS, not FILE_NOT_FOUND', () => {
    process.env[ENV] = path.join(base, 'a');
    expect(codeOf(() => readImage(path.join(base, 'outside', 'missing.jpg')))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    expect(codeOf(() => readImage(path.join(base, 'no-such-dir', 'deeper', 'missing.jpg')))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    // Inside the allowed folder, a missing file is still FILE_NOT_FOUND.
    expect(codeOf(() => readImage(path.join(base, 'a', 'missing.jpg')))).toBe('FILE_NOT_FOUND');
  });

  test('expandGlobs refuses a pattern whose fixed folder climbs out with .., and expands one inside', () => {
    process.env[ENV] = path.join(base, 'a');
    expect(codeOf(() => expandGlobs([path.join(base, 'a', '..', 'outside', '*.jpg')]))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    expect(expandGlobs([path.join(base, 'a', '*.jpg')])).toEqual([path.join(base, 'a', 'photo.jpg')]);
  });

  test('link/.. is resolved by the kernel, not lexically: a missing file reached that way outside is PATH_OUTSIDE_ALLOWED_DIRS', () => {
    fs.mkdirSync(path.join(base, 'outside', 'sub'), { recursive: true });
    if (!fs.existsSync(path.join(base, 'a', 'deep'))) fs.symlinkSync(path.join(base, 'outside', 'sub'), path.join(base, 'a', 'deep'));
    process.env[ENV] = path.join(base, 'a');
    const via = (name: string): string => `${path.join(base, 'a', 'deep')}/../${name}`;
    // a/missing.jpg lexically, outside/missing.jpg to the kernel.
    expect(codeOf(() => readImage(via('missing.jpg')))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    // a/photo.jpg lexically (it exists), outside/photo.jpg to the kernel.
    expect(codeOf(() => readImage(via('photo.jpg')))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    expect(resolveReal(via('photo.jpg')).resolved).toBe(path.join(base, 'outside', 'photo.jpg'));
    // A glob whose fixed part goes through the link and back up is refused whole.
    expect(codeOf(() => expandGlobs([via('*.jpg')]))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
  });

  test('under an allow-list, any .. segment is refused the same way whether the outside folder exists or not', () => {
    process.env[ENV] = path.join(base, 'a');
    const viaExisting = `${base}/outside/../a/photo.jpg`;
    const viaMissing = `${base}/no-such/x/../../a/photo.jpg`;
    expect(codeOf(() => readImage(viaExisting))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    expect(codeOf(() => readImage(viaMissing))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    expect(codeOf(() => readImage(`${base}/a/../a/photo.jpg`))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    expect(codeOf(() => expandGlobs([`${base}/no-such/../a/*.jpg`]))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    expect(codeOf(() => expandGlobs([`${base}\\outside\\..\\a/*.jpg`]))).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
  });

  test('without an allow-list, .. still resolves', () => {
    expect(readImage(`${base}/outside/../a/photo.jpg`).equals(JPEG)).toBe(true);
    expect(expandGlobs([`${base}/outside/../a/*.jpg`])).toHaveLength(1);
  });

  test('a final-component symlink inside an allowed folder that stays inside is still refused as a symlink', () => {
    fs.symlinkSync(path.join(base, 'a', 'photo.jpg'), path.join(base, 'a', 'inner-link.jpg'));
    process.env[ENV] = path.join(base, 'a');
    expect(codeOf(() => readImage(path.join(base, 'a', 'inner-link.jpg')))).toBe('SYMLINK_REJECTED');
  });
});

describe('writeOutputFile', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-write-output-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes a new file, refuses an existing one with OUTPUT_EXISTS, and replaces it only with overwrite', () => {
    const out = path.join(dir, 'out.jpg');
    writeOutputFile(out, Buffer.from('first'), false);
    expect(fs.readFileSync(out, 'utf8')).toBe('first');

    let caught: LocalImageError | undefined;
    try {
      writeOutputFile(out, Buffer.from('second'), false);
    } catch (err) {
      caught = err as LocalImageError;
    }
    expect(caught?.code).toBe('OUTPUT_EXISTS');
    expect(caught?.path).toBe(out);
    expect(caught?.message).toContain('This call was already charged');
    expect(fs.readFileSync(out, 'utf8')).toBe('first');

    writeOutputFile(out, Buffer.from('third'), true);
    expect(fs.readFileSync(out, 'utf8')).toBe('third');
  });

  test('refuses a symlink planted at outputPath after the pre-check, with or without overwrite', () => {
    const target = path.join(dir, 'link-target.jpg');
    const link = path.join(dir, 'planted-link.jpg');
    fs.symlinkSync(target, link);
    for (const overwrite of [false, true]) {
      let caught: LocalImageError | undefined;
      try {
        writeOutputFile(link, Buffer.from('x'), overwrite);
      } catch (err) {
        caught = err as LocalImageError;
      }
      // Without overwrite, O_EXCL already refuses any existing name (EEXIST); with it, O_NOFOLLOW does.
      expect(caught?.code).toBe(overwrite ? 'OUTPUT_IS_SYMLINK' : 'OUTPUT_EXISTS');
      expect(fs.existsSync(target)).toBe(false);
    }
  });
});

describe('write refusals name the path by its label', () => {
  const ENV = 'PHOTOTOLOGY_MCP_ALLOWED_DIRS';
  let base: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV];
    delete process.env[ENV];
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-label-')));
    fs.mkdirSync(path.join(base, 'in'));
    fs.mkdirSync(path.join(base, 'other'));
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV];
    else process.env[ENV] = savedEnv;
    fs.rmSync(base, { recursive: true, force: true });
  });

  function refusal(fn: () => unknown): LocalImageError {
    try {
      fn();
    } catch (err) {
      return err as LocalImageError;
    }
    throw new Error('expected a refusal');
  }

  test('an existing sidecar names the sidecar path and says to pass overwrite: true', () => {
    const xmp = path.join(base, 'in', 'p.jpg.xmp');
    fs.writeFileSync(xmp, 'old');
    const err = refusal(() => assertWritableOutput(undefined, xmp, false, 'sidecar path'));
    expect(err.code).toBe('OUTPUT_EXISTS');
    expect(err.message).toBe(`sidecar path ${xmp} already exists. Pass overwrite: true to replace it.`);
  });

  test('a symlink at the sidecar path names the sidecar path', () => {
    const xmp = path.join(base, 'in', 'p.jpg.xmp');
    fs.symlinkSync(path.join(base, 'other', 'victim'), xmp);
    const err = refusal(() => assertWritableOutput(undefined, xmp, true, 'sidecar path'));
    expect(err.code).toBe('OUTPUT_IS_SYMLINK');
    expect(err.message).toContain(`sidecar path ${xmp} is a symbolic link`);
    expect(err.message).not.toContain('outputPath');
  });

  test('a sidecar path outside the allowed folders names that path, never outputPath', () => {
    process.env[ENV] = path.join(base, 'in');
    const xmp = path.join(base, 'other', 'p.jpg.xmp');
    const err = refusal(() => assertWritableOutput(undefined, xmp, false, 'sidecar path'));
    expect(err.code).toBe('PATH_OUTSIDE_ALLOWED_DIRS');
    expect(err.message).toContain(xmp);
    expect(err.message).not.toContain('outputPath');
  });

  test('a missing sidecar folder names the sidecar path', () => {
    const err = refusal(() => assertWritableOutput(undefined, path.join(base, 'nope', 'p.jpg.xmp'), false, 'sidecar path'));
    expect(err.code).toBe('FILE_NOT_FOUND');
    expect(err.message).toContain('sidecar path directory does not exist');
  });

  test('writeOutputFile races name the sidecar path too', () => {
    const xmp = path.join(base, 'in', 'race.xmp');
    fs.writeFileSync(xmp, 'arrived first');
    const exists = refusal(() => writeOutputFile(xmp, Buffer.from('x'), false, 'sidecar path'));
    expect(exists.code).toBe('OUTPUT_EXISTS');
    expect(exists.message).toContain(`sidecar path ${xmp} was created by something else`);
    expect(exists.message).toContain('Pass overwrite: true');
    expect(exists.message).not.toContain('outputPath');
    const link = path.join(base, 'in', 'link.xmp');
    fs.symlinkSync(path.join(base, 'other', 'victim'), link);
    const linked = refusal(() => writeOutputFile(link, Buffer.from('x'), true, 'sidecar path'));
    expect(linked.code).toBe('OUTPUT_IS_SYMLINK');
    expect(linked.message).toContain(`sidecar path ${link}`);
  });

  test('without a label the messages still say outputPath', () => {
    const out = path.join(base, 'in', 'out.jpg');
    fs.writeFileSync(out, 'old');
    const err = refusal(() => assertWritableOutput(undefined, out, false));
    expect(err.message).toBe(`outputPath ${out} already exists. Choose a new path, or pass overwrite: true to replace it.`);
  });
});
