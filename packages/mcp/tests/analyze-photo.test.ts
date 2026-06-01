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

const FAKE_ANALYZE_RESPONSE = {
  id: 'ana_test123',
  object: 'analysis',
  outputSchema: 'photo',
  output: { estimatedDate: { year: 1990 } },
  usage: {
    totalTokens: 100,
    estimatedCostUsd: 0.001,
    creditsCharged: 1,
    modulesUsed: ['dating'],
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
};

function makeMockClient(overrides: Partial<{ analyze: jest.Mock }> = {}): any {
  return {
    analyze: jest.fn().mockResolvedValue(FAKE_ANALYZE_RESPONSE),
    ...overrides,
  };
}

function captureHandler(client: any): (args: any) => Promise<any> {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  const spy = jest.spyOn(server, 'registerTool');
  registerAnalyzePhoto(server, client);
  const call = spy.mock.calls.find((c) => c[0] === 'analyze_photo');
  if (!call) throw new Error('analyze_photo not registered');
  return call[2] as (args: any) => Promise<any>;
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
