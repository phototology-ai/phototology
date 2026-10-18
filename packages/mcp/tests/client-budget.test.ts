/**
 * The tools' SDK client must give up before an MCP client's 60 s request
 * timeout: a dead or slow API surfaces as a retryable tool error in about
 * 55 s, not as the client's "Request timed out" (2026-10-18 fix wave). Much
 * lower would fail real work: full analysis of one photo can take 20 to 30 s.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn().mockImplementation((config) => new actual.PhototologyClient(config)),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PhototologyClient } = require('@phototology/sdk');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerTools } = require('../src/tools');

const realFetch = global.fetch;

/** A fetch that never answers, except to honour an abort. */
function neverAnswers(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
}

function listLensesHandler(): (args: any) => Promise<any> {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  const spy = jest.spyOn(server, 'registerTool');
  registerTools(server, 'pt_live_budget', '@phototology/mcp/0.0.0-test');
  const call = spy.mock.calls.find((c) => c[0] === 'list_lenses');
  if (!call) throw new Error('list_lenses not registered');
  return call[2] as (args: any) => Promise<any>;
}

afterEach(() => {
  global.fetch = realFetch;
  jest.useRealTimers();
});

describe('the tools client budget', () => {
  it('is built with a 55 s total budget and the 10 s rate-limit wait cap', () => {
    listLensesHandler();
    expect(PhototologyClient).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'pt_live_budget',
      maxElapsedMs: 55_000,
      maxRateLimitWaitMs: 10_000,
    }));
  });

  it('an API that never answers gives a retryable tool error at 55 s, before the MCP client 60 s timeout', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    global.fetch = jest.fn(neverAnswers) as unknown as typeof fetch;
    const handler = listLensesHandler();

    let result: any;
    let settledAt: number | undefined;
    const start = Date.now();
    void handler({}).then((r) => { result = r; settledAt = Date.now() - start; });

    await jest.advanceTimersByTimeAsync(54_000);
    expect(result).toBeUndefined();

    await jest.advanceTimersByTimeAsync(6_000); // 60 s in
    expect(result).toBeDefined();
    expect(settledAt).toBeLessThanOrEqual(55_500);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/timed out/i);
    expect(result.structuredContent).toBeUndefined();
    expect(JSON.parse(result.content[0].text.split('\n')[0])).toEqual({ code: 'TIMEOUT', retryable: true });
  });
});
