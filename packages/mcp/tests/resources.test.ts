import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return { ...actual, PhototologyClient: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerResources } = require('../src/resources');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { reshapeForMcp } = require('../src/tools/list-lenses');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ListLensesOutputSchema, LookupPhotoOutputSchema } = require('../src/schemas');

const SHA = 'b'.repeat(64);
const UNKNOWN = 'c'.repeat(64);

const CATALOG = {
  modules: [
    { name: 'dating', description: 'Dating lens', category: 'core', outputFields: ['estimatedDate'], billable: true, defaultColumns: [] },
    { name: 'moderation', description: 'Moderation lens', category: 'safety', outputFields: ['moderation'], billable: false, defaultColumns: [] },
  ],
  presets: [{ name: 'quick-scan', description: 'Quick scan', modules: ['dating', 'moderation'] }],
};

const RECORD = {
  sha256: SHA,
  pHash: 'f0f0f0f0f0f0f0f0',
  dHash: '0f0f0f0f0f0f0f0f',
  firstAnalyzedAt: '2026-10-01T00:00:00.000Z',
  lastAnalyzedAt: '2026-10-02T00:00:00.000Z',
  totalCreditsSpent: 1,
  analyzeCallCount: 1,
  lenses: {
    dating: {
      eventId: 'evt_1', output: { estimatedDate: { year: 1990 } }, version: '1.0.0',
      producedAt: '2026-10-01T00:00:00.000Z', coRunHash: 'h', provider: 'gemini',
    },
  },
};
const META = { imagesSubmitted: 1, imagesMatched: 1, processingTimeMs: 3, requestId: 'req_r' };
const HIT = { object: 'lookup', results: { [SHA]: { matchType: 'exact', photo: RECORD } }, meta: META };
const MISS = { object: 'lookup', results: { [UNKNOWN]: { matchType: 'none' } }, meta: { ...META, imagesMatched: 0 } };

function makeMockClient(): any {
  return {
    modules: jest.fn().mockResolvedValue(CATALOG),
    lookup: jest.fn(async ({ sha256 }: { sha256: string }) => (sha256 === SHA ? HIT : MISS)),
  };
}

async function connect(client: any): Promise<{ mcp: any; close: () => Promise<void> }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerResources(server, client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'c', version: '0.0.1' });
  await mcp.connect(clientTransport);
  return { mcp, close: () => mcp.close() };
}

describe('MCP resources', () => {
  it('resources/list returns phototology://lenses first, stable across calls', async () => {
    const { mcp, close } = await connect(makeMockClient());
    try {
      const first = await mcp.listResources();
      const second = await mcp.listResources();
      expect(first.resources[0]).toEqual(
        expect.objectContaining({
          uri: 'phototology://lenses',
          name: 'lenses',
          title: 'Lens and stack catalog',
          mimeType: 'application/json',
        }),
      );
      expect(second.resources.map((r: any) => r.uri)).toEqual(first.resources.map((r: any) => r.uri));
      // The photo template is not enumerated as a concrete resource.
      expect(first.resources.some((r: any) => r.uri.startsWith('phototology://photo/'))).toBe(false);
    } finally {
      await close();
    }
  });

  it('resources/templates/list returns the photo template', async () => {
    const { mcp, close } = await connect(makeMockClient());
    try {
      const { resourceTemplates } = await mcp.listResourceTemplates();
      expect(resourceTemplates).toEqual([
        expect.objectContaining({
          uriTemplate: 'phototology://photo/{sha256}',
          name: 'photo',
          title: 'A photo in the registry',
          mimeType: 'application/json',
        }),
      ]);
    } finally {
      await close();
    }
  });

  it('reading phototology://lenses returns the list_lenses structured output', async () => {
    const client = makeMockClient();
    const { mcp, close } = await connect(client);
    try {
      const res = await mcp.readResource({ uri: 'phototology://lenses' });
      expect(res.contents).toHaveLength(1);
      expect(res.contents[0]).toEqual(expect.objectContaining({ uri: 'phototology://lenses', mimeType: 'application/json' }));
      const parsed = JSON.parse(res.contents[0].text);
      expect(parsed).toEqual(reshapeForMcp(CATALOG));
      expect(ListLensesOutputSchema.safeParse(parsed).success).toBe(true);
      expect(parsed.stacks[0]).toEqual(expect.objectContaining({ name: 'quick-scan', credits: 1, usdPerPhoto: '0.01' }));
    } finally {
      await close();
    }
  });

  it('reading phototology://photo/<sha> returns the lookup envelope JSON with matchType', async () => {
    const client = makeMockClient();
    const { mcp, close } = await connect(client);
    try {
      const uri = `phototology://photo/${SHA}`;
      const res = await mcp.readResource({ uri });
      expect(client.lookup).toHaveBeenCalledWith({ sha256: SHA });
      expect(res.contents[0]).toEqual(expect.objectContaining({ uri, mimeType: 'application/json' }));
      const parsed = JSON.parse(res.contents[0].text);
      expect(parsed.matchType).toBe('exact');
      expect(parsed.photo.sha256).toBe(SHA);
      expect(parsed.resource).toBe(uri);
      expect(LookupPhotoOutputSchema.safeParse(parsed).success).toBe(true);
    } finally {
      await close();
    }
  });

  it('reading an unknown photo returns the PHOTO_NOT_IN_REGISTRY text, not an error', async () => {
    const { mcp, close } = await connect(makeMockClient());
    try {
      const uri = `phototology://photo/${UNKNOWN}`;
      const res = await mcp.readResource({ uri });
      expect(res.contents).toEqual([{ uri, mimeType: 'text/plain', text: 'PHOTO_NOT_IN_REGISTRY' }]);
    } finally {
      await close();
    }
  });

  it('a malformed sha256 returns PHOTO_NOT_IN_REGISTRY without calling the API', async () => {
    const client = makeMockClient();
    const { mcp, close } = await connect(client);
    try {
      for (const bad of ['xyz', 'a'.repeat(63), 'g'.repeat(64), `${'a'.repeat(64)}0`]) {
        const uri = `phototology://photo/${bad}`;
        const res = await mcp.readResource({ uri });
        expect(res.contents).toEqual([{ uri, mimeType: 'text/plain', text: 'PHOTO_NOT_IN_REGISTRY' }]);
      }
      expect(client.lookup).not.toHaveBeenCalled();
    } finally {
      await close();
    }
  });

  it('an uppercase sha256 is lowercased before the lookup', async () => {
    const client = makeMockClient();
    const { mcp, close } = await connect(client);
    try {
      const res = await mcp.readResource({ uri: `phototology://photo/${SHA.toUpperCase()}` });
      expect(client.lookup).toHaveBeenCalledWith({ sha256: SHA });
      expect(JSON.parse(res.contents[0].text).matchType).toBe('exact');
    } finally {
      await close();
    }
  });
});
