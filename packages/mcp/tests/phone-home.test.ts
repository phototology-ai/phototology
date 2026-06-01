import { phoneHome, mcpToolEvent } from '../src/phone-home';

describe('phoneHome', () => {
  let fetchMock: jest.Mock;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    delete process.env.PHOTOTOLOGY_MCP_NO_TELEMETRY;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    delete process.env.PHOTOTOLOGY_MCP_NO_TELEMETRY;
  });

  test('posts mcp_initialize with client info to /v1/mcp/event', () => {
    phoneHome(
      'mcp_initialize',
      { clientName: 'claude-desktop', clientVersion: '0.7.0', mcpVersion: '1.1.3' },
      { apiKey: 'pt_live_secret', baseUrl: 'https://api.phototology.com' },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.phototology.com/v1/mcp/event');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer pt_live_secret');
    expect(JSON.parse(init.body)).toEqual({
      event: 'mcp_initialize',
      clientName: 'claude-desktop',
      clientVersion: '0.7.0',
      mcpVersion: '1.1.3',
    });
  });

  test('uses the default base URL when none is provided', () => {
    phoneHome(
      'mcp_tools_list',
      { mcpVersion: '1.1.3' },
      { apiKey: 'pt_test_anything' },
    );

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.phototology.com/v1/mcp/event');
  });

  test('strips a trailing slash on baseUrl', () => {
    phoneHome(
      'mcp_initialize',
      { mcpVersion: '1.1.3' },
      { apiKey: 'pt_live_secret', baseUrl: 'http://localhost:3002/' },
    );

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3002/v1/mcp/event');
  });

  test('skips when PHOTOTOLOGY_MCP_NO_TELEMETRY=1', () => {
    process.env.PHOTOTOLOGY_MCP_NO_TELEMETRY = '1';
    phoneHome(
      'mcp_initialize',
      { mcpVersion: '1.1.3' },
      { apiKey: 'pt_live_secret' },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('skips when PHOTOTOLOGY_MCP_NO_TELEMETRY=true (case-insensitive)', () => {
    process.env.PHOTOTOLOGY_MCP_NO_TELEMETRY = 'TRUE';
    phoneHome(
      'mcp_initialize',
      { mcpVersion: '1.1.3' },
      { apiKey: 'pt_live_secret' },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('skips when apiKey is empty', () => {
    phoneHome(
      'mcp_initialize',
      { mcpVersion: '1.1.3' },
      { apiKey: '' },
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('does not throw when fetch rejects', () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    expect(() => {
      phoneHome(
        'mcp_initialize',
        { mcpVersion: '1.1.3' },
        { apiKey: 'pt_live_secret' },
      );
    }).not.toThrow();
    // The call still went out — the rejection is just swallowed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('returns synchronously (does not await the network call)', () => {
    // Slow fetch — if phoneHome awaited it, this test would hang.
    fetchMock.mockImplementation(() => new Promise(() => { /* never resolves */ }));
    const start = Date.now();
    phoneHome(
      'mcp_initialize',
      { mcpVersion: '1.1.3' },
      { apiKey: 'pt_live_secret' },
    );
    expect(Date.now() - start).toBeLessThan(50);
  });

  test('mcpToolEvent posts mcp_tool_called with defined props only', () => {
    mcpToolEvent(
      'analyze_photo',
      { ok: true, durationMs: 842, creditsCharged: 3, cacheHit: false, lensCount: 3 },
      { apiKey: 'pt_live_x', baseUrl: 'https://api.phototology.com' },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.phototology.com/v1/mcp/event');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      event: 'mcp_tool_called', tool: 'analyze_photo', ok: true,
      durationMs: 842, creditsCharged: 3, cacheHit: false, lensCount: 3,
    });
    // undefined enrichment must not appear in the JSON body
    expect('errorCode' in body).toBe(false);
    expect('photoCount' in body).toBe(false);
  });

  test('mcpToolEvent respects the NO_TELEMETRY opt-out', () => {
    process.env.PHOTOTOLOGY_MCP_NO_TELEMETRY = '1';
    mcpToolEvent('get_credits', { ok: true, durationMs: 5 }, { apiKey: 'pt_live_x' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
