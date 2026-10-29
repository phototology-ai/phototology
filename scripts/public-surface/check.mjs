#!/usr/bin/env node
// check.mjs: the public-surface leak guard. One script, used everywhere:
// the pre-push hook, the mirror sync (blocking, before commit), the mirror's CI,
// and the release workflow (against the packed tarballs).
//
//   node check.mjs <tree> [--message-file <f>] [--tarball <x.tgz>]... [--no-paths]
//
// <tree> is a directory in the public mirror's layout (a sync export or a
// mirror checkout). Reports file:line findings and exits 1 on any finding.
// There is no bypass flag and no auto-fix: a finding is a stop.
//
// Checks: paths (allowlist + hard denylist), secrets (gitleaks + built-in
// patterns), customer/personal data, infrastructure names, real-looking
// perceptual hashes in fixtures, private names (from a list that itself stays
// private), private repo paths, source maps, and large or GPS-tagged binaries. Policy: docs/PUBLIC_SURFACE.md.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExportable, matchesAny, parseAllowlist, toSourcePath } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2);
const tarballs = [];
let tree = null;
let messageFile = null;
let checkPaths = true;
let ignoreNodeModules = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--tarball') tarballs.push(argv[++i]);
  else if (a === '--message-file') messageFile = argv[++i];
  else if (a === '--no-paths') checkPaths = false;
  // Only for a tree after `pnpm install` (installed deps are not part of the
  // public surface). Without it, a node_modules folder is a path finding.
  else if (a === '--ignore-node-modules') ignoreNodeModules = true;
  else if (a.startsWith('--')) { console.error(`check-public-surface: unknown option ${a}`); process.exit(2); }
  else tree = a;
}
if (!tree && tarballs.length === 0 && !messageFile) {
  console.error('usage: check.mjs <tree> [--message-file <f>] [--tarball <x.tgz>]... [--no-paths]');
  process.exit(2);
}

// ---------------------------------------------------------------- config
// Config travels with the tree (the export carries it); fall back to the copy
// next to this script (monorepo checkout).
const findConfig = (name) => {
  for (const base of [tree, join(HERE, '..', '..'), HERE].filter(Boolean)) {
    const p = join(base, name);
    if (existsSync(p)) return p;
  }
  return null;
};
const allowlistFile = findConfig('public-surface.allowlist');
const fixturesAllowFile = findConfig('public-fixtures.allow');
const gitleaksConfig = findConfig('.gitleaks.toml');
// Private word list: lives only in the private repo (never exported). On the
// mirror it is absent and the name check is skipped; it already ran before push.
const namesFile = join(HERE, 'private-names.txt');

const fixturesAllow = new Set();
const pathAllow = new Set();
if (fixturesAllowFile) {
  for (const raw of readFileSync(fixturesAllowFile, 'utf8').split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('path:')) pathAllow.add(line.slice(5));
    else fixturesAllow.add(line);
  }
}
const privateNames = new Set(
  existsSync(namesFile)
    ? readFileSync(namesFile, 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim().toLowerCase()).filter(Boolean)
    : [],
);
for (const n of (process.env.PUBLIC_SURFACE_PRIVATE_NAMES || '').split(/[\n,]/)) if (n.trim()) privateNames.add(n.trim().toLowerCase());
if (privateNames.size === 0) console.error('check-public-surface: note: no private-names list here (expected on the public mirror); name check skipped');

// ---------------------------------------------------------------- rules
// Files that define detection patterns or the allowed dummy values: exempt
// from the pattern rules (they would match themselves), never from names/paths.
const PATTERN_DEFINITION_FILES = new Set(['scripts/public-surface/check.mjs']);

const ALLOWED_EMAIL = (email) => {
  const [local, domain] = email.toLowerCase().split('@');
  if (/^(no-?reply|noreply\+.*)$/.test(local)) return true;
  return (
    /(^|\.)phototology\.com$/.test(domain) ||
    /(^|\.)example(\.(com|org|net))?$/.test(domain) ||
    /\.(test|invalid|example|localhost)$/.test(domain) ||
    domain === 'localhost' ||
    domain === 'users.noreply.github.com'
  );
};

/** Content rules: [id, regex (global), optional filter(match) -> true when it is a finding]. */
const CONTENT_RULES = [
  ['secret/stripe', /\b(?:sk|rk|pk)_live_[A-Za-z0-9]{8,}|\bwhsec_[A-Za-z0-9]{8,}|\bsk_test_[A-Za-z0-9]{16,}/g],
  ['secret/pem', /-----BEGIN [A-Z0-9 ]+-----/g],
  ['secret/aws', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['secret/github', /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g],
  ['secret/google', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['secret/anthropic-openai', /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}/g],
  ['secret/slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}/g],
  // Real keys are pt_live_/pt_test_ + 64 hex chars; short readable test placeholders
  // (pt_test_roundtrip) are fine.
  ['secret/phototology-key', /\bpt_(?:live|test)_[A-Za-z0-9]{24,}/g, (m) => !fixturesAllow.has(m) && !isSynthetic(m.replace(/^pt_(?:live|test)_/, ''))],
  ['infra/database', /libsql:\/\/|\.turso\.io\b|\bDATABASE_URL\b|\bTURSO_[A-Z_]+/g],
  ['infra/railway', /\.railway\.internal\b|\.up\.railway\.app\b|\bRAILWAY_[A-Z_]+/g],
  ['infra/analytics-key', /\bPOSTHOG_(?:KEY|API_KEY|PERSONAL_API_KEY)\b|\bphc_[A-Za-z0-9]{10,}/g],
  ['infra/doppler', /\bDOPPLER_[A-Z_]+|\bdp\.(?:st|pt|ct|sa)\.[A-Za-z0-9]/g],
  ['personal/email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, (m) => !ALLOWED_EMAIL(m)],
  ['personal/us-phone', /(?<![\w.+-])\(?[2-9]\d{2}\)?[-. ]\d{3}[-. ]\d{4}(?![\w.-])/g, (m) => !/^\(?\d{3}\)?[-. ]555[-. ]/.test(m)],
  ['personal/account-id', /\b(?:user|usr|cus|acct|pi|ch|sub|cs|in|txn)_(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{10,}\b/g, (m) => !fixturesAllow.has(m)],
  ['private/path', /docs\/(?:patent|strategy|research|audit|audits|superpowers|handoffs?)\b|(?:\.\.\/)+(?:phototology-api|phototology-web|phototology\/src)\b|packages\/phototology-(?:api|web)\//g],
];

// Real-looking perceptual or content hashes (dHash/pHash hex, binary pHash,
// sha256/PDQ). Checked in every exported text file, not just fixtures.
const HASH_RULE = /(?<![0-9A-Fa-f])(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{16})(?![0-9A-Fa-f])|(?<![01])[01]{64}(?![01])/g;
const isSynthetic = (h) => {
  const s = h.toLowerCase();
  for (let unit = 1; unit <= 8; unit++) {
    if (s.length % unit === 0 && s.slice(0, unit).repeat(s.length / unit) === s) return true;
  }
  // Counting runs such as 0123456789abcdef (repeated or not).
  const seq = '0123456789abcdef'.repeat(8);
  return s.length >= 16 && seq.includes(s);
};
const hashScope = (p) => !/(^|\/)pnpm-lock\.yaml$|(^|\/)package-lock\.json$|\.github\/workflows\//.test(p);

const TEXT_EXT = /\.(?:[cm]?[jt]sx?|json|md|mdx|txt|ya?ml|toml|html?|css|sh|mjs|cjs|d\.ts|lock|allow|allowlist|sha256|gitignore|npmignore)$/i;
const BINARY_LIMIT = 200 * 1024;

// ---------------------------------------------------------------- scan
const findings = [];
const add = (file, line, rule, detail) => findings.push({ file, line, rule, detail });
// Never echo a matched secret: show a short masked prefix only.
const mask = (s) => (s.length <= 8 ? `${s.slice(0, 2)}…` : `${s.slice(0, 6)}…(${s.length} chars)`);

function walk(dir, base = dir, acc = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' && dir === base) continue;
    if (ent.name === 'node_modules' && ignoreNodeModules) continue;
    const p = join(dir, ent.name);
    if (ent.isSymbolicLink()) acc.push({ rel: relative(base, p), symlink: true });
    else if (ent.isDirectory()) walk(p, base, acc);
    else acc.push({ rel: relative(base, p).split('\\').join('/'), abs: p });
  }
  return acc;
}

function scanNames(file, lineNo, text) {
  const tokens = text.toLowerCase().match(/[a-z0-9]+(?:-[a-z0-9]+)*/g) || [];
  for (const t of tokens) {
    const parts = t.includes('-') ? [t, ...t.split('-')] : [t];
    for (const p of parts) {
      if (privateNames.has(p)) {
        add(file, lineNo, 'internal/name', `private name "${p.slice(0, 2)}…" (listed in scripts/public-surface/private-names.txt)`);
        return;
      }
    }
  }
}

function scanText(file, text, { patterns = true, hashes = false } = {}) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    scanNames(file, n, line);
    if (patterns) {
      for (const [id, re, keep] of CONTENT_RULES) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) {
          if (keep && !keep(m[0])) continue;
          add(file, n, id, mask(m[0]));
        }
      }
    }
    if (hashes) {
      HASH_RULE.lastIndex = 0;
      for (const m of line.matchAll(HASH_RULE)) {
        if (isSynthetic(m[0]) || fixturesAllow.has(m[0]) || fixturesAllow.has(m[0].toLowerCase())) continue;
        add(file, n, 'personal/real-hash', `non-synthetic ${m[0].length}-char hash ${mask(m[0])}; use a synthetic value or add it to public-fixtures.allow with its provenance`);
      }
    }
  });
}

function hasGps(buf) {
  // JPEG APP1 "Exif\0\0" or bare TIFF, with the GPS IFD pointer tag 0x8825.
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isTiff = (buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4d && buf[1] === 0x4d);
  if (!isJpeg && !isTiff) return false;
  const head = buf.subarray(0, Math.min(buf.length, 128 * 1024));
  if (isJpeg && head.indexOf('Exif\0\0', 0, 'latin1') === -1) return false;
  return head.indexOf(Buffer.from([0x88, 0x25])) !== -1 || head.indexOf(Buffer.from([0x25, 0x88])) !== -1;
}

function scanFile(rel, abs, { treeMode }) {
  const st = statSync(abs);
  const buf = readFileSync(abs);
  const isBinary = buf.subarray(0, 8000).includes(0) || (!TEXT_EXT.test(rel) && /\.(?:jpe?g|png|gif|webp|heic|tiff?|pdf|zip|gz|tgz|wasm|ico|bin)$/i.test(rel));
  if (isBinary) {
    if (st.size > BINARY_LIMIT && !pathAllow.has(rel)) add(rel, 0, 'binary/size', `${Math.round(st.size / 1024)} KB binary (limit ${BINARY_LIMIT / 1024} KB)`);
    if (hasGps(buf)) add(rel, 0, 'binary/gps', 'image carries EXIF GPS data');
    return;
  }
  const text = buf.toString('utf8');
  if (/\.map$/.test(rel)) {
    try {
      const map = JSON.parse(text);
      if (map.sourcesContent) add(rel, 0, 'sourcemap/content', 'source map embeds sourcesContent');
      for (const s of map.sources || []) {
        if (/^(?:\/|file:|[A-Za-z]:\\)/.test(s)) add(rel, 0, 'sourcemap/absolute-path', 'source map has an absolute path');
      }
    } catch { add(rel, 0, 'sourcemap/unparseable', 'source map is not valid JSON'); }
  }
  scanText(rel, text, { patterns: !PATTERN_DEFINITION_FILES.has(rel), hashes: hashScope(rel) });
  void treeMode;
}

function scanTree(root, { treeMode, label = '' }) {
  const rules = treeMode && checkPaths && allowlistFile ? parseAllowlist(allowlistFile) : null;
  if (treeMode && checkPaths && !rules) add(label || root, 0, 'config/missing', 'public-surface.allowlist not found');
  for (const f of walk(root)) {
    const rel = label ? `${label}/${f.rel}` : f.rel;
    if (f.symlink) { add(rel, 0, 'path/symlink', 'symlinks never ship'); continue; }
    if (rules) {
      const src = toSourcePath(rules, f.rel);
      if (src !== null) {
        if (!isExportable(rules, src)) add(rel, 0, 'path/not-allowed', `not on public-surface.allowlist or denied (source ${src.replace(/^packages\/[^/]+/, '<pkg>')})`);
      } else if (!matchesAny(rules.mirrorRoot, f.rel) || matchesAny(rules.deny, f.rel)) {
        add(rel, 0, 'path/not-allowed', 'mirror root file not on the mirror-root list');
      }
    } else if (allowlistFile) {
      const { deny } = parseAllowlist(allowlistFile);
      if (matchesAny(deny, f.rel)) add(rel, 0, 'path/denied', 'matches the hard denylist');
    }
    scanFile(rel, f.abs, { treeMode });
  }
}

function runGitleaks(root, label) {
  const bin = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (bin.error) {
    if (process.env.CI) add(label, 0, 'gitleaks/missing', 'gitleaks is required in CI and was not found on PATH');
    else console.error('check-public-surface: WARNING gitleaks not installed; built-in secret patterns only (CI always runs it)');
    return;
  }
  const args = ['dir', root, '--no-banner', '--redact', '--exit-code', '3', '--log-level', 'warn'];
  if (gitleaksConfig) args.push('--config', gitleaksConfig);
  const r = spawnSync('gitleaks', args, { encoding: 'utf8' });
  if (r.status === 3) add(label, 0, 'gitleaks', `gitleaks found secrets (redacted):\n${(r.stdout + r.stderr).trim()}`);
  else if (r.status !== 0) add(label, 0, 'gitleaks/error', `gitleaks failed (exit ${r.status}): ${(r.stderr || '').trim().slice(0, 400)}`);
}

if (tree) {
  scanTree(tree, { treeMode: true });
  runGitleaks(tree, tree);
}
for (const tgz of tarballs) {
  const dir = mkdtempSync(join(tmpdir(), 'pub-tgz-'));
  execFileSync('tar', ['-xzf', tgz, '-C', dir]);
  const label = `${tgz.split('/').pop()}`;
  scanTree(dir, { treeMode: false, label });
  runGitleaks(dir, label);
  execFileSync('rm', ['-rf', dir]);
}
if (messageFile) {
  const msg = readFileSync(messageFile, 'utf8');
  scanText('<commit message>', msg, { patterns: true, hashes: false });
  if (/\b[0-9a-f]{7,40}\b/.test(msg.replace(/\b\d+\b/g, ''))) {
    for (const m of msg.matchAll(/\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g)) add('<commit message>', 0, 'message/private-sha', `commit message carries a commit SHA (${m[0].slice(0, 4)}…)`);
  }
}

if (findings.length) {
  console.error(`check-public-surface: ${findings.length} finding(s). Nothing may go public until these are fixed (policy: docs/PUBLIC_SURFACE.md).`);
  for (const f of findings) console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.rule}]  ${f.detail}`);
  process.exit(1);
}
console.log('check-public-surface: clean');
