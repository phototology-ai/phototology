/**
 * Server instructions are shipped to every MCP client (Claude Code, Cursor,
 * VS Code Copilot, etc.) in the Initialize handshake. The pricing copy here
 * becomes the agent's system-level "how to use this tool" context, so it
 * must accurately reflect the current pricing model.
 *
 * After the pricing v1 launch (2026-05-17), the copy switched from the prior
 * "1,000 community credits per month" monthly grant to a signup ladder; since
 * 2026-10-17 that ladder is one rung: 1,000 credits on email verification
 * (the card-on-file step is retired).
 */

// Set env BEFORE the module is imported so the top-level "missing key"
// branch in src/index.ts doesn't call process.exit(1).
process.env.PHOTOTOLOGY_API_KEY = 'pt_test_serverinstructions';

// Stub the MCP SDK so constructing the server in index.ts is a no-op.
jest.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
  McpServer: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    registerTool: jest.fn(),
  })),
}));

jest.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: jest.fn(),
}));

// Skip the tool registration entirely; we're testing instructions text only.
jest.mock('../src/tools', () => ({
  registerTools: jest.fn(),
}));

// Stub the SDK so the lens-fields lookup at instruction-build time doesn't
// require pulling the whole sdk implementation, and so the client's modules()
// call in src/index.ts resolves harmlessly.
jest.mock('@phototology/sdk', () => ({
  LENS_FIELDS: { dating: ['estimatedDate'], people: ['peopleCount'] },
  PRESET_IDS: ['full-analysis', 'quick-scan'],
  AuthenticationError: class AuthenticationError extends Error {},
  PhototologyClient: jest.fn().mockImplementation(() => ({
    modules: jest.fn().mockResolvedValue({ modules: [], presets: [] }),
  })),
}));

// Don't let any unexpected top-level exit kill the runner.
jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);

import { buildServerInstructions } from '../src/index';

describe('buildServerInstructions — pricing v1', () => {
  const instructions = buildServerInstructions();

  it('mentions 1,000 free signup credits and never the retired 5,000', () => {
    expect(instructions).toMatch(/1,000 free credits/i);
    expect(instructions).not.toMatch(/5,000/);
  });

  it('does NOT mention 1,000 credits per month', () => {
    expect(instructions).not.toMatch(/1,000 credits per month/i);
  });

  it('does NOT mention the monthly community grant', () => {
    expect(instructions).not.toMatch(/community credits per month/i);
  });

  it('mentions $0.01 per credit', () => {
    expect(instructions).toMatch(/\$0\.01.+credit/i);
  });

  it('ties the grant to email verification and never mentions a card step', () => {
    expect(instructions).toMatch(/1,000.+(email|verify)/i);
    expect(instructions).not.toMatch(/4,000/);
    expect(instructions).not.toMatch(/card-on-file/i);
  });

  it('keeps the pack table intact ($10 / $100 / $1,000)', () => {
    expect(instructions).toMatch(/\$10/);
    expect(instructions).toMatch(/\$100/);
    expect(instructions).toMatch(/\$1,000/);
  });

  it('keeps the first-purchase 2x bonus', () => {
    expect(instructions).toMatch(/(first purchase|first pack).+(2x|doubles)/i);
  });

  it('NEW pricing paragraph has no em-dashes (customer-visible)', () => {
    // Locate the pricing paragraph by its anchor phrase, then assert no em-dash
    // appears in it. Older lines elsewhere in the instructions may still use
    // em-dashes; this test guards only the pricing-v1 paragraph.
    const pricingParagraph = instructions
      .split('\n')
      .find((line) => line.includes('Pricing: $0.01 per credit'));
    expect(pricingParagraph).toBeDefined();
    expect(pricingParagraph).not.toMatch(/—/);
  });

  it('mentions local-file input modes', () => {
    const text = buildServerInstructions();
    expect(text).toMatch(/imagePath/);
    expect(text.toLowerCase()).toMatch(/local file/);
  });
});
