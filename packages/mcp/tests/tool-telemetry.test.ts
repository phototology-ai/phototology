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

  it('enriches analyze_batch with photoCount/cacheHits/creditsCharged from structuredContent.summary', async () => {
    const handler = registerAndGet('analyze_batch');
    const result = await handler({ imageUrls: ['https://x/a.jpg', 'https://x/b.jpg'], lenses: ['dating'], refresh: true });
    expect(result.structuredContent.summary).toBeDefined();
    expect(toolEventSpy).toHaveBeenCalledTimes(1);
    const [tool, outcome] = toolEventSpy.mock.calls[0];
    expect(tool).toBe('analyze_batch');
    expect(outcome.ok).toBe(true);
    expect(outcome.photoCount).toBe(2);
    expect(outcome.cacheHits).toBe(2);
    expect(outcome.creditsCharged).toBe(4);
  });

  it('enriches enrich_photo with creditsCharged from usage (no lensCount)', async () => {
    const handler = registerAndGet('enrich_photo');
    await handler({ imageUrl: 'https://x/y.jpg' });
    expect(toolEventSpy).toHaveBeenCalledTimes(1);
    const [tool, outcome] = toolEventSpy.mock.calls[0];
    expect(tool).toBe('enrich_photo');
    expect(outcome.ok).toBe(true);
    expect(outcome.creditsCharged).toBe(5);
    expect(outcome.lensCount).toBeUndefined();
  });

  it('takes the enrich_photo creditsCharged from the structured envelope, not the text block', async () => {
    // A handler whose text block and structured envelope disagree proves which one is read.
    let outcome: any;
    let handler: (args: unknown) => Promise<unknown> = async () => undefined;
    let spy: jest.SpyInstance | undefined;
    jest.isolateModules(() => {
      jest.doMock('../src/tools/enrich-photo', () => ({
        registerEnrichPhoto: (server: any) => server.registerTool('enrich_photo', { description: 'd' }, async () => ({
          content: [{ type: 'text', text: JSON.stringify({ meta: { creditsCharged: 99 }, creditsCharged: 98 }) }],
          structuredContent: { usage: { creditsCharged: 7, usd: { charged: '0.07' } }, meta: { creditsCharged: 99 } },
        })),
      }));
      const isolatedPhoneHome = require('../src/phone-home');
      spy = jest.spyOn(isolatedPhoneHome, 'mcpToolEvent').mockImplementation((...args: any[]) => { outcome = args[1]; });
      const { registerTools: isolatedRegister } = require('../src/tools');
      const server = new McpServer({ name: 't', version: '0.0.1' });
      const calls: any[] = [];
      jest.spyOn(server, 'registerTool').mockImplementation(((...args: any[]) => { calls.push(args); return undefined as any; }) as any);
      isolatedRegister(server, 'pt_test_k');
      handler = calls.find((c) => c[0] === 'enrich_photo')[2];
    });
    await handler({});
    spy?.mockRestore();
    jest.dontMock('../src/tools/enrich-photo');
    expect(outcome.creditsCharged).toBe(7);
  });

  it('a dry-run batch reports ok and duration but no cache-hit or photo-count enrichment', async () => {
    const handler = registerAndGet('analyze_batch');
    const result = await handler({ imageUrls: ['https://x/a.jpg', 'https://x/b.jpg'], lenses: ['dating'], dryRun: true });
    expect(result.structuredContent.summary.dryRun).toBe(true);
    expect(toolEventSpy).toHaveBeenCalledTimes(1);
    const [, outcome] = toolEventSpy.mock.calls[0];
    expect(outcome.ok).toBe(true);
    expect(typeof outcome.durationMs).toBe('number');
    expect(outcome).not.toHaveProperty('cacheHits');
    expect(outcome).not.toHaveProperty('photoCount');
    expect(outcome).not.toHaveProperty('creditsCharged');
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
