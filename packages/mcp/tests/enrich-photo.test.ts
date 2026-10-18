/**
 * Tests for the enrich_photo MCP tool (item-048).
 *
 * Mirrors the analyze_photo.test.ts pattern: mocks PhototologyClient and
 * captures the registered tool handler. Validates:
 *   - imageUrl, imageBase64, imagePath input modes
 *   - outputPath flag writes enriched bytes to disk + alters response shape
 *   - PHOTO_NOT_IN_REGISTRY error is rendered structurally
 *   - Multi-input refinement is enforced
 *   - Typed result: Zod outputSchema, structuredContent, preview image block
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import sharp from 'sharp';
import { EnrichPhotoOutputSchema } from '../src/schemas';

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerEnrichPhoto } = require('../src/tools/enrich-photo');

const ENRICHED_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xaa, 0xbb]);
const ENRICHED_B64 = ENRICHED_BYTES.toString('base64');

const FAKE_ENRICH_RESPONSE = {
  object: 'enrichment',
  imageBase64: ENRICHED_B64,
  formatsWritten: ['xmp'],
  lensVersions: { dating: '1.0' },
  sha256: 'deadbeef'.repeat(8),
  meta: {
    requestId: 'req_test',
    processingTimeMs: 50,
    creditsCharged: 5,
    ai_generated: true,
  },
};

// Minimal valid JPEG bytes for the imagePath happy path (>=8 bytes for magic).
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
  0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
]);

function makeMockClient(overrides: Partial<{ enrich: jest.Mock }> = {}): any {
  return {
    enrich: jest.fn().mockResolvedValue(FAKE_ENRICH_RESPONSE),
    ...overrides,
  };
}

function captureHandler(client: any): (args: any) => Promise<any> {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  const spy = jest.spyOn(server, 'registerTool');
  registerEnrichPhoto(server, client);
  const call = spy.mock.calls.find((c) => c[0] === 'enrich_photo');
  if (!call) throw new Error('enrich_photo not registered');
  return call[2] as (args: any) => Promise<any>;
}

describe('enrich_photo input modes', () => {
  it('forwards imageUrl to client.enrich', async () => {
    const client = makeMockClient();
    const handler = captureHandler(client);
    await handler({ imageUrl: 'https://example.com/p.jpg' });
    expect(client.enrich).toHaveBeenCalledWith({
      imageUrl: 'https://example.com/p.jpg',
      formats: ['xmp'],
    });
  });

  it('forwards imageBase64 as imageBase64', async () => {
    const client = makeMockClient();
    const handler = captureHandler(client);
    const b64 = JPEG_BYTES.toString('base64');
    await handler({ imageBase64: b64, formats: ['exif', 'iptc', 'xmp'] });
    expect(client.enrich).toHaveBeenCalledWith({
      imageBase64: b64,
      formats: ['exif', 'iptc', 'xmp'],
    });
  });

  it('reads imagePath from disk and forwards bytes as imageBase64', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-enrich-'));
    const jpegPath = path.join(tmpDir, 'in.jpg');
    fs.writeFileSync(jpegPath, JPEG_BYTES);

    try {
      const client = makeMockClient();
      const handler = captureHandler(client);
      await handler({ imagePath: jpegPath });
      const call = client.enrich.mock.calls[0][0];
      expect(call.imageBase64).toBe(JPEG_BYTES.toString('base64'));
      expect(call.imageUrl).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('defaults formats to ["xmp"] when omitted', async () => {
    const client = makeMockClient();
    const handler = captureHandler(client);
    await handler({ imageUrl: 'https://example.com/p.jpg' });
    expect(client.enrich.mock.calls[0][0].formats).toEqual(['xmp']);
  });
});

describe('enrich_photo outputPath', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-enrich-out-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes enriched bytes to disk when outputPath is provided', async () => {
    const outPath = path.join(tmpDir, 'enriched.jpg');
    const client = makeMockClient();
    const handler = captureHandler(client);
    const result = await handler({
      imageUrl: 'https://example.com/p.jpg',
      outputPath: outPath,
    });

    expect(result.isError).toBeFalsy();
    expect(fs.existsSync(outPath)).toBe(true);
    const written = fs.readFileSync(outPath);
    expect(Buffer.compare(written, ENRICHED_BYTES)).toBe(0);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.savedTo).toBe(outPath);
    expect(payload.formatsWritten).toEqual(['xmp']);
    expect(payload.lensVersions).toEqual({ dating: '1.0' });
    expect(payload.usage).toEqual({ creditsCharged: 5, usd: { charged: '0.05' } });
    // No imageBase64 in the savedTo response — agent doesn't need the bytes.
    expect(payload.imageBase64).toBeUndefined();
  });

  it('returns imageBase64 in response when outputPath is omitted', async () => {
    const client = makeMockClient();
    const handler = captureHandler(client);
    const result = await handler({ imageUrl: 'https://example.com/p.jpg' });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.imageBase64).toBe(ENRICHED_B64);
    expect(payload.savedTo).toBeUndefined();
  });

  it('rejects outputPath when directory does not exist (fails before spending credits)', async () => {
    const client = makeMockClient();
    const handler = captureHandler(client);
    const result = await handler({
      imageUrl: 'https://example.com/p.jpg',
      outputPath: '/nonexistent/dir/photo.jpg',
    });
    expect(result.isError).toBe(true);
    expect(client.enrich).not.toHaveBeenCalled();
  });
});

describe('enrich_photo input validation', () => {
  it('rejects when no image input is provided', async () => {
    const client = makeMockClient();
    const handler = captureHandler(client);
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(client.enrich).not.toHaveBeenCalled();
  });

  it('rejects when multiple image inputs are provided', async () => {
    const client = makeMockClient();
    const handler = captureHandler(client);
    const result = await handler({
      imageUrl: 'https://example.com/p.jpg',
      imageBase64: 'AAAA',
    });
    expect(result.isError).toBe(true);
    expect(client.enrich).not.toHaveBeenCalled();
  });
});

describe('enrich_photo error rendering', () => {
  it('renders SDK error message in the tool result on PHOTO_NOT_IN_REGISTRY', async () => {
    const enrich = jest.fn().mockRejectedValueOnce(
      new Error('Analyze this photo first before requesting enrichment.'),
    );
    const client = makeMockClient({ enrich });
    const handler = captureHandler(client);
    const result = await handler({ imageUrl: 'https://example.com/p.jpg' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Analyze this photo first');
  });
});

// A real JPEG, so the preview path can decode the enriched bytes.
let REAL_JPEG: Buffer;
beforeAll(async () => {
  REAL_JPEG = await sharp({
    create: { width: 1500, height: 1000, channels: 3, background: { r: 120, g: 80, b: 40 } },
  }).jpeg().toBuffer();
});

function realResponse(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...FAKE_ENRICH_RESPONSE, imageBase64: REAL_JPEG.toString('base64'), ...extra };
}

/** What the API returns when writing into the file would break its Content Credential (spec 8.4). */
const SIDECAR_RESPONSE = {
  object: 'enrichment',
  mode: 'sidecar',
  sidecar: { xmp: '<x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta>' },
  formatsWritten: ['xmp'],
  lensVersions: { dating: '1.0' },
  sha256: 'deadbeef'.repeat(8),
  credentials: { status: 'valid' },
  reason: 'Writing into the file would invalidate its Content Credential.',
  meta: { requestId: 'req_side', processingTimeMs: 40, creditsCharged: 5, ai_generated: true },
};

function imageBlocks(result: any): any[] {
  return result.content.filter((c: any) => c.type === 'image');
}

describe('enrich_photo typed result', () => {
  it('registers the Zod envelope as outputSchema and describes the preview', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const spy = jest.spyOn(server, 'registerTool');
    registerEnrichPhoto(server, makeMockClient());
    const config = spy.mock.calls.find((c) => c[0] === 'enrich_photo')![1] as any;
    expect(config.outputSchema).toBe(EnrichPhotoOutputSchema);
    expect(config.description).toContain('preview');
    expect(config.description).toContain('150 KB');
    expect(config.description).toContain('usage.creditsCharged');
  });

  it('URL input without outputPath: structuredContent validates, keeps imageBase64, adds a 1024 px preview', async () => {
    const client = makeMockClient({ enrich: jest.fn().mockResolvedValue(realResponse()) });
    const result = await captureHandler(client)({ imageUrl: 'https://example.com/p.jpg' });

    expect(result.isError).toBeFalsy();
    const sc = EnrichPhotoOutputSchema.parse(result.structuredContent);
    expect(sc.mode).toBe('file');
    expect(sc.imageBase64).toBe(REAL_JPEG.toString('base64'));
    expect(sc.savedTo).toBeUndefined();
    expect(sc.sha256).toBe('deadbeef'.repeat(8));
    expect(sc.usage).toEqual({ creditsCharged: 5, usd: { charged: '0.05' } });

    const images = imageBlocks(result);
    expect(images).toHaveLength(1);
    expect(images[0].mimeType).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(images[0].data, 'base64')).metadata();
    expect(meta.width).toBe(1024);
    expect(meta.height).toBe(683);
  });

  it('base64 input without outputPath keeps imageBase64 in the structured output', async () => {
    const client = makeMockClient({ enrich: jest.fn().mockResolvedValue(realResponse()) });
    const result = await captureHandler(client)({ imageBase64: JPEG_BYTES.toString('base64') });
    expect(result.structuredContent.imageBase64).toBe(REAL_JPEG.toString('base64'));
    expect(imageBlocks(result)).toHaveLength(1);
  });

  it('imagePath without outputPath keeps imageBase64, so the paid bytes are never lost', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-enrich-path-'));
    try {
      const inPath = path.join(tmp, 'in.jpg');
      fs.writeFileSync(inPath, JPEG_BYTES);
      const client = makeMockClient({ enrich: jest.fn().mockResolvedValue(realResponse()) });
      const result = await captureHandler(client)({ imagePath: inPath });
      expect(result.structuredContent.imageBase64).toBe(REAL_JPEG.toString('base64'));
      expect(result.structuredContent.savedTo).toBeUndefined();
      expect(imageBlocks(result)).toHaveLength(1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('outputPath: savedTo, no imageBase64, still a preview block', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-enrich-typed-'));
    try {
      const outPath = path.join(tmp, 'out.jpg');
      const client = makeMockClient({ enrich: jest.fn().mockResolvedValue(realResponse()) });
      const result = await captureHandler(client)({ imageUrl: 'https://example.com/p.jpg', outputPath: outPath });
      const sc = EnrichPhotoOutputSchema.parse(result.structuredContent);
      expect(sc.savedTo).toBe(outPath);
      expect(sc.imageBase64).toBeUndefined();
      expect(sc.mode).toBe('file');
      expect(imageBlocks(result)).toHaveLength(1);
      expect(Buffer.compare(fs.readFileSync(outPath), REAL_JPEG)).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('sidecar mode: no image block, the packet and reason pass through, nothing is written', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-enrich-side-'));
    try {
      const outPath = path.join(tmp, 'out.jpg');
      const client = makeMockClient({ enrich: jest.fn().mockResolvedValue(SIDECAR_RESPONSE) });
      const result = await captureHandler(client)({ imageUrl: 'https://example.com/p.jpg', outputPath: outPath });
      expect(result.isError).toBeFalsy();
      expect(imageBlocks(result)).toHaveLength(0);
      const sc = EnrichPhotoOutputSchema.parse(result.structuredContent);
      expect(sc.mode).toBe('sidecar');
      expect(sc.sidecar?.xmp).toContain('xmpmeta');
      expect(sc.reason).toContain('Content Credential');
      expect(sc.credentials).toEqual({ status: 'valid' });
      expect(sc.imageBase64).toBeUndefined();
      expect(sc.savedTo).toBeUndefined();
      expect(fs.existsSync(outPath)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('bytes that cannot be decoded: the paid result still returns, with a warning and no image block', async () => {
    const client = makeMockClient(); // FAKE_ENRICH_RESPONSE carries 8 bytes that are not a decodable JPEG
    const result = await captureHandler(client)({ imageUrl: 'https://example.com/p.jpg' });
    expect(result.isError).toBeFalsy();
    expect(imageBlocks(result)).toHaveLength(0);
    const sc = EnrichPhotoOutputSchema.parse(result.structuredContent);
    expect(sc.imageBase64).toBe(ENRICHED_B64);
    expect(sc.warnings).toEqual([expect.stringContaining('preview')]);
  });

  it('passes the MCP SDK output validation end to end, with the image block', async () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerEnrichPhoto(server, makeMockClient({ enrich: jest.fn().mockResolvedValue(realResponse()) }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'c', version: '0.0.1' });
    await mcpClient.connect(clientTransport);
    try {
      const { tools } = await mcpClient.listTools();
      const tool = tools.find((t: any) => t.name === 'enrich_photo');
      expect(tool.outputSchema.properties).toEqual(
        expect.objectContaining({ mode: expect.anything(), sha256: expect.anything(), usage: expect.anything() }),
      );
      const result = await mcpClient.callTool({ name: 'enrich_photo', arguments: { imageUrl: 'https://example.com/p.jpg' } });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as any).usage.usd.charged).toBe('0.05');
      expect((result.content as any[]).some((c) => c.type === 'image' && c.mimeType === 'image/jpeg')).toBe(true);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});
