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
