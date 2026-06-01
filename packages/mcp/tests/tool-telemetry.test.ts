/**
 * Tests for the tool-call telemetry wrapper in src/tools/index.ts.
 *
 * registerTools wraps every tool handler (via a transparent registerTool
 * Proxy) so each invocation emits one `mcp_tool_called` event. These tests
 * pin: base shape (tool/ok/durationMs), analyze enrichment, the local-failure
 * error path (the gap api_request can't see), and that telemetry failure never
 * breaks the tool.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools';
import * as phoneHome from '../src/phone-home';

jest.mock('@phototology/sdk', () => ({
  LENS_FIELDS: { dating: ['estimatedDate'], people: ['peopleCount'] },
  PRESET_IDS: ['full-analysis', 'quick-scan'],
  PhototologyClient: jest.fn().mockImplementation(() => ({
    analyze: jest.fn().mockResolvedValue({
      id: 'ana_x', object: 'analysis', outputSchema: 'photo',
      output: { estimatedDate: { year: 1990 } },
      usage: { creditsCharged: 2, modulesUsed: ['dating', 'people'] },
      meta: { cacheHit: true }, // real API field name (NOT registryCacheHit)
      warnings: [],
    }),
    modules: jest.fn().mockResolvedValue({ modules: [], presets: [] }),
    lookup: jest.fn().mockResolvedValue({ object: 'lookup', results: {}, meta: {} }),
    usage: jest.fn().mockResolvedValue({ tier: 'starter', community: { balance: 1, resetsInDays: 0 }, purchased: { balance: 0 }, reserved: 0 }),
    enrich: jest.fn().mockResolvedValue({ object: 'enrichment', imageBase64: '', formatsWritten: ['xmp'], lensVersions: { dating: '1.0' }, sha256: 'abc', meta: { requestId: 'r', processingTimeMs: 1, creditsCharged: 5, ai_generated: true } }),
  })),
}));

describe('tool telemetry', () => {
  let toolEventSpy: jest.SpyInstance;

  beforeEach(() => {
    toolEventSpy = jest.spyOn(phoneHome, 'mcpToolEvent').mockImplementation(() => {});
  });
  afterEach(() => { toolEventSpy.mockRestore(); });

  /** Register all tools, return the (instrumented) handler for one tool name. */
  function registerAndGet(toolName: string): (args: any) => Promise<any> {
    const server = new McpServer({ name: 't', version: '0.0.1' });
    const calls: Array<[string, unknown, (args: any) => Promise<any>]> = [];
    jest.spyOn(server, 'registerTool').mockImplementation(((name: any, config: any, handler: any) => {
      calls.push([name, config, handler]);
      return undefined as any;
    }) as any);
    registerTools(server, 'pt_test_k');
    const found = calls.find((c) => c[0] === toolName);
    if (!found) throw new Error(`tool ${toolName} not registered`);
    return found[2];
  }

  it('fires mcp_tool_called with ok + duration on success', async () => {
    const handler = registerAndGet('get_credits');
    await handler({});
    expect(toolEventSpy).toHaveBeenCalledTimes(1);
    const [tool, outcome] = toolEventSpy.mock.calls[0];
    expect(tool).toBe('get_credits');
    expect(outcome.ok).toBe(true);
    expect(typeof outcome.durationMs).toBe('number');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('enriches analyze_photo with lensCount/creditsCharged/cacheHit', async () => {
    const handler = registerAndGet('analyze_photo');
    await handler({ imageUrl: 'https://x/y.jpg', stack: 'full-analysis', includeEmbedding: false });
    expect(toolEventSpy).toHaveBeenCalledTimes(1);
    const [tool, outcome] = toolEventSpy.mock.calls[0];
    expect(tool).toBe('analyze_photo');
    expect(outcome.ok).toBe(true);
    expect(outcome.creditsCharged).toBe(2);
    expect(outcome.lensCount).toBe(2);
    expect(outcome.cacheHit).toBe(true);
  });

  it('enriches enrich_photo with creditsCharged from meta (no lensCount)', async () => {
    const handler = registerAndGet('enrich_photo');
    await handler({ imageUrl: 'https://x/y.jpg' });
    expect(toolEventSpy).toHaveBeenCalledTimes(1);
    const [tool, outcome] = toolEventSpy.mock.calls[0];
    expect(tool).toBe('enrich_photo');
    expect(outcome.ok).toBe(true);
    expect(outcome.creditsCharged).toBe(5);
    expect(outcome.lensCount).toBeUndefined();
  });

  it('reports ok:false + errorCode on a local-image failure', async () => {
    const handler = registerAndGet('analyze_photo');
    // No image input → LocalImageError(UNSUPPORTED_FORMAT), rendered isError:true.
    await handler({ stack: 'full-analysis', includeEmbedding: false });
    expect(toolEventSpy).toHaveBeenCalledTimes(1);
    const [, outcome] = toolEventSpy.mock.calls[0];
    expect(outcome.ok).toBe(false);
    expect(outcome.errorCode).toBe('UNSUPPORTED_FORMAT');
  });

  it('never throws if telemetry itself errors', async () => {
    toolEventSpy.mockImplementation(() => { throw new Error('boom'); });
    const handler = registerAndGet('get_credits');
    await expect(handler({})).resolves.toBeDefined();
  });
});
