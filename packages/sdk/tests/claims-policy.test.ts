/**
 * Public claims policy for the SDK's public docs. README.md ships in the npm
 * tarball, and scripts/sync-phototology-public.sh copies both README.md and
 * CHANGELOG.md to the public GitHub mirror, so both are public copy.
 *
 * The list is kept here, not imported, because the mirror renames the package
 * folders (packages/sdk, packages/mcp) and copies tests, so no import by repo
 * folder name would resolve there. The last test pins it equal to the MCP's
 * list whenever the MCP source sits next to this package.
 */
import * as fs from 'fs';
import * as path from 'path';

const BANNED_PUBLIC_WORDS: readonly string[] = [
  'immutable',
  'authentic',
  'authenticated',
  'verified authentic',
  'proof of authenticity',
  'court-proven',
  'court-admissible',
  'forensic-grade',
  'ISO-certified',
  'tamper-proof',
  'cannot be altered',
];

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BANNED_PATTERNS = BANNED_PUBLIC_WORDS.map((word) => ({
  word,
  re: new RegExp(`\\b${escapeRegExp(word).replace(/ /g, '\\s+')}\\b`, 'i'),
}));
const findBannedWords = (text: string): string[] =>
  BANNED_PATTERNS.filter(({ re }) => re.test(text)).map(({ word }) => word);
const findEmDashes = (text: string): number => (text.match(/—/g) ?? []).length;

const root = path.join(__dirname, '..');
const surfaces = Object.fromEntries(
  ['README.md', 'CHANGELOG.md'].map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]),
);

describe('SDK public claims policy', () => {
  test('the scanner bites: a banned word and an em dash are caught', () => {
    expect(findBannedWords('an authenticated record')).toEqual(['authenticated']);
    expect(findBannedWords('the authenticity lens')).toEqual([]);
    expect(findEmDashes('a — b')).toBe(1);
  });

  test('no banned word in README.md or CHANGELOG.md', () => {
    const hits = Object.entries(surfaces)
      .map(([where, text]) => ({ where, words: findBannedWords(text) }))
      .filter((h) => h.words.length > 0);
    expect(hits).toEqual([]);
  });

  test('no em dash in README.md or CHANGELOG.md', () => {
    const hits = Object.entries(surfaces)
      .map(([where, text]) => ({ where, count: findEmDashes(text) }))
      .filter((h) => h.count > 0);
    expect(hits).toEqual([]);
  });

  // Monorepo folder name first, public-mirror folder name second.
  const mcpPolicy = ['../../phototology-mcp/src/claims-policy.ts', '../../mcp/src/claims-policy.ts']
    .map((rel) => path.join(__dirname, rel))
    .find((p) => fs.existsSync(p));
  const pinTest = mcpPolicy ? test : test.skip;
  pinTest(
    mcpPolicy
      ? 'the list equals the MCP BANNED_PUBLIC_WORDS'
      : 'the list equals the MCP BANNED_PUBLIC_WORDS (SKIPPED: MCP source not found next to this package)',
    () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mcp = require(mcpPolicy as string) as { BANNED_PUBLIC_WORDS: readonly string[] };
      expect([...BANNED_PUBLIC_WORDS]).toEqual([...mcp.BANNED_PUBLIC_WORDS]);
    },
  );
});
