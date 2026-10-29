#!/usr/bin/env node
// check-versions.mjs: every place that states a public package version must
// agree. Runs in the private repo (all checks) and in the public repo (the
// package checks; the website files aren't there).
//
//   node scripts/public-surface/check-versions.mjs [--expect sdk=X,mcp=Y]
//
// Checked: package.json versions; SDK_VERSION in sdk/src/client.ts;
// mcp/server.json `version` and its npm package entry; the mcp -> sdk
// dependency; the newest released CHANGELOG heading; and the website's
// PUBLIC_PACKAGE_VERSIONS (llms.txt, llms-full.txt read it). Historical notes
// such as "type-checked against 2.0.0 on <date>" are not version claims and
// are not checked.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const mono = existsSync(join(ROOT, 'packages/phototology-sdk/package.json'));
const P = mono
  ? { sdk: 'packages/phototology-sdk', mcp: 'packages/phototology-mcp', bare: 'packages/phototology-bare' }
  : { sdk: 'packages/sdk', mcp: 'packages/mcp', bare: 'packages/phototology' };
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const json = (p) => JSON.parse(read(p));

const problems = [];
const expectEq = (what, actual, expected) => {
  if (actual !== expected) problems.push(`${what}: ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`);
};

const sdk = json(`${P.sdk}/package.json`).version;
const mcpPkg = json(`${P.mcp}/package.json`);
const mcp = mcpPkg.version;

const expectArg = process.argv.indexOf('--expect');
if (expectArg !== -1) {
  for (const kv of (process.argv[expectArg + 1] || '').split(',')) {
    const [k, v] = kv.split('=');
    if (k === 'sdk') expectEq('@phototology/sdk package.json (expected release version)', sdk, v);
    else if (k === 'mcp') expectEq('@phototology/mcp package.json (expected release version)', mcp, v);
  }
}

const sdkConst = /const SDK_VERSION = '([^']+)'/.exec(read(`${P.sdk}/src/client.ts`));
expectEq(`${P.sdk}/src/client.ts SDK_VERSION`, sdkConst && sdkConst[1], sdk);

const server = json(`${P.mcp}/server.json`);
expectEq(`${P.mcp}/server.json version`, server.version, mcp);
const npmEntry = (server.packages || []).find((p) => p.registryType === 'npm' && p.identifier === '@phototology/mcp');
expectEq(`${P.mcp}/server.json packages[@phototology/mcp].version`, npmEntry && npmEntry.version, mcp);

const dep = (mcpPkg.dependencies || {})['@phototology/sdk'];
if (!(dep === 'workspace:*' || dep === sdk)) {
  problems.push(`${P.mcp}/package.json dependency @phototology/sdk is ${JSON.stringify(dep)}: use "workspace:*" (pnpm pack pins the exact version) or exactly ${sdk}`);
}

for (const [name, dir, version] of [['@phototology/sdk', P.sdk, sdk], ['@phototology/mcp', P.mcp, mcp]]) {
  const heading = /^## \[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/m.exec(read(`${dir}/CHANGELOG.md`));
  expectEq(`${dir}/CHANGELOG.md newest released heading (${name})`, heading && heading[1], version);
}

// Website files exist only in the private repo; their paths live in a config
// that is never exported.
const privateCfg = join(ROOT, 'scripts/public-surface/versions-private.json');
if (mono && existsSync(privateCfg)) {
  const cfg = JSON.parse(readFileSync(privateCfg, 'utf8'));
  const src = read(cfg.versionsFile);
  const v = (k) => (new RegExp(`\\b${k}: '([^']+)'`).exec(src) || [])[1];
  expectEq(`${cfg.versionsFile} sdk`, v('sdk'), sdk);
  expectEq(`${cfg.versionsFile} mcp`, v('mcp'), mcp);
  // The website must quote versions through PUBLIC_PACKAGE_VERSIONS, not literals.
  for (const f of cfg.noLiterals) {
    const lit = /@phototology\/(?:sdk|mcp) \d+\.\d+\.\d+|code\s+version \d+\.\d+\.\d+/.exec(read(f));
    if (lit) problems.push(`${f}: hardcoded version "${lit[0]}"; use PUBLIC_PACKAGE_VERSIONS`);
  }
}

if (problems.length) {
  console.error(`check-versions: ${problems.length} mismatch(es) (sdk ${sdk}, mcp ${mcp}):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-versions: consistent (@phototology/sdk ${sdk}, @phototology/mcp ${mcp})`);
