/**
 * Public claims policy (design spec 2026-10-17, section 11). Every surface a
 * person or an agent can read must be free of the banned words and of em
 * dashes: README, SECURITY.md, skills, server.json, the server instructions,
 * every tool title and description, and every input-field `.describe()`.
 *
 * Tool text is captured from a real McpServer through a registerTool spy, with
 * the real @phototology/sdk, so the lens and stack names are the shipped ones.
 */
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools';
import { BANNED_PUBLIC_WORDS, findBannedWords, findEmDashes } from '../src/claims-policy';

const root = path.join(__dirname, '..');

function readFileSurfaces(): Record<string, string> {
  const out: Record<string, string> = {
    'README.md': fs.readFileSync(path.join(root, 'README.md'), 'utf8'),
    // Not in the npm tarball, but scripts/sync-phototology-public.sh copies it to the public GitHub mirror.
    'CHANGELOG.md': fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'),
    'SECURITY.md': fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8'),
    'server.json': fs.readFileSync(path.join(root, 'server.json'), 'utf8'),
  };
  const skillsDir = path.join(root, 'skills');
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === 'SKILL.md') out[path.relative(root, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(skillsDir);
  return out;
}

/** Collect every `description` string anywhere in a JSON Schema. */
function collectDescriptions(node: unknown, acc: string[]): string[] {
  if (Array.isArray(node)) {
    node.forEach((n) => collectDescriptions(n, acc));
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'description' && typeof v === 'string') acc.push(v);
      else collectDescriptions(v, acc);
    }
  }
  return acc;
}

function schemaText(schema: unknown): string[] {
  if (!schema) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: any = schema;
  const zodSchema = s._zod ? s : z.object(s);
  const json = z.toJSONSchema(zodSchema, { unrepresentable: 'any', io: 'input' });
  return collectDescriptions(json, []);
}

function readToolSurfaces(): Record<string, string> {
  const server = new McpServer({ name: 'claims-test', version: '0.0.0' });
  const spy = jest.spyOn(server, 'registerTool');
  registerTools(server, 'pt_test_abc123');
  const out: Record<string, string> = {};
  for (const [name, config] of spy.mock.calls as unknown as [string, Record<string, unknown>][]) {
    const parts = [
      String(config.title ?? ''),
      String(config.description ?? ''),
      ...schemaText(config.inputSchema),
      ...schemaText(config.outputSchema),
    ];
    out[`tool ${name}`] = parts.join('\n');
  }
  return out;
}

function readServerInstructions(): string {
  let text = '';
  const savedKey = process.env.PHOTOTOLOGY_API_KEY;
  process.env.PHOTOTOLOGY_API_KEY = 'pt_test_claimspolicy';
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  jest.isolateModules(() => {
    // src/index.ts boots a server on import; stub the transport, the tools, the resources,
    // and the network client, but keep the real lens and stack names.
    jest.doMock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
      McpServer: jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        registerTool: jest.fn(),
      })),
    }));
    jest.doMock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: jest.fn() }));
    // registerTools hands back the client src/index.ts uses for its key check.
    jest.doMock('../src/tools', () => ({
      registerTools: jest.fn(() => ({ modules: jest.fn().mockResolvedValue({ modules: [], presets: [] }) })),
    }));
    jest.doMock('../src/resources', () => ({ registerResources: jest.fn() }));
    jest.doMock('@phototology/sdk', () => {
      const actual = jest.requireActual('@phototology/sdk');
      return {
        ...actual,
        PhototologyClient: jest.fn().mockImplementation(() => ({
          modules: jest.fn().mockResolvedValue({ modules: [], presets: [] }),
        })),
      };
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    text = require('../src/index').buildServerInstructions();
  });
  exitSpy.mockRestore();
  if (savedKey === undefined) delete process.env.PHOTOTOLOGY_API_KEY;
  else process.env.PHOTOTOLOGY_API_KEY = savedKey;
  return text;
}

describe('public claims policy', () => {
  const surfaces: Record<string, string> = {
    ...readFileSurfaces(),
    ...readToolSurfaces(),
    'server instructions': readServerInstructions(),
  };

  test('captures every surface (seven tools, five skills, instructions, README, CHANGELOG)', () => {
    const keys = Object.keys(surfaces);
    expect(keys).toEqual(expect.arrayContaining(['README.md', 'CHANGELOG.md']));
    expect(keys.filter((k) => k.startsWith('tool '))).toHaveLength(7);
    expect(keys.filter((k) => k.endsWith('SKILL.md')).length).toBeGreaterThanOrEqual(5);
    expect(surfaces['server instructions']).toMatch(/lookup_photo/);
    // The describe strings really are captured, not just the descriptions.
    expect(surfaces['tool enrich_photo']).toMatch(/Which metadata blocks to write/);
  });

  test('no banned word in README, CHANGELOG, SECURITY.md, skills/**/SKILL.md, server instructions, server.json, or any tool description', () => {
    const hits = Object.entries(surfaces)
      .map(([where, text]) => ({ where, words: findBannedWords(text) }))
      .filter((h) => h.words.length > 0);
    expect(hits).toEqual([]);
  });

  test('no em dash on any of those surfaces', () => {
    const hits = Object.entries(surfaces)
      .map(([where, text]) => ({ where, count: findEmDashes(text) }))
      .filter((h) => h.count > 0);
    expect(hits).toEqual([]);
  });
});

describe('findBannedWords', () => {
  test('bites on a known positive', () => {
    expect(findBannedWords('an immutable record')).toEqual(['immutable']);
  });

  test('findBannedWords is case-insensitive and reports each word once', () => {
    expect(findBannedWords('Immutable. IMMUTABLE! immutable?')).toEqual(['immutable']);
    expect(findBannedWords('Tamper-Proof and Forensic-Grade')).toEqual(['forensic-grade', 'tamper-proof']);
  });

  test('uses word boundaries: authenticity is allowed, authentic is not', () => {
    expect(findBannedWords('the authenticity lens')).toEqual([]);
    expect(findBannedWords('an authentic photo')).toEqual(['authentic']);
    expect(findBannedWords('authenticated by us')).toEqual(['authenticated']);
  });

  test('matches multi-word phrases', () => {
    expect(findBannedWords('this file cannot be altered')).toEqual(['cannot be altered']);
    expect(findBannedWords('it is court-admissible')).toEqual(['court-admissible']);
  });

  test('allowed words pass', () => {
    expect(
      findBannedWords('a tamper-evident, signed, timestamped receipt from a first-sight witness and notary'),
    ).toEqual([]);
  });

  test('the list is exactly the spec list', () => {
    expect([...BANNED_PUBLIC_WORDS]).toEqual([
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
    ]);
  });
});

describe('findEmDashes', () => {
  test('counts U+2014 and ignores hyphens and en dashes', () => {
    expect(findEmDashes('a — b — c')).toBe(2);
    expect(findEmDashes('a - b – c')).toBe(0);
  });
});
