import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CreditExhaustedError } from '@phototology/sdk';

/**
 * Shared mock client. Each test resets the relevant method with the behavior
 * it wants (throw a CreditExhaustedError, a generic error, or resolve).
 */
const mockAnalyze = jest.fn();
const mockModules = jest.fn();
const mockLookup = jest.fn();

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn().mockImplementation(() => ({
      analyze: mockAnalyze,
      modules: mockModules,
      lookup: mockLookup,
    })),
  };
});

// Import AFTER jest.mock so the SUT picks up the mock.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerTools } = require('../src/tools');

type ToolCallback = (args: any) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

/** Extract the registered callback for a given tool name from a server. */
function captureToolCallback(server: McpServer, toolName: string): ToolCallback {
  const spy = jest.spyOn(server, 'registerTool');
  registerTools(server, 'pt_test_abc123');
  const call = spy.mock.calls.find((c) => c[0] === toolName);
  if (!call) throw new Error(`Tool ${toolName} was not registered`);
  return call[2] as unknown as ToolCallback;
}

beforeEach(() => {
  mockAnalyze.mockReset();
  mockModules.mockReset();
  mockLookup.mockReset();
});

describe('MCP renders CreditExhaustedError as tool execution error', () => {
  it('analyze_photo returns isError:true with human-readable text on credit exhaustion', async () => {
    const creditErr = new CreditExhaustedError('Insufficient credits. 5 needed, 2 available.', {
      code: 'PLAN_LIMIT_EXCEEDED',
      status: 402,
      retryable: false,
      requestId: 'req_mcp_credit_1',
      creditsRequired: 5,
      communityBalance: 2,
      purchasedBalance: 0,
      totalBalance: 2,
      resetsInDays: 12,
    });
    mockAnalyze.mockRejectedValueOnce(creditErr);

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const analyzeCallback = captureToolCallback(server, 'analyze_photo');

    const result = await analyzeCallback({
      imageUrl: 'https://example.com/photo.jpg',
      preset: 'full-analysis',
      includeEmbedding: false,
    });

    // MCP spec: tool execution errors use isError:true, not a thrown protocol error.
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');

    const text = result.content[0].text;
    expect(text).toContain('OUT_OF_CREDITS');
    expect(text).toContain('NOT retryable');
    expect(text).toContain('STOP');
    expect(text).toContain('5 credits'); // creditsRequired
    expect(text).toContain('12 days'); // resetsInDays
    expect(text).toContain('https://phototology.com/wallet');
  });

  it('does not throw — callback resolves even though SDK rejected', async () => {
    mockAnalyze.mockRejectedValueOnce(
      new CreditExhaustedError('Out of credits', {
        code: 'PLAN_LIMIT_EXCEEDED',
        status: 402,
        retryable: false,
        requestId: 'req_mcp_credit_2',
        creditsRequired: 1,
        communityBalance: 0,
        purchasedBalance: 0,
        totalBalance: 0,
        resetsInDays: 3,
      }),
    );

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const analyzeCallback = captureToolCallback(server, 'analyze_photo');

    await expect(
      analyzeCallback({
        imageUrl: 'https://example.com/photo.jpg',
        preset: 'full-analysis',
        includeEmbedding: false,
      }),
    ).resolves.toBeDefined();
  });

  it('omits the community-reset sentence when resetsInDays is missing', async () => {
    mockAnalyze.mockRejectedValueOnce(
      new CreditExhaustedError('Out of credits', {
        code: 'PLAN_LIMIT_EXCEEDED',
        status: 402,
        retryable: false,
        requestId: 'req_mcp_credit_3',
        creditsRequired: 3,
        communityBalance: 0,
        purchasedBalance: 1,
        totalBalance: 1,
        // no resetsInDays — purchased-only user
      }),
    );

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const analyzeCallback = captureToolCallback(server, 'analyze_photo');

    const result = await analyzeCallback({
      imageUrl: 'https://example.com/photo.jpg',
      preset: 'full-analysis',
      includeEmbedding: false,
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain('OUT_OF_CREDITS');
    expect(text).toContain('3 credits');
    expect(text).not.toContain('auto-refill');
    expect(text).toContain('https://phototology.com/wallet');
  });

  it('non-credit errors still surface their generic message (existing behavior preserved)', async () => {
    mockAnalyze.mockRejectedValueOnce(new Error('boom'));

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const analyzeCallback = captureToolCallback(server, 'analyze_photo');

    const result = await analyzeCallback({
      imageUrl: 'https://example.com/photo.jpg',
      preset: 'full-analysis',
      includeEmbedding: false,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('boom');
    expect(result.content[0].text).not.toContain('OUT_OF_CREDITS');
  });
});
