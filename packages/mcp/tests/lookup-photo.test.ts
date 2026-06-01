import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerLookupPhoto } = require('../src/tools/lookup-photo');

// 20-byte minimal valid JPEG: magic bytes (FF D8 FF E0) + JFIF marker.
// Needs >=8 bytes so detectFormat() in lib/local-image accepts it; the extra
// bytes guarantee robust format detection across all current sniffers.
const JPEG_BYTES = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
  0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
]);
const SHA256_OF_JPEG_BYTES = crypto.createHash('sha256').update(JPEG_BYTES).digest('hex');

function makeMockClient(lookupImpl: jest.Mock): any {
  return { lookup: lookupImpl };
}

function captureHandler(client: any): (args: any) => Promise<any> {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  const spy = jest.spyOn(server, 'registerTool');
  registerLookupPhoto(server, client);
  const call = spy.mock.calls.find((c) => c[0] === 'lookup_photo');
  if (!call) throw new Error('lookup_photo not registered');
  return call[2] as (args: any) => Promise<any>;
}

describe('lookup_photo with local input (cascade)', () => {
  let tmpDir: string;
  let jpegPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-lookup-photo-'));
    jpegPath = path.join(tmpDir, 'tiny.jpg');
    fs.writeFileSync(jpegPath, JPEG_BYTES);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('cascade: sha256 hit short-circuits', () => {
    it('only fires ONE lookup call when sha256 returns exact', async () => {
      const lookup = jest.fn().mockResolvedValueOnce({
        results: {
          [SHA256_OF_JPEG_BYTES]: {
            matchType: 'exact',
            photo: { sha256: SHA256_OF_JPEG_BYTES },
          },
        },
      });
      const client = makeMockClient(lookup);
      const handler = captureHandler(client);
      const result = await handler({ imagePath: jpegPath });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledWith({ sha256: SHA256_OF_JPEG_BYTES });
      expect(result.isError).toBeFalsy();
    });

    it('short-circuits when sha256 GET returns fuzzy (dummy-pHash collision via API)', async () => {
      const lookup = jest.fn().mockResolvedValueOnce({
        results: { [SHA256_OF_JPEG_BYTES]: { matchType: 'fuzzy', hammingDistance: 2, photo: { sha256: SHA256_OF_JPEG_BYTES } } },
      });
      const client = makeMockClient(lookup);
      const handler = captureHandler(client);
      const result = await handler({ imagePath: jpegPath });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(result.isError).toBeFalsy();
    });
  });

  describe('cascade: sha256 miss falls through to pHash', () => {
    it('fires sha256 lookup then imagesBase64 lookup', async () => {
      const lookup = jest
        .fn()
        .mockResolvedValueOnce({
          results: { [SHA256_OF_JPEG_BYTES]: { matchType: 'none' } },
        })
        .mockResolvedValueOnce({
          results: {
            someOtherSha: {
              matchType: 'fuzzy',
              hammingDistance: 3,
              photo: { sha256: 'someOtherSha' },
            },
          },
        });
      const client = makeMockClient(lookup);
      const handler = captureHandler(client);
      const result = await handler({ imagePath: jpegPath });
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(lookup.mock.calls[0][0]).toEqual({ sha256: SHA256_OF_JPEG_BYTES });
      expect(lookup.mock.calls[1][0]).toEqual({
        imagesBase64: [JPEG_BYTES.toString('base64')],
      });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('cascade: both miss', () => {
    it('returns the second-call result when both miss', async () => {
      const lookup = jest
        .fn()
        .mockResolvedValueOnce({
          results: { [SHA256_OF_JPEG_BYTES]: { matchType: 'none' } },
        })
        .mockResolvedValueOnce({ results: {} });
      const client = makeMockClient(lookup);
      const handler = captureHandler(client);
      const result = await handler({ imagePath: jpegPath });
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeFalsy();
    });
  });

  describe('imageBase64 input runs same cascade', () => {
    it('decodes, hashes, and short-circuits on sha256 exact match', async () => {
      const lookup = jest.fn().mockResolvedValueOnce({
        results: { [SHA256_OF_JPEG_BYTES]: { matchType: 'exact' } },
      });
      const client = makeMockClient(lookup);
      const handler = captureHandler(client);
      const b64 = JPEG_BYTES.toString('base64');
      const result = await handler({ imageBase64: b64 });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledWith({ sha256: SHA256_OF_JPEG_BYTES });
      expect(result.isError).toBeFalsy();
    });
  });
});

describe('lookup_photo backwards-compat (sha256 / pHash / imageUrl)', () => {
  it('forwards sha256 directly without cascade', async () => {
    const lookup = jest.fn().mockResolvedValueOnce({ results: {} });
    const client = makeMockClient(lookup);
    const handler = captureHandler(client);
    const directSha = 'deadbeef'.repeat(8); // 64 hex chars
    await handler({ sha256: directSha });
    expect(lookup).toHaveBeenCalledTimes(1);
    // Backwards-compat path forwards sha256 verbatim. Threshold is undefined
    // unless explicitly passed (handler builds the args object conditionally).
    const callArg = lookup.mock.calls[0][0];
    expect(callArg.sha256).toBe(directSha);
    expect(callArg.pHash).toBeUndefined();
  });

  it('forwards pHash directly without cascade', async () => {
    const lookup = jest.fn().mockResolvedValueOnce({ results: {} });
    const client = makeMockClient(lookup);
    const handler = captureHandler(client);
    await handler({ pHash: '0123456789abcdef' });
    expect(lookup).toHaveBeenCalledTimes(1);
    const callArg = lookup.mock.calls[0][0];
    expect(callArg.pHash).toBe('0123456789abcdef');
    expect(callArg.sha256).toBeUndefined();
  });

  it('forwards imageUrl directly without cascade', async () => {
    const lookup = jest.fn().mockResolvedValueOnce({ results: {} });
    const client = makeMockClient(lookup);
    const handler = captureHandler(client);
    await handler({ imageUrl: 'https://example.com/photo.jpg' });
    expect(lookup).toHaveBeenCalledTimes(1);
    const callArg = lookup.mock.calls[0][0];
    expect(callArg.images).toEqual(['https://example.com/photo.jpg']);
  });
});

describe('lookup_photo input validation', () => {
  it('rejects when no input is provided', async () => {
    const lookup = jest.fn();
    const client = makeMockClient(lookup);
    const handler = captureHandler(client);
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects when multiple inputs are provided', async () => {
    const lookup = jest.fn();
    const client = makeMockClient(lookup);
    const handler = captureHandler(client);
    const result = await handler({
      sha256: 'deadbeef'.repeat(8),
      imageUrl: 'https://example.com/a.jpg',
    });
    expect(result.isError).toBe(true);
    expect(lookup).not.toHaveBeenCalled();
  });
});
