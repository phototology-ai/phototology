/**
 * Tests for the enrich_photo MCP tool (item-048).
 *
 * Mirrors the analyze_photo.test.ts pattern: mocks PhototologyClient and
 * captures the registered tool handler. Validates:
 *   - imageUrl, imageBase64, imagePath input modes
 *   - outputPath flag writes enriched bytes to disk + alters response shape
 *   - PHOTO_NOT_IN_REGISTRY error is rendered structurally
 *   - Multi-input refinement is enforced
 */

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
    expect(payload.creditsCharged).toBe(5);
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
