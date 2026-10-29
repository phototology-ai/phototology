#!/usr/bin/env node
// check-pack.mjs: the npm tarball of a package must contain exactly the files
// in its committed pack-manifest.json (the `files` allowlist is the control;
// this test makes any change to it visible and deliberate).
//
//   node scripts/public-surface/check-pack.mjs <package dir>...            check
//   node scripts/public-surface/check-pack.mjs --update <package dir>...   rewrite the manifest
//
// Works the same in the private repo and the public mirror. Needs the package
// built first (dist/). No source maps may ship (decision: src is not shipped,
// so maps would point at nothing).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const update = args.includes('--update');
const dirs = args.filter((a) => a !== '--update');
if (!dirs.length) {
  console.error('usage: check-pack.mjs [--update] <package dir>...');
  process.exit(2);
}

let failed = false;
for (const d of dirs) {
  const dir = resolve(d);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (pkg.files && pkg.files.includes('dist') && !existsSync(join(dir, 'dist'))) {
    console.error(`check-pack: ${pkg.name}: dist/ is missing; build first`);
    failed = true;
    continue;
  }
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const files = JSON.parse(out)[0].files.map((f) => f.path).sort();
  const manifestPath = join(dir, 'pack-manifest.json');
  const maps = files.filter((f) => f.endsWith('.map'));
  if (maps.length) {
    console.error(`check-pack: ${pkg.name}: source maps must not ship: ${maps.join(', ')}`);
    failed = true;
  }
  if (update) {
    writeFileSync(manifestPath, `${JSON.stringify({ name: pkg.name, files }, null, 2)}\n`);
    console.log(`check-pack: ${pkg.name}: wrote ${files.length} files to pack-manifest.json`);
    continue;
  }
  if (!existsSync(manifestPath)) {
    console.error(`check-pack: ${pkg.name}: no pack-manifest.json (run with --update and review it)`);
    failed = true;
    continue;
  }
  const expected = JSON.parse(readFileSync(manifestPath, 'utf8')).files;
  const added = files.filter((f) => !expected.includes(f));
  const missing = expected.filter((f) => !files.includes(f));
  if (added.length || missing.length) {
    failed = true;
    console.error(`check-pack: ${pkg.name}: tarball differs from pack-manifest.json`);
    for (const f of added) console.error(`  + ${f}   (new in the tarball: is it meant to be public?)`);
    for (const f of missing) console.error(`  - ${f}`);
    console.error('  If intended: node scripts/public-surface/check-pack.mjs --update <dir>, and review the diff.');
  } else {
    console.log(`check-pack: ${pkg.name}: ${files.length} files match pack-manifest.json`);
  }
}
process.exit(failed ? 1 : 0);
