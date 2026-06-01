import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn().mockImplementation(() => ({
      analyze: jest.fn(),
      modules: jest.fn(),
      lookup: jest.fn(),
      usage: jest.fn(),
    })),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerTools } = require('../src/tools');

function captureToolCallback(server: McpServer, toolName: string) {
  const spy = jest.spyOn(server, 'registerTool');
  registerTools(server, 'pt_test_abc123');
  const call = spy.mock.calls.find((c) => c[0] === toolName);
  if (!call) throw new Error(`Tool ${toolName} was not registered`);
  return call[2] as unknown as (args: any) => Promise<any>;
}

describe('purchase_credits tool', () => {
  it('returns the wallet deep-link with utm_source=mcp', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const callback = captureToolCallback(server, 'purchase_credits');
    const result = await callback({});

    expect(result.isError).toBeFalsy();

    const payload = JSON.parse(result.content[0].text);
    expect(payload.url).toMatch(/^https:\/\/phototology\.com\/wallet/);
    expect(payload.url).toContain('utm_source=mcp');
  });

  it('emits a structuredContent.actions open_url action with the same URL', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const callback = captureToolCallback(server, 'purchase_credits');
    const result = await callback({});

    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent.actions).toHaveLength(1);
    expect(result.structuredContent.actions[0]).toMatchObject({
      type: 'open_url',
      label: expect.stringMatching(/wallet|buy credits/i),
      url: expect.stringContaining('utm_source=mcp'),
    });

    // The url in the text fallback matches the url in the action.
    const payload = JSON.parse(result.content[0].text);
    expect(result.structuredContent.actions[0].url).toBe(payload.url);
  });

  it('does not call any SDK method (no credits, no network)', async () => {
    const { PhototologyClient } = require('@phototology/sdk');
    const instance = (PhototologyClient as jest.Mock).mock.results[0]?.value;

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const callback = captureToolCallback(server, 'purchase_credits');

    // Reset call counts on the SDK instance produced by registerTools.
    // (registerTools instantiates PhototologyClient; we just want to assert no
    // method on that client was hit by purchase_credits.)
    const sdkInstance = (PhototologyClient as jest.Mock).mock.results.at(-1)!.value;
    sdkInstance.analyze.mockClear();
    sdkInstance.modules.mockClear();
    sdkInstance.lookup.mockClear();
    sdkInstance.usage.mockClear();

    await callback({});

    expect(sdkInstance.analyze).not.toHaveBeenCalled();
    expect(sdkInstance.modules).not.toHaveBeenCalled();
    expect(sdkInstance.lookup).not.toHaveBeenCalled();
    expect(sdkInstance.usage).not.toHaveBeenCalled();
    // Suppress unused-var warning
    void instance;
  });
});
