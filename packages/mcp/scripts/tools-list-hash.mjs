#!/usr/bin/env node
/**
 * tools-list-hash.mjs: print the sha256 of this server's tools/list result.
 *
 * Starts the BUILT server (../dist/index.js) over stdio, asks it for its tools
 * with the MCP SDK client, canonicalizes the JSON (object keys sorted at every
 * depth, array order kept, no whitespace) and prints the sha256 hex digest.
 * The mirror release workflow attaches this line to each @phototology/mcp
 * GitHub release as tools-list.sha256, so a user can check that the tool names,
 * descriptions and schemas they run are the ones that were published.
 *
 *   node scripts/tools-list-hash.mjs          # 64-hex digest + newline
 *   node scripts/tools-list-hash.mjs --json   # the canonical JSON that is hashed
 *
 * It never reaches the network. The server checks its API key against the API
 * at startup, so the script points PHOTOTOLOGY_BASE_URL at a local stub that
 * answers 404 to everything: the server logs a warning and starts anyway.
 * (A 401 from the real API would make it exit; a refused connection would cost
 * seconds of retries.) Telemetry is off via PHOTOTOLOGY_MCP_NO_TELEMETRY=1.
 * Run `pnpm build` first.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, '..', 'dist', 'index.js');

/** Sort object keys recursively; keep array order. */
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

async function main() {
  if (!existsSync(entry)) {
    throw new Error(`${entry} is missing. Run \`pnpm build\` first.`);
  }

  const stub = createServer((_req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"code":"NOT_FOUND","message":"tools-list-hash stub"}}');
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const { port } = stub.address();

  // Only what the server needs, so the caller's environment cannot change the hash.
  const env = {
    PATH: process.env.PATH ?? '',
    PHOTOTOLOGY_API_KEY: 'pt_test_hash',
    PHOTOTOLOGY_BASE_URL: `http://127.0.0.1:${port}`,
    PHOTOTOLOGY_MCP_NO_TELEMETRY: '1',
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env,
    stderr: 'ignore',
  });
  const client = new Client({ name: 'phototology-tools-list-hash', version: '1.0.0' });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    const json = JSON.stringify(canonicalize(result));
    if (process.argv.includes('--json')) {
      process.stdout.write(`${json}\n`);
    } else {
      process.stdout.write(`${createHash('sha256').update(json, 'utf8').digest('hex')}\n`);
    }
  } finally {
    await client.close().catch(() => {});
    stub.close();
  }
}

main().catch((err) => {
  console.error(`tools-list-hash: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
