import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerAnalyzePhoto } = require('../src/tools/analyze-photo');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AnalyzePhotoOutputSchema } = require('../src/schemas');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { usdFromCredits, photoResourceUri, toAnalyzeEnvelope } = require('../src/lib/envelope');

const SHA = 'a'.repeat(64);

const FAKE_ANALYZE_RESPONSE = {
  id: 'ana_test123',
  object: 'analysis',
  livemode: true,
  outputSchema: 'photo',
  output: { estimatedDate: { year: 1990 }, peopleCount: 2 },
  usage: {
    inputTokens: 60,
    outputTokens: 40,
    totalTokens: 100,
    creditsCharged: 2,
    modulesUsed: ['dating', 'people'],
  },
  meta: {
    requestId: 'req_test',
    processingTimeMs: 5,
    provider: 'test',
    promptHash: 'abc',
    ai_generated: true,
    model: 'test',
    vendor: 'test',
  },
  warnings: [],
  fingerprint: { sha256: SHA, pHash: 'f0f0f0f0f0f0f0f0', dHash: '0f0f0f0f0f0f0f0f' },
};

function makeMockClient(overrides: Partial<{ analyze: jest.Mock }> = {}): any {
  return {
    analyze: jest.fn().mockResolvedValue(FAKE_ANALYZE_RESPONSE),
    ...overrides,
  };
}

function captureRegistration(client: any): { config: any; handler: (args: any) => Promise<any> } {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  const spy = jest.spyOn(server, 'registerTool');
  registerAnalyzePhoto(server, client);
  const call = spy.mock.calls.find((c) => c[0] === 'analyze_photo');
  if (!call) throw new Error('analyze_photo not registered');
  return { config: call[1], handler: call[2] as (args: any) => Promise<any> };
}

function captureHandler(client: any): (args: any) => Promise<any> {
  return captureRegistration(client).handler;
}

describe('analyze_photo input modes', () => {
  describe('imageUrl (backwards-compat)', () => {
    it('forwards imageUrl to client.analyze', async () => {
      const client = makeMockClient();
      const handler = captureHandler(client);
      await handler({
        imageUrl: 'https://example.com/photo.jpg',
        stack: 'full-analysis',
        includeEmbedding: false,
      });
      expect(client.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          imageUrl: 'https://example.com/photo.jpg',
        }),
      );
    });
  });

  describe('imageBase64', () => {
    it('forwards imageBase64 to client.analyze as imageBase64', async () => {
      const client = makeMockClient();
      const handler = captureHandler(client);
      const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');
      await handler({
        imageBase64: b64,
        stack: 'quick-scan',
        includeEmbedding: false,
      });
      expect(client.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          imageBase64: b64,
        }),
      );
    });

    it('rejects malformed base64 with INVALID_BASE64', async () => {
      const client = makeMockClient();
      const handler = captureHandler(client);
      const result = await handler({
        imageBase64: 'hello world!',
        stack: 'quick-scan',
        includeEmbedding: false,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('INVALID_BASE64');
      expect(client.analyze).not.toHaveBeenCalled();
    });
  });

  describe('imagePath', () => {
    let tmpDir: string;
    let jpegPath: string;
    // 20-byte minimal valid JPEG: magic bytes (FF D8 FF E0) + JFIF marker.
    // Needs >=8 bytes so detectFormat() in lib/local-image accepts it.
    const JPEG_BYTES = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
      0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
    ]);

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-analyze-photo-'));
      jpegPath = path.join(tmpDir, 'tiny.jpg');
      fs.writeFileSync(jpegPath, JPEG_BYTES);
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('reads imagePath, base64-encodes, forwards as imageBase64', async () => {
      const client = makeMockClient();
      const handler = captureHandler(client);
      await handler({
        imagePath: jpegPath,
        stack: 'quick-scan',
        includeEmbedding: false,
      });
      expect(client.analyze).toHaveBeenCalledWith(
        expect.objectContaining({
          imageBase64: JPEG_BYTES.toString('base64'),
        }),
      );
    });

    it('rejects relative path with RELATIVE_PATH_REJECTED', async () => {
      const client = makeMockClient();
      const handler = captureHandler(client);
      const result = await handler({
        imagePath: 'photos/relative.jpg',
        stack: 'quick-scan',
        includeEmbedding: false,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('RELATIVE_PATH_REJECTED');
      expect(client.analyze).not.toHaveBeenCalled();
    });

    it('rejects missing file with FILE_NOT_FOUND', async () => {
      const client = makeMockClient();
      const handler = captureHandler(client);
      const result = await handler({
        imagePath: path.join(tmpDir, 'missing.jpg'),
        stack: 'quick-scan',
        includeEmbedding: false,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('FILE_NOT_FOUND');
      expect(client.analyze).not.toHaveBeenCalled();
    });
  });

  describe('mutual exclusion', () => {
    it('rejects when both imageUrl and imagePath are provided', async () => {
      const client = makeMockClient();
      const handler = captureHandler(client);
      const result = await handler({
        imageUrl: 'https://example.com/a.jpg',
        imagePath: '/tmp/b.jpg',
        stack: 'quick-scan',
        includeEmbedding: false,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text.toLowerCase()).toMatch(/exactly one|only one|multiple/);
      expect(client.analyze).not.toHaveBeenCalled();
    });

    it('rejects when none are provided', async () => {
      const client = makeMockClient();
      const handler = captureHandler(client);
      const result = await handler({
        stack: 'quick-scan',
        includeEmbedding: false,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text.toLowerCase()).toMatch(/required|provide|one of|exactly one/);
      expect(client.analyze).not.toHaveBeenCalled();
    });
  });
});

describe('envelope helpers', () => {
  it('usdFromCredits renders two decimals at $0.01 per credit', () => {
    expect(usdFromCredits(0)).toBe('0.00');
    expect(usdFromCredits(2)).toBe('0.02');
    expect(usdFromCredits(29)).toBe('0.29');
    expect(usdFromCredits(1234)).toBe('12.34');
  });

  it('photoResourceUri points at the photo resource template', () => {
    expect(photoResourceUri(SHA)).toBe(`phototology://photo/${SHA}`);
  });

  it('toAnalyzeEnvelope prefers the API savings and dollar fields when present', () => {
    const env = toAnalyzeEnvelope({
      ...FAKE_ANALYZE_RESPONSE,
      usage: { ...FAKE_ANALYZE_RESPONSE.usage, creditsCharged: 1, creditsSaved: 1, usd: { charged: '0.01', saved: '0.01' } },
    }, SHA);
    expect(env.usage).toEqual(expect.objectContaining({ creditsCharged: 1, creditsSaved: 1, usd: { charged: '0.01', saved: '0.01' } }));
  });

  it('toAnalyzeEnvelope computes savings from meta.cacheHit when the API omits them (moderation is free, so not saved)', () => {
    const env = toAnalyzeEnvelope({
      ...FAKE_ANALYZE_RESPONSE,
      usage: { totalTokens: 0, creditsCharged: 0, modulesUsed: ['dating', 'people', 'moderation'] },
      meta: { ...FAKE_ANALYZE_RESPONSE.meta, cacheHit: true },
    }, SHA);
    expect(env.cacheHit).toBe(true);
    expect(env.usage.creditsSaved).toBe(2);
    expect(env.usage.usd).toEqual({ charged: '0.00', saved: '0.02' });
  });

  it('toAnalyzeEnvelope passes receipts and credentials through when present, and defaults receipts to []', () => {
    const plain = toAnalyzeEnvelope(FAKE_ANALYZE_RESPONSE, SHA);
    expect(plain.receipts).toEqual([]);
    expect(plain.credentials).toBeUndefined();
    const withProof = toAnalyzeEnvelope({ ...FAKE_ANALYZE_RESPONSE, receipts: [{ id: 'r1' }], credentials: { present: false } }, SHA);
    expect(withProof.receipts).toEqual([{ id: 'r1' }]);
    expect(withProof.credentials).toEqual({ present: false });
  });
});

describe('analyze_photo typed result', () => {
  it('registers the analyze_photo output schema', () => {
    const { config } = captureRegistration(makeMockClient());
    expect(config.outputSchema).toBe(AnalyzePhotoOutputSchema);
  });

  it('asks the API for the fingerprint so the result can name the photo', async () => {
    const client = makeMockClient();
    await captureHandler(client)({ imageUrl: 'https://example.com/a.jpg', stack: 'full-analysis', includeEmbedding: false });
    expect(client.analyze).toHaveBeenCalledWith(expect.objectContaining({
      options: expect.objectContaining({ includeFingerprint: true, includeEmbedding: false }),
    }));
  });

  it('returns structuredContent that validates, a matching text block, and a resource link', async () => {
    const result = await captureHandler(makeMockClient())({
      imageUrl: 'https://example.com/a.jpg', stack: 'full-analysis', includeEmbedding: false,
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent;
    expect(AnalyzePhotoOutputSchema.safeParse(sc).success).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify(sc, null, 2) });
    expect(result.content).toContainEqual({
      type: 'resource_link', uri: `phototology://photo/${SHA}`, name: SHA, mimeType: 'application/json',
    });
    expect(sc.photo).toEqual(expect.objectContaining({ sha256: SHA, pHash: 'f0f0f0f0f0f0f0f0', dHash: '0f0f0f0f0f0f0f0f' }));
    expect(sc.output).toEqual({ estimatedDate: { year: 1990 }, peopleCount: 2 });
    expect(sc.lenses).toEqual(['dating', 'people']);
    expect(sc.usage).toEqual(expect.objectContaining({
      creditsCharged: 2, creditsSaved: 0, usd: { charged: '0.02', saved: '0.00' }, modulesUsed: ['dating', 'people'],
    }));
    expect(sc.cacheHit).toBe(false);
    expect(sc.resource).toBe(`phototology://photo/${SHA}`);
    expect(sc.livemode).toBe(true);
  });

  it('keeps the embedding when the caller asked for it', async () => {
    const client = makeMockClient({ analyze: jest.fn().mockResolvedValue({ ...FAKE_ANALYZE_RESPONSE, embedding: [0.1, 0.2] }) });
    const result = await captureHandler(client)({ imageUrl: 'https://example.com/a.jpg', stack: 'full-analysis', includeEmbedding: true });
    expect(result.structuredContent.embedding).toEqual([0.1, 0.2]);
  });

  it('names a base64 photo by the hash of its bytes when the API sent no fingerprint', async () => {
    const { fingerprint: _omit, ...noFingerprint } = FAKE_ANALYZE_RESPONSE;
    const client = makeMockClient({ analyze: jest.fn().mockResolvedValue(noFingerprint) });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const expected = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const result = await captureHandler(client)({ imageBase64: bytes.toString('base64'), stack: 'quick-scan', includeEmbedding: false });
    expect(result.structuredContent.photo.sha256).toBe(expected);
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'resource_link', name: expected }));
  });

  // The pt_test_ sandbox answers includeFingerprint with a placeholder (sha256 of
  // 64 zeros). It names no real photo, so it must never become a resource.
  const SANDBOX = {
    ...FAKE_ANALYZE_RESPONSE,
    livemode: false,
    usage: { ...FAKE_ANALYZE_RESPONSE.usage, creditsCharged: 0 },
    fingerprint: { sha256: '0'.repeat(64), pHash: 'ff00ff00ff00ff00', dHash: '00ff00ff00ff00ff' },
  };

  it('a sandbox URL result names no photo and links to nothing', async () => {
    const client = makeMockClient({ analyze: jest.fn().mockResolvedValue(SANDBOX) });
    const result = await captureHandler(client)({ imageUrl: 'https://example.com/a.jpg', stack: 'full-analysis', includeEmbedding: false });
    const sc = result.structuredContent;
    expect(AnalyzePhotoOutputSchema.safeParse(sc).success).toBe(true);
    expect(sc.livemode).toBe(false);
    expect(sc.photo).toEqual(expect.objectContaining({ sha256: '', pHash: '', dHash: '' }));
    expect('resource' in sc).toBe(false);
    expect(result.content.some((c: any) => c.type === 'resource_link')).toBe(false);
  });

  it('a sandbox base64 result is named by the hash of its own bytes', async () => {
    const client = makeMockClient({ analyze: jest.fn().mockResolvedValue(SANDBOX) });
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const expected = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const result = await captureHandler(client)({ imageBase64: bytes.toString('base64'), stack: 'quick-scan', includeEmbedding: false });
    expect(result.structuredContent.photo.sha256).toBe(expected);
    expect(result.structuredContent.resource).toBe(`phototology://photo/${expected}`);
  });

  it('passes the MCP SDK output validation end to end', async () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerAnalyzePhoto(server, makeMockClient());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'c', version: '0.0.1' });
    await mcpClient.connect(clientTransport);
    try {
      const { tools } = await mcpClient.listTools();
      const tool = tools.find((t: any) => t.name === 'analyze_photo');
      expect(tool.outputSchema.properties).toEqual(expect.objectContaining({ photo: expect.anything(), usage: expect.anything() }));
      const result = await mcpClient.callTool({ name: 'analyze_photo', arguments: { imageUrl: 'https://example.com/a.jpg' } });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent.usage.usd.charged).toBe('0.02');
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});
