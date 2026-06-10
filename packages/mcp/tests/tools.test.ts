import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools';

jest.mock('@phototology/sdk', () => ({
  // Mirror the authoritative constants so tool files' module-level
  // `Object.keys(LENS_FIELDS)` doesn't fail at import time. Keep this
  // in sync with src/lens-fields.ts in @phototology/sdk.
  LENS_FIELDS: { dating: ['estimatedDate'], people: ['peopleCount'] },
  PRESET_IDS: ['full-analysis', 'quick-scan'],
  PhototologyClient: jest.fn().mockImplementation(() => ({
    analyze: jest.fn().mockResolvedValue({
      id: 'ana_test123',
      object: 'analysis',
      outputSchema: 'photo',
      output: { estimatedDate: { year: 1990 } },
      usage: { totalTokens: 100, estimatedCostUsd: 0.001, modulesUsed: ['dating'] },
      meta: {
        requestId: 'req_test',
        processingTimeMs: 500,
        provider: 'test',
        promptHash: 'abc',
        ai_generated: true,
        model: 'gemini-2.0-flash',
        vendor: 'google',
      },
      warnings: [],
    }),
    modules: jest.fn().mockResolvedValue({
      modules: [{ name: 'dating', description: 'Date estimation', category: 'core', outputFields: ['estimatedDate'] }],
      presets: [{ name: 'full-analysis', description: 'Full analysis', modules: ['dating'] }],
    }),
    lookup: jest.fn().mockResolvedValue({
      object: 'lookup',
      results: {},
      meta: { imagesSubmitted: 0, imagesMatched: 0, processingTimeMs: 1, requestId: 'req_l' },
    }),
    usage: jest.fn().mockResolvedValue({
      tier: 'starter',
      community: { balance: 1000, monthlyAllowance: 1000, resetsInDays: 30 },
      purchased: { balance: 0 },
      reserved: 0,
    }),
  })),
}));

describe('registerTools', () => {
  let server: McpServer;

  beforeEach(() => {
    server = new McpServer({ name: 'test', version: '0.0.1' });
  });

  it('registers all seven tools in the expected order', () => {
    const toolSpy = jest.spyOn(server, 'registerTool');
    registerTools(server, 'pt_test_abc123');

    expect(toolSpy).toHaveBeenCalledTimes(7);
    const names = toolSpy.mock.calls.map((c) => c[0]);
    expect(names).toEqual([
      'analyze_photo',
      'analyze_batch',
      'list_lenses',
      'lookup_photo',
      'get_credits',
      'purchase_credits',
      'enrich_photo',
    ]);
  });

  it('marks every tool destructiveHint:false; only enrich_photo is non-read-only (it writes bytes)', () => {
    const toolSpy = jest.spyOn(server, 'registerTool');
    registerTools(server, 'pt_test_abc123');

    for (const call of toolSpy.mock.calls) {
      const name = call[0] as string;
      const config = call[1] as { annotations?: Record<string, unknown> };
      // enrich_photo writes bytes (either to disk via outputPath or in the
      // response payload). All other tools are pure reads.
      const expectedReadOnly = name !== 'enrich_photo';
      expect(config.annotations?.readOnlyHint).toBe(expectedReadOnly);
      expect(config.annotations?.destructiveHint).toBe(false);
    }
  });

  it('creates a singleton PhototologyClient with the provided API key', () => {
    const { PhototologyClient } = require('@phototology/sdk');
    registerTools(server, 'pt_test_mykey');

    expect(PhototologyClient).toHaveBeenCalledTimes(1);
    expect(PhototologyClient).toHaveBeenCalledWith({ apiKey: 'pt_test_mykey' });
  });
});

// Glama Tool Definition Quality floor: server score = 60% mean + 40% MIN, so
// the weakest tool sets the ceiling. Every description must answer the 6
// rubric questions (what / when / when-NOT / cost / returns / chains-with).
describe('tool description quality (Glama rubric floor — B2)', () => {
  function descriptions(): Record<string, string> {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const spy = jest.spyOn(server, 'registerTool');
    registerTools(server, 'pt_test_abc123');
    const out: Record<string, string> = {};
    for (const call of spy.mock.calls) {
      out[call[0] as string] = (call[1] as { description: string }).description;
    }
    return out;
  }

  it('every tool description clears the floor: length + cost + returns + a usage trigger', () => {
    const d = descriptions();
    expect(Object.keys(d)).toHaveLength(7);
    for (const [name, desc] of Object.entries(d)) {
      // min-length floor — a one-liner cannot carry the 6 rubric elements
      expect(desc.length).toBeGreaterThanOrEqual(250);
      // cost disclosure (agents reason about budget)
      expect(desc).toMatch(/credit|free|\$0\.01|cost/i);
      // returns shape
      expect(desc).toMatch(/returns?|output/i);
      // when-to-use trigger
      expect(desc).toMatch(/\buse (this|it|when)\b|useful when|when to use|call this|whenever|before any/i);
    }
  });

  it('the lifted FLOOR (get_credits + purchase_credits) carries an explicit when-NOT-to-use anti-trigger', () => {
    const d = descriptions();
    for (const name of ['get_credits', 'purchase_credits']) {
      expect(d[name]).toMatch(/when not to use|do not call|not needed/i);
    }
  });
});
