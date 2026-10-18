import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import fg from 'fast-glob';

export type LocalImageErrorCode =
  | 'RELATIVE_PATH_REJECTED'
  | 'FILE_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FORMAT'
  | 'HEIC_UNSUPPORTED'
  | 'INVALID_BASE64'
  | 'GLOB_TOO_LARGE'
  | 'SYMLINK_REJECTED'
  | 'OUTPUT_EXISTS'
  | 'OUTPUT_IS_INPUT'
  | 'OUTPUT_IS_SYMLINK'
  | 'INVALID_OUTPUT_PATH'
  | 'PATH_OUTSIDE_ALLOWED_DIRS';

export class LocalImageError extends Error {
  code: LocalImageErrorCode;
  path?: string;
  sizeBytes?: number;
  detail?: string;

  constructor(
    code: LocalImageErrorCode,
    message: string,
    opts?: { path?: string; sizeBytes?: number; detail?: string },
  ) {
    super(message);
    this.name = 'LocalImageError';
    this.code = code;
    this.path = opts?.path;
    this.sizeBytes = opts?.sizeBytes;
    this.detail = opts?.detail;
  }
}

const HOME_PREFIX = '~/';

export function resolvePath(input: string): string {
  if (!input || input.length === 0) {
    throw new LocalImageError(
      'RELATIVE_PATH_REJECTED',
      'imagePath cannot be empty. Pass an absolute path or a path starting with ~/.',
    );
  }
  if (input.startsWith(HOME_PREFIX)) {
    return path.join(os.homedir(), input.slice(HOME_PREFIX.length));
  }
  if (input.startsWith('~')) {
    // Bash ~user/ form or bare ~. Not supported — too host-specific and the
    // MCP can't reliably resolve other users' homes across platforms.
    throw new LocalImageError(
      'RELATIVE_PATH_REJECTED',
      `imagePath "${input}" uses tilde-expansion that isn't supported. Use absolute path (e.g. /Users/${input.slice(1)}/...) or ~/<path-within-your-home>.`,
      { path: input },
    );
  }
  if (!path.isAbsolute(input)) {
    throw new LocalImageError(
      'RELATIVE_PATH_REJECTED',
      `imagePath "${input}" is relative. The MCP's working directory varies by host (Claude Code = project root, Cursor = elsewhere, Claude Desktop = /). Pass an absolute path.`,
      { path: input },
    );
  }
  return input;
}

/**
 * An absolute path exactly as given. Never normalize it with path.resolve or path.normalize
 * before asking the kernel: those collapse `link/..` lexically, while the kernel goes through
 * the link's target first, so the two can name different folders.
 */
function asGiven(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(p);
}

/**
 * Where a path sits without following its last component and without needing it to exist: the
 * real path of the nearest existing ancestor folder (resolved by the kernel, `..` included)
 * joined with the rest. Used for the allow-list check, so a path outside the folders is refused
 * the same way whether or not it exists, and nothing about the disk outside the folders leaks
 * through a different error code. The rest starts with a component that does not exist, so the
 * kernel could never open it; joining it lexically only picks which refusal to give.
 */
function canonicalLocation(p: string): string {
  const raw = asGiven(p);
  const rest: string[] = [path.basename(raw)];
  let dir = path.dirname(raw);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return path.resolve(raw);
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * The real path of an existing path, else its canonicalLocation. Never throws. A dangling
 * symlink resolves through its directory only, so it is compared as itself.
 */
function canonicalTarget(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return canonicalLocation(p);
  }
}

/** True when both paths name the same file: same real path, or (for hard links) same device and inode. */
function isSameFile(a: string, b: string): boolean {
  if (canonicalTarget(a) === canonicalTarget(b)) return true;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * Guard for tools that write a file (enrich_photo's outputPath). Runs before any credits are
 * spent, and returns the canonical path: the kernel's real path of the folder as given (so
 * `link/..` goes through the link's target, as the open would) joined with the file name.
 * Callers write to that canonical path, never to the string they were given. In this order:
 * 0. Under an allow-list, refuse any `..` segment (PATH_OUTSIDE_ALLOWED_DIRS), before any
 *    filesystem call; see assertNoParentSegments.
 * 1. Refuse a file name that is empty, `.` or `..`, or a path ending in a separator
 *    (INVALID_OUTPUT_PATH): none of them names a new file in a known folder.
 * 2. When the folder does not exist, refuse PATH_OUTSIDE_ALLOWED_DIRS if where it would be is
 *    outside the allowed folders, else FILE_NOT_FOUND, so a missing folder outside the list
 *    gets the same answer as an existing one.
 * 3. Refuse a canonical path outside PHOTOTOLOGY_MCP_ALLOWED_DIRS (when set).
 * 4. Refuse writing over the input file, compared by real path and inode, so a symlink, a
 *    symlinked directory or a hard link pointing at the input is caught. Ignores overwrite.
 * 5. Refuse a canonical path that is itself a symlink, dangling or not. Ignores overwrite: a
 *    link is never written through, since its target can sit outside every allowed folder.
 * 6. Refuse an existing output unless the caller passed overwrite.
 * `label` names the path in refusals ('outputPath', or 'sidecar path' for enrich_photo's `<imagePath>.xmp`).
 */
export function assertWritableOutput(
  inputPath: string | undefined,
  outputPath: string,
  overwrite: boolean,
  label = 'outputPath',
): string {
  assertNoParentSegments(outputPath);
  const raw = asGiven(outputPath);
  const name = path.basename(raw);
  if (name === '' || name === '.' || name === '..' || /[\\/]$/.test(outputPath)) {
    throw new LocalImageError(
      'INVALID_OUTPUT_PATH',
      `${label} ${outputPath} does not end in a file name. Pass the full path of the new file, for example /folder/photo-enriched.jpg.`,
      { path: outputPath },
    );
  }
  const dir = path.dirname(raw);
  let realDir: string;
  try {
    realDir = fs.realpathSync.native(dir);
  } catch {
    assertInsideAllowedDirs(canonicalLocation(raw), outputPath);
    throw new LocalImageError('FILE_NOT_FOUND', `${label} directory does not exist: ${dir}`, { path: dir });
  }
  const canonical = path.join(realDir, name);
  assertInsideAllowedDirs(canonical, outputPath);
  if (inputPath !== undefined && isSameFile(inputPath, canonical)) {
    throw new LocalImageError(
      'OUTPUT_IS_INPUT',
      `${label} ${outputPath} is the input file. enrich_photo never writes over the original; choose a different ${label}.`,
      { path: outputPath },
    );
  }
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(canonical);
  } catch {
    existing = undefined;
  }
  if (existing?.isSymbolicLink()) throw outputIsSymlink(outputPath, label);
  if (existing && !overwrite) {
    throw new LocalImageError(
      'OUTPUT_EXISTS',
      `${label} ${outputPath} already exists. ${label === 'outputPath' ? 'Choose a new path, or pass' : 'Pass'} overwrite: true to replace it.`,
      { path: outputPath },
    );
  }
  return canonical;
}

function outputIsSymlink(outputPath: string, label: string): LocalImageError {
  return new LocalImageError(
    'OUTPUT_IS_SYMLINK',
    `${label} ${outputPath} is a symbolic link. enrich_photo never writes through a link, even with overwrite: true; pass a regular file path.`,
    { path: outputPath },
  );
}

/**
 * Write enrich_photo's output. O_EXCL (unless overwrite) refuses a file that appeared during the
 * enrich call, and O_NOFOLLOW refuses a symlink planted at outputPath after assertWritableOutput
 * ran, so both races are closed at the open syscall rather than by the earlier pre-check.
 */
export function writeOutputFile(outputPath: string, bytes: Buffer, overwrite: boolean, label = 'outputPath'): void {
  const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL, O_NOFOLLOW } = fs.constants;
  let fd: number;
  try {
    fd = fs.openSync(outputPath, O_WRONLY | O_CREAT | (overwrite ? O_TRUNC : O_EXCL) | O_NOFOLLOW, 0o644);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new LocalImageError(
        'OUTPUT_EXISTS',
        `${label} ${outputPath} was created by something else while enriching, so it was left untouched. ` +
          `This call was already charged. ${label === 'outputPath' ? 'Choose a new path, or pass' : 'Pass'} overwrite: true to replace it.`,
        { path: outputPath },
      );
    }
    if (code === 'ELOOP' || code === 'EMLINK') throw outputIsSymlink(outputPath, label);
    throw err;
  }
  try {
    let written = 0;
    while (written < bytes.length) {
      written += fs.writeSync(fd, bytes, written, bytes.length - written);
    }
  } finally {
    fs.closeSync(fd);
  }
}

const ALLOWED_DIRS_ENV = 'PHOTOTOLOGY_MCP_ALLOWED_DIRS';

/**
 * The real path of a file and whether reaching it went through a symlink anywhere along the way
 * (a symlinked parent folder, or macOS's /var -> /private/var). The real path uses the native
 * resolver so case on a case-insensitive disk matches the allow-list entries; viaSymlink is
 * confirmed with the JS resolver, which keeps the caller's case, so a mere case difference is
 * not reported as a symlink.
 */
export function resolveReal(absolutePath: string): { resolved: string; viaSymlink: boolean } {
  // The kernel resolves the path as given (`link/..` through the link); the lexical form is only
  // the baseline that tells whether a link was involved.
  const raw = asGiven(absolutePath);
  const normalized = path.resolve(raw);
  // Both calls map errors the same way, so a file removed between them is FILE_NOT_FOUND, not a raw ENOENT.
  const realpath = (resolver: (p: string) => string): string => {
    try {
      return resolver(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new LocalImageError('FILE_NOT_FOUND', `File not found: ${absolutePath}`, { path: absolutePath });
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new LocalImageError('PERMISSION_DENIED', `Permission denied reading: ${absolutePath}`, { path: absolutePath });
      }
      throw new LocalImageError('FILE_NOT_FOUND', `Could not resolve ${absolutePath}: ${(err as Error).message}`, { path: absolutePath });
    }
  };
  const resolved = realpath(fs.realpathSync.native);
  const viaSymlink = resolved !== normalized && realpath(fs.realpathSync) !== normalized;
  return { resolved, viaSymlink };
}

/**
 * The folders named by PHOTOTOLOGY_MCP_ALLOWED_DIRS, each resolved to its real path, or null when
 * the variable is unset or blank (no allow-list). Relative and empty entries are ignored; an entry
 * that does not exist is kept as written, so it matches nothing rather than failing the server. A
 * variable whose entries are all unusable yields an empty list, which refuses every path: a typo
 * must never quietly widen access to the whole disk.
 */
function allowedDirs(): string[] | null {
  const raw = process.env[ALLOWED_DIRS_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const dirs: string[] = [];
  for (const entry of raw.split(path.delimiter)) {
    const trimmed = entry.trim();
    if (trimmed === '' || !path.isAbsolute(trimmed)) continue;
    try {
      dirs.push(fs.realpathSync.native(trimmed));
    } catch {
      dirs.push(path.resolve(trimmed));
    }
  }
  return dirs;
}

/**
 * Refuse a real path outside every PHOTOTOLOGY_MCP_ALLOWED_DIRS folder. The error names
 * asGivenPath (the caller's own string), never the real path. The boundary is a whole
 * path component, so an allowed /a never admits /a2. Call with a path from resolveReal, so a
 * symlink inside an allowed folder that points elsewhere is judged by where it lands.
 */
function isInside(resolved: string, dirs: string[]): boolean {
  return dirs.some((dir) => {
    const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
    return resolved === dir || resolved.startsWith(prefix);
  });
}

export function assertInsideAllowedDirs(resolved: string, asGivenPath: string = resolved): void {
  const dirs = allowedDirs();
  if (dirs === null || isInside(resolved, dirs)) return;
  // Name the path as the caller gave it, never `resolved`: that would reveal where an outside link points.
  throw new LocalImageError(
    'PATH_OUTSIDE_ALLOWED_DIRS',
    `${asGivenPath} is outside the folders this server may read or write (${ALLOWED_DIRS_ENV}: ${dirs.length > 0 ? dirs.join(path.delimiter) : 'no usable absolute folder'}). ` +
      'Use a path inside one of those folders, or ask the user to add the folder to the list.',
    { path: asGivenPath },
  );
}

/**
 * Under an allow-list, refuse any path or pattern with a `..` segment (either separator) before
 * any filesystem call. Whether `X/..` resolves depends on whether X exists, so a `..` through an
 * outside folder would answer differently for an existing and a missing folder, telling the
 * caller what exists outside the list. Without an allow-list, `..` works as usual.
 */
function assertNoParentSegments(asGivenPath: string): void {
  const dirs = allowedDirs();
  if (dirs === null || !asGivenPath.split(/[\\/]/).includes('..')) return;
  throw new LocalImageError(
    'PATH_OUTSIDE_ALLOWED_DIRS',
    `${asGivenPath} contains "..", which is not accepted while ${ALLOWED_DIRS_ENV} is set. ` +
      'Pass the direct path inside one of the allowed folders.',
    { path: asGivenPath },
  );
}

/** Per-image raw size cap. 10MB raw → ~13.4MB base64, safely under API 50MB body limit. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The same 10MB per-image cap expressed in base64 characters, for the imageBase64 input mode. */
const MAX_BASE64_CHARS = Math.ceil(MAX_FILE_BYTES / 3) * 4;

/**
 * Sniff magic bytes (first 12 bytes are enough for all supported formats).
 *
 * The accepted set mirrors what the backend's Sharp pipeline (`prepareImage`
 * in @phototology/core) can actually decode + transcode to JPEG — including
 * AVIF and TIFF. Gatekeeping a narrower set here than the API supports just
 * bounces files the server would have handled (observed live, 2026-06-01:
 * 11 AVIFs rejected as UNSUPPORTED_FORMAT despite Sharp decoding AVIF fine).
 */
function detectFormat(bytes: Buffer): 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' | 'avif' | 'tiff' | null {
  if (bytes.length < 8) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png';
  // GIF: 47 49 46 38 (37|39) 61 = "GIF87a" or "GIF89a"
  if (
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) return 'gif';
  // TIFF: "II*\0" (little-endian, 49 49 2A 00) or "MM\0*" (big-endian, 4D 4D 00 2A).
  // NOTE: TIFF-based camera RAW (CR2/NEF/ARW/DNG) shares this magic; Sharp can't
  // decode proprietary RAW, so those will forward and fail server-side with a
  // clear IMAGE_INVALID rather than the local UNSUPPORTED_FORMAT. Acceptable —
  // RAW is rare here and usually exceeds the 10MB cap anyway.
  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) return 'tiff';
  // WebP: RIFF....WEBP — bytes 0-3 "RIFF", bytes 8-11 "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'webp';
  // ISO-BMFF container: ....ftyp.... — bytes 4-7 "ftyp", bytes 8-11 brand.
  // Covers both AVIF (AV1-in-HEIF) and HEIC/HEIF. The MCP only needs a non-null
  // result to forward the bytes; the API re-sniffs and decodes via Sharp.
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    const brand = bytes.slice(8, 12).toString('ascii');
    if (['avif', 'avis'].includes(brand)) return 'avif';
    // `mif1` / `msf1` are shared structural brands: an AVIF encoder may put one in the major
    // slot and `avif` among the compatible brands that follow. Read those before deciding.
    if (['mif1', 'msf1'].includes(brand)) {
      const compatible = bytes.slice(12, Math.min(bytes.length, 64)).toString('ascii');
      if (/avif|avis/.test(compatible)) return 'avif';
    }
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs'].includes(brand)) {
      return 'heic';
    }
  }
  return null;
}

/**
 * Read a local image after resolving its real path and checking it against
 * PHOTOTOLOGY_MCP_ALLOWED_DIRS. Returns the bytes plus where they really came from, so a tool can
 * tell the caller when a symlinked folder led somewhere else.
 */
export function readLocalImage(absolutePath: string): { bytes: Buffer; resolvedPath: string; viaSymlink: boolean } {
  assertNoParentSegments(absolutePath);
  // Allow-list first, so a path outside the folders is refused the same way whether it exists or not.
  assertInsideAllowedDirs(canonicalTarget(absolutePath), absolutePath);
  const { resolved, viaSymlink } = resolveReal(absolutePath);
  // Again on the path actually read, in case a link changed between the two resolutions.
  assertInsideAllowedDirs(resolved, absolutePath);

  let stat: fs.Stats;
  try {
    // lstat (not stat) on the path as given, so a symlinked file itself is still refused
    stat = fs.lstatSync(absolutePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new LocalImageError('FILE_NOT_FOUND', `File not found: ${absolutePath}`, { path: absolutePath });
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new LocalImageError('PERMISSION_DENIED', `Permission denied reading: ${absolutePath}`, { path: absolutePath });
    }
    throw new LocalImageError('FILE_NOT_FOUND', `Could not stat ${absolutePath}: ${(err as Error).message}`, { path: absolutePath });
  }

  if (stat.isSymbolicLink()) {
    throw new LocalImageError(
      'SYMLINK_REJECTED',
      `Symbolic links are not supported (${absolutePath}). Pass the resolved target path directly.`,
      { path: absolutePath },
    );
  }

  if (stat.size > MAX_FILE_BYTES) {
    throw new LocalImageError(
      'FILE_TOO_LARGE',
      `File is ${(stat.size / 1024 / 1024).toFixed(1)}MB; per-image cap is 10MB. Ask the user to resize or pick a smaller version.`,
      { path: absolutePath, sizeBytes: stat.size },
    );
  }

  let bytes: Buffer;
  try {
    // Read the checked real path, so a parent link swapped after the check cannot redirect the read.
    bytes = fs.readFileSync(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new LocalImageError('PERMISSION_DENIED', `Permission denied reading: ${absolutePath}`, { path: absolutePath });
    }
    throw new LocalImageError('FILE_NOT_FOUND', `Could not read ${absolutePath}: ${(err as Error).message}`, { path: absolutePath });
  }

  const format = detectFormat(bytes);
  if (format === null) {
    throw new LocalImageError(
      'UNSUPPORTED_FORMAT',
      `Unrecognized image format at ${absolutePath}. Supported: JPEG, PNG, GIF, WebP, AVIF, TIFF. ` +
        `For HEIC, RAW or other formats, convert to JPEG first (macOS: \`sips -s format jpeg "${absolutePath}" --out out.jpg\`) or pass imageUrl.`,
      { path: absolutePath },
    );
  }
  assertNotHeic(format, absolutePath);

  return { bytes, resolvedPath: resolved, viaSymlink };
}

export function readImage(absolutePath: string): Buffer {
  return readLocalImage(absolutePath).bytes;
}

/**
 * The API's image decoder (sharp without a HEIF plugin) cannot read HEIC/HEIF and answers
 * with an opaque 422 IMAGE_INVALID; 52 such calls on 2026-10-05 came from one MCP user's
 * iPhone library. Refuse here, by bytes not by name, with a conversion hint. Shared by every
 * input mode (local path, base64) and every tool that reads images.
 */
export function assertNotHeic(format: ReturnType<typeof detectFormat>, label: string): void {
  if (format !== 'heic') return;
  throw new LocalImageError(
    'HEIC_UNSUPPORTED',
    `${label} is a HEIC/HEIF image, which the API cannot decode yet. Convert to JPEG first ` +
      `(macOS: \`sips -s format jpeg "${label}" --out out.jpg\`; iPhone: Settings > Camera > Formats > Most Compatible), then retry.`,
    { path: label },
  );
}

/** Sniff the format of a base64 payload from its first bytes (enough for every magic number we know). */
export function detectBase64Format(b64: string): ReturnType<typeof detectFormat> {
  return detectFormat(Buffer.from(b64.slice(0, 128), 'base64'));
}

export function computeSha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

export function validateBase64(input: string): void {
  if (!input || input.length === 0) {
    throw new LocalImageError('INVALID_BASE64', 'Base64 input is empty.');
  }
  // Size check FIRST (cheap) so an oversized payload fails before we run the regex
  // over millions of characters. Mirrors the 10MB local-file cap so every input
  // mode shares one per-image limit and we never forward a body the API would 413.
  if (input.length > MAX_BASE64_CHARS) {
    const approxMb = ((input.length * 3) / 4 / 1024 / 1024).toFixed(1);
    throw new LocalImageError(
      'FILE_TOO_LARGE',
      `Base64 input is ~${approxMb}MB; the per-image cap is 10MB. Resize the image, or pass imageUrl for a hostable image of any size.`,
    );
  }
  if (!BASE64_REGEX.test(input)) {
    throw new LocalImageError('INVALID_BASE64', 'Base64 input contains invalid characters.');
  }
  // length must be 0 mod 4 (after padding)
  if (input.length % 4 !== 0) {
    throw new LocalImageError(
      'INVALID_BASE64',
      `Base64 input length ${input.length} is not a multiple of 4. Check for truncation or missing padding.`,
    );
  }
}

const MAX_GLOB_FILES = 200;

/**
 * The folder part of a glob before its first wildcard segment, as given: the caller resolves it
 * with the kernel, which applies `..` after following any link before it.
 */
function globBase(pattern: string): string {
  const segments = pattern.split(/[\\/]/);
  const fixed: string[] = [];
  for (const seg of segments) {
    if (seg !== '' && fg.isDynamicPattern(seg)) break;
    fixed.push(seg);
  }
  return fixed.join(path.sep) || path.sep;
}

/**
 * Expand a list of literal paths and glob patterns into a deduplicated
 * absolute-path array. Each pattern is expanded independently; results
 * are merged + deduplicated. Every pattern must be absolute or ~/-prefixed
 * (RELATIVE_PATH_REJECTED otherwise); ~/ is expanded BEFORE fast-glob sees it.
 *
 * When PHOTOTOLOGY_MCP_ALLOWED_DIRS is set, a glob whose fixed folder part
 * (before the first wildcard) is outside every allowed folder is refused
 * whole with PATH_OUTSIDE_ALLOWED_DIRS naming only the pattern, and so is any
 * pattern or literal path with a `..` segment: thrown, or
 * passed to onRefusedPattern so the other patterns still expand. A match
 * that really lives outside the folders is dropped silently. Literal paths
 * pass through; readLocalImage judges them.
 *
 * Hard cap at MAX_GLOB_FILES across all patterns combined. Empty glob
 * matches return an empty result (not an error) so a typo'd glob doesn't
 * fail an otherwise-good batch.
 *
 * fast-glob options:
 *   - onlyFiles: true   (skip directory matches)
 *   - suppressErrors: true (per-file permission-denied → skipped, not fatal)
 *   - followSymbolicLinks: false (symlinks excluded; readImage rejects them anyway)
 */
export function expandGlobs(
  patterns: string[],
  onRefusedPattern?: (pattern: string, err: LocalImageError) => void,
): string[] {
  const seen = new Set<string>();
  const dirs = allowedDirs();
  for (const raw of patterns) {
    if (!raw) continue;
    // Same absolute-or-~/ rule for literals and globs: resolvePath expands ~/
    // and refuses a relative pattern, which would otherwise expand from the
    // server's working directory (it varies by host).
    const expanded = resolvePath(raw);
    try {
      assertNoParentSegments(expanded);
    } catch (err) {
      if (onRefusedPattern === undefined || !(err instanceof LocalImageError)) throw err;
      onRefusedPattern(raw, err);
      continue;
    }
    // Detect glob meta-chars (heuristic — fast-glob will also treat literal paths as patterns)
    const isGlob = /[*?[\]{}!]/.test(expanded);
    if (isGlob) {
      if (dirs !== null) {
        // Refuse the whole pattern when its fixed base folder sits outside the allow-list, before
        // anything is listed, so the error names only the pattern and never a file found there.
        const base = canonicalTarget(globBase(expanded));
        if (!isInside(base, dirs)) {
          const err = new LocalImageError(
            'PATH_OUTSIDE_ALLOWED_DIRS',
            `The pattern ${raw} searches outside the folders this server may read (${ALLOWED_DIRS_ENV}). ` +
              'Use a pattern whose fixed folder part is inside one of those folders, or ask the user to add the folder to the list.',
            { path: raw },
          );
          if (onRefusedPattern === undefined) throw err;
          onRefusedPattern(raw, err);
          continue;
        }
      }
      const matches = fg.sync(expanded, {
        onlyFiles: true,
        suppressErrors: true,
        followSymbolicLinks: false,
        absolute: true,
      });
      for (const m of matches) {
        // A match that really lives outside the folders (a link, a `..` after a wildcard) is
        // dropped without a word: reporting it would name a file outside the list.
        if (dirs !== null && !isInside(canonicalTarget(m), dirs)) continue;
        seen.add(m);
      }
    } else {
      seen.add(expanded);
    }
    if (seen.size > MAX_GLOB_FILES) {
      throw new LocalImageError(
        'GLOB_TOO_LARGE',
        `Glob expansion exceeded ${MAX_GLOB_FILES} files. Split the call into smaller batches.`,
      );
    }
  }
  return Array.from(seen);
}
