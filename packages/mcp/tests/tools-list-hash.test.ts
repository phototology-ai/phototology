/**
 * scripts/tools-list-hash.mjs starts the BUILT server (dist/index.js) over
 * stdio, lists its tools with the MCP SDK client, and prints the sha256 of the
 * canonical JSON. The mirror release workflow attaches that line to each
 * @phototology/mcp GitHub release as tools-list.sha256, so anyone can check
 * that the tool surface they run is the one we published.
 *
 * Run `pnpm build` first: this test exercises dist/, not src/.
 */
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const root = path.join(__dirname, '..');
const script = path.join(root, 'scripts', 'tools-list-hash.mjs');
const dist = path.join(root, 'dist', 'index.js');

// The script must not depend on the caller's environment: no API key, no base
// URL. It sets its own and never reaches the network.
function run(args: string[] = []): string {
  const env = { ...process.env };
  delete env.PHOTOTOLOGY_API_KEY;
  delete env.PHOTOTOLOGY_BASE_URL;
  return execFileSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('tools-list-hash.mjs', () => {
  beforeAll(() => {
    if (!fs.existsSync(dist)) {
      throw new Error(`${dist} is missing. Run \`pnpm --filter @phototology/mcp build\` first.`);
    }
  });

  test('prints a single 64-hex sha256 line, and two runs agree', () => {
    const first = run();
    const second = run();
    expect(first).toMatch(/^[0-9a-f]{64}\n$/);
    expect(second).toBe(first);
  }, 60_000);

  test('the hash is the sha256 of the canonical tools/list JSON (--json)', () => {
    const json = run(['--json']);
    const parsed = JSON.parse(json);
    const names = parsed.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual([
      'analyze_batch',
      'analyze_photo',
      'enrich_photo',
      'get_credits',
      'list_lenses',
      'lookup_photo',
      'purchase_credits',
    ]);
    // Keys are sorted at every depth.
    const firstTool = parsed.tools[0];
    expect(Object.keys(firstTool)).toEqual([...Object.keys(firstTool)].sort());
    const hash = createHash('sha256').update(json.replace(/\n$/, ''), 'utf8').digest('hex');
    expect(run()).toBe(`${hash}\n`);
  }, 60_000);
});
