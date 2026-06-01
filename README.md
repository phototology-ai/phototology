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

This repo is a public mirror of the relevant subdirectories from a private monorepo. Source changes flow one-way: monorepo → here. Issues and pull requests on the public packages are welcomed; the maintainer will sync fixes back to the monorepo.

The monorepo uses pnpm workspaces, TypeScript, jest (MCP) / vitest (SDK has light coverage), and ships through a sync script (`scripts/sync-phototology-public.sh` in the private repo).

## License

MIT — see [LICENSE](./LICENSE). Each package also carries its own copy of the MIT license in its directory.
