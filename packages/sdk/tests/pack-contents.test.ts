/**
 * The npm tarball must contain exactly the files in pack-manifest.json, and no
 * source maps. Needs a build first (dist/). The same check runs in the public
 * repo's CI and in the release workflow. Policy: docs/PUBLIC_SURFACE.md.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

const pkgDir = path.resolve(__dirname, '..');
const checker = path.resolve(pkgDir, '../../scripts/public-surface/check-pack.mjs');

describe('npm pack contents', () => {
  it('match pack-manifest.json exactly, with no source maps', () => {
    const r = spawnSync(process.execPath, [checker, pkgDir], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${r.stdout}\n${r.stderr}`);
    expect(r.status).toBe(0);
  }, 60_000);
});
