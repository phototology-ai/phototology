// Shared helpers for the public-surface export and guard.
// No dependencies: this file also runs on the public mirror's CI.
import { readFileSync } from 'node:fs';

/** Expand one level of `{a,b,c}` alternatives (nested braces are not supported). */
export function expandBraces(glob) {
  const m = /\{([^{}]*)\}/.exec(glob);
  if (!m) return [glob];
  const head = glob.slice(0, m.index);
  const tail = glob.slice(m.index + m[0].length);
  return m[1].split(',').flatMap((alt) => expandBraces(head + alt + tail));
}

/** Convert a glob (`*`, `**`, `?`) to an anchored RegExp over a `/`-separated path. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` = zero or more directories; trailing `**` = anything.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function compileGlobs(globs) {
  return globs.flatMap(expandBraces).map(globToRegExp);
}

export const matchesAny = (regexps, path) => regexps.some((r) => r.test(path));

/**
 * Parse public-surface.allowlist.
 * Returns { maps: [{src, dst}], allow: RegExp[], deny: RegExp[], mirrorRoot: RegExp[] }.
 */
const safeRelPath = (p) => !!p && !p.startsWith('/') && !p.split('/').some((seg) => seg === '..' || seg === '.' || seg === '' || seg === '.git');

export function parseAllowlist(file) {
  return parseAllowlistText(readFileSync(file, 'utf8'), file);
}

export function parseAllowlistText(text, file = 'public-surface.allowlist') {
  const maps = [];
  const allow = [];
  const deny = [];
  const mirrorRoot = [];
  text.split('\n').forEach((raw, idx) => {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) return;
    const [kind, ...rest] = line.split(/\s+/);
    if (kind === 'map' && rest.length === 2 && !rest.every(safeRelPath)) throw new Error(`${file}:${idx + 1}: map paths must be relative, without '..' or .git: ${raw}`);
    if (kind === 'map' && rest.length === 2) maps.push({ src: rest[0].replace(/\/$/, ''), dst: rest[1].replace(/\/$/, '') });
    else if (kind === 'allow' && rest.length === 1) allow.push(rest[0]);
    else if (kind === 'deny' && rest.length === 1) deny.push(rest[0]);
    else if (kind === 'mirror-root' && rest.length === 1) mirrorRoot.push(rest[0]);
    else throw new Error(`${file}:${idx + 1}: cannot parse rule: ${raw}`);
  });
  return { maps, allow: compileGlobs(allow), deny: compileGlobs(deny), mirrorRoot: compileGlobs(mirrorRoot) };
}

/** Monorepo path -> mirror path, or null when the path is under no map. */
export function toMirrorPath(rules, srcPath) {
  for (const { src, dst } of rules.maps) {
    if (srcPath === src) return dst;
    if (srcPath.startsWith(`${src}/`)) return dst + srcPath.slice(src.length);
  }
  return null;
}

/** Mirror path -> monorepo path, or null when the path is under no map. */
export function toSourcePath(rules, mirrorPath) {
  for (const { src, dst } of rules.maps) {
    if (mirrorPath === dst) return src;
    if (mirrorPath.startsWith(`${dst}/`)) return src + mirrorPath.slice(dst.length);
  }
  return null;
}

/** Is a monorepo path exportable? Deny always wins. */
export function isExportable(rules, srcPath) {
  if (toMirrorPath(rules, srcPath) === null) return false;
  if (matchesAny(rules.deny, srcPath)) return false;
  return matchesAny(rules.allow, srcPath);
}
