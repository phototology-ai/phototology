import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return { ...actual, PhototologyClient: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerListLenses } = require('../src/tools/list-lenses');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ListLensesOutputSchema } = require('../src/schemas');

const BILLABLE = [
  'dating', 'people', 'location', 'atmosphere', 'entities', 'accessibility', 'photo-quality',
  'text-content', 'composition', 'describe', 'condition', 'authenticity', 'color-palette', 'automobile',
];

function lens(name: string, billable: boolean, internal = false) {
  return {
    name,
    description: `${name} lens`,
    category: 'core',
    outputFields: [`${name}Field`],
    billable,
    defaultColumns: [{ label: name, jsonPath: `$.${name}Field`, format: 'string' }],
    ...(internal ? { internal: true } : {}),
  };
}

const CATALOG = {
  modules: [
    ...BILLABLE.map((n) => lens(n, true)),
    lens('moderation', false),
    lens('vehicle-condition', false, true),
  ],
  presets: [
    // 14 billable lenses plus free moderation.
    { name: 'memorial', description: 'Memorial photos', modules: [...BILLABLE, 'moderation'] },
    // A member the catalog does not list (a prompt-engine internal) bills nothing.
    { name: 'vehicle-condition', description: 'Vehicle condition', modules: ['vehicle-base', 'vehicle-condition', 'automobile'] },
    { name: 'quick-scan', description: 'Quick scan', modules: ['dating', 'describe'] },
  ],
};

function makeMockClient(): any {
  return { modules: jest.fn().mockResolvedValue(CATALOG) };
}

function captureRegistration(client: any): { config: any; handler: (args: any) => Promise<any> } {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  const spy = jest.spyOn(server, 'registerTool');
  registerListLenses(server, client);
  const call = spy.mock.calls.find((c) => c[0] === 'list_lenses');
  if (!call) throw new Error('list_lenses not registered');
  return { config: call[1], handler: call[2] as (args: any) => Promise<any> };
}

describe('list_lenses typed result', () => {
  it('registers the list_lenses output schema', () => {
    expect(captureRegistration(makeMockClient()).config.outputSchema).toBe(ListLensesOutputSchema);
  });

  it('prices every lens and every stack per photo, and the result validates', async () => {
    const result = await captureRegistration(makeMockClient()).handler({});
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent;
    expect(ListLensesOutputSchema.safeParse(sc).success).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify(sc, null, 2) });

    const byLens = Object.fromEntries(sc.lenses.map((l: any) => [l.name, l]));
    expect(byLens.dating.credits).toBe(1);
    expect(byLens.moderation.credits).toBe(0);
    expect(byLens['vehicle-condition']).toEqual(expect.objectContaining({ credits: 0, internal: true }));

    const byStack = Object.fromEntries(sc.stacks.map((s: any) => [s.name, s]));
    expect(byStack.memorial).toEqual(expect.objectContaining({ lenses: [...BILLABLE, 'moderation'], credits: 14, usdPerPhoto: '0.14' }));
    expect(byStack['vehicle-condition']).toEqual(expect.objectContaining({ credits: 1, usdPerPhoto: '0.01' }));
    expect(byStack['quick-scan']).toEqual(expect.objectContaining({ credits: 2, usdPerPhoto: '0.02' }));
  });

  it('passes the MCP SDK output validation end to end', async () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerListLenses(server, makeMockClient());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'c', version: '0.0.1' });
    await mcpClient.connect(clientTransport);
    try {
      const { tools } = await mcpClient.listTools();
      const tool = tools.find((t: any) => t.name === 'list_lenses');
      expect(tool.outputSchema.properties).toEqual(expect.objectContaining({ lenses: expect.anything(), stacks: expect.anything() }));
      const result = await mcpClient.callTool({ name: 'list_lenses', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.stacks[0].usdPerPhoto).toBe('0.14');
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});
