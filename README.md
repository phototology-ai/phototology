# Phototology

> Persistent memory for visual intelligence.

[phototology.com](https://phototology.com) · [npm scope: @phototology](https://www.npmjs.com/org/phototology)

Phototology is a visual-intelligence platform that analyzes a photo once and remembers the result forever, keyed by perceptual hash. Re-running any analysis on the same image — by any client, on any future day — returns the cached structured result for free.

This repository is the public source for the three npm packages that surround the platform. The Phototology API itself runs as a hosted service at [api.phototology.com](https://api.phototology.com).

## Packages

| Package | Purpose | npm |
|---------|---------|-----|
| [`@phototology/sdk`](./packages/sdk) | TypeScript client SDK | [npmjs.com/package/@phototology/sdk](https://www.npmjs.com/package/@phototology/sdk) |
| [`@phototology/mcp`](./packages/mcp) | Model Context Protocol server for Claude Code, Cursor, VS Code, and other AI coding assistants | [npmjs.com/package/@phototology/mcp](https://www.npmjs.com/package/@phototology/mcp) |
| [`phototology`](./packages/phototology) | Unscoped flagship placeholder; reserves the bare name and points to the working packages | [npmjs.com/package/phototology](https://www.npmjs.com/package/phototology) |

Each package has its own README and CHANGELOG in its directory.

## Quick start

**Use the MCP in Claude Code, Cursor, or VS Code** (no API key needed for the test sandbox):

```bash
npx -y @phototology/mcp
```

For a real API key, sign up at [phototology.com](https://phototology.com).

**Use the SDK programmatically:**

```bash
npm install @phototology/sdk
```

```ts
import { PhototologyClient } from '@phototology/sdk';

const client = new PhototologyClient({ apiKey: process.env.PHOTOTOLOGY_API_KEY });
const result = await client.analyze({
  imageUrl: 'https://example.com/photo.jpg',
  lenses: ['dating', 'people', 'location'],
});
console.log(result);
```

## How it's built

This repo is a public mirror of the package folders from a private monorepo. Changes flow one way: upstream → here. Issues and pull requests are welcome; fixes are applied upstream and synced back.

- **CI** runs on every push and pull request: a frozen install from the committed `pnpm-lock.yaml`, typecheck, tests, build, a check that each npm tarball contains exactly the files in its `pack-manifest.json`, gitleaks, and the public-surface guard.
- **Releases** are published from this repo by `.github/workflows/release.yml`, to npm with provenance (trusted publishing, no npm token), with a GitHub release carrying an SBOM, and to the MCP Registry.

## What is (and isn't) in this repo

Only what an explicit allowlist (`public-surface.allowlist`) permits is synced here, read from git, and every sync is checked by `scripts/public-surface/check.mjs` before it is pushed. That check rejects secrets, any customer or personal data (including derived hashes, EXIF, filenames and IDs), production-derived fixtures, internal docs and agent notes, infrastructure names and private paths. Test fixtures are synthetic or public-domain (see each `tests/fixtures/SOURCES.md`).

Found something here that shouldn't be public? Please report it privately as described in [packages/mcp/SECURITY.md](./packages/mcp/SECURITY.md).

## License

MIT — see [LICENSE](./LICENSE). Each package also carries its own copy of the MIT license in its directory.
