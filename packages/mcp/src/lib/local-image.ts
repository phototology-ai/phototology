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
  | 'INVALID_BASE64'
  | 'GLOB_TOO_LARGE'
  | 'SYMLINK_REJECTED';

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

/** Per-image raw size cap. 10MB raw → ~13.4MB base64, safely under API 50MB body limit. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Sniff magic bytes (first 12 bytes are enough for all supported formats). */
function detectFormat(bytes: Buffer): 'jpeg' | 'png' | 'gif' | 'webp' | 'heic' | null {
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
  // WebP: RIFF....WEBP — bytes 0-3 "RIFF", bytes 8-11 "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'webp';
  // HEIC/HEIF: ....ftyp.... — bytes 4-7 "ftyp", bytes 8-11 brand
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70
  ) {
    const brand = bytes.slice(8, 12).toString('ascii');
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'hevm', 'hevs'].includes(brand)) {
      return 'heic';
    }
  }
  return null;
}

export function readImage(absolutePath: string): Buffer {
  let stat: fs.Stats;
  try {
    // lstat (not stat) so we detect symlinks before following them
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
    bytes = fs.readFileSync(absolutePath);
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
      `Unrecognized image format at ${absolutePath}. Supported: JPEG, PNG, GIF, WebP, HEIC.`,
      { path: absolutePath },
    );
  }

  return bytes;
}

export function computeSha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

export function validateBase64(input: string): void {
  if (!input || input.length === 0) {
    throw new LocalImageError('INVALID_BASE64', 'Base64 input is empty.');
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
 * Expand a list of literal paths and glob patterns into a deduplicated
 * absolute-path array. Each pattern is expanded independently; results
 * are merged + deduplicated. ~/ is expanded BEFORE passing to fast-glob.
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
export function expandGlobs(patterns: string[]): string[] {
  const seen = new Set<string>();
  for (const raw of patterns) {
    if (!raw) continue;
    // Expand ~/ in each pattern before fast-glob sees it
    const expanded = raw.startsWith(HOME_PREFIX)
      ? path.join(os.homedir(), raw.slice(HOME_PREFIX.length))
      : raw;
    // Detect glob meta-chars (heuristic — fast-glob will also treat literal paths as patterns)
    const isGlob = /[*?[\]{}!]/.test(expanded);
    if (isGlob) {
      const matches = fg.sync(expanded, {
        onlyFiles: true,
        suppressErrors: true,
        followSymbolicLinks: false,
        absolute: true,
      });
      for (const m of matches) seen.add(m);
    } else {
      // Literal path. Resolve via resolvePath to enforce absolute-or-~/ rules.
      seen.add(resolvePath(expanded));
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
