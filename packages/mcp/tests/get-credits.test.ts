import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const mockUsage = jest.fn();

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn().mockImplementation(() => ({
      analyze: jest.fn(),
      modules: jest.fn(),
      lookup: jest.fn(),
      usage: mockUsage,
    })),
  };
});

// Import after jest.mock so the SUT picks up the mock.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerTools } = require('../src/tools');

type ToolCallback = (args: any) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function captureToolCallback(server: McpServer, toolName: string): ToolCallback {
  const spy = jest.spyOn(server, 'registerTool');
  registerTools(server, 'pt_test_abc123');
  const call = spy.mock.calls.find((c) => c[0] === toolName);
  if (!call) throw new Error(`Tool ${toolName} was not registered`);
  return call[2] as unknown as ToolCallback;
}

beforeEach(() => {
  mockUsage.mockReset();
});

describe('get_credits tool', () => {
  it('returns the dual-pool balance from client.usage() as text JSON and structuredContent', async () => {
    mockUsage.mockResolvedValueOnce({
      tier: 'starter',
      community: { balance: 980, monthlyAllowance: 1000, resetsInDays: 14 },
      purchased: { balance: 0 },
      reserved: 2,
    });

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const callback = captureToolCallback(server, 'get_credits');
    const result = await callback({});

    expect(mockUsage).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();

    const text = JSON.parse(result.content[0].text);
    expect(text.tier).toBe('starter');
    expect(text.community.balance).toBe(980);
    expect(text.community.resetsInDays).toBe(14);
    expect(text.purchased.balance).toBe(0);
    expect(text.reserved).toBe(2);

    // structuredContent mirrors the raw API shape for rich clients.
    expect(result.structuredContent).toEqual(text);
  });

  it('surfaces SDK errors via the standard isError text path', async () => {
    mockUsage.mockRejectedValueOnce(new Error('network down'));
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const callback = captureToolCallback(server, 'get_credits');
    const result = await callback({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network down');
  });

  it('is registered with readOnlyHint, idempotentHint, destructiveHint:false', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const spy = jest.spyOn(server, 'registerTool');
    registerTools(server, 'pt_test_abc123');

    const call = spy.mock.calls.find((c) => c[0] === 'get_credits');
    expect(call).toBeDefined();
    const config = call![1] as { annotations: Record<string, unknown> };
    expect(config.annotations.readOnlyHint).toBe(true);
    expect(config.annotations.destructiveHint).toBe(false);
    expect(config.annotations.idempotentHint).toBe(true);
  });
});
