import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { z } from 'zod';

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

    it('short-circuits on any non-none sha256 result (defensive: the API now answers exact or none)', async () => {
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

  describe('cascade: sha256 miss reaches the POST tiers (pixels, pdq)', () => {
    // The API's sha256-only GET is exact or none, so a miss there must still
    // send the bytes: only the POST can match by decoded pixels or PDQ.
    it.each(['pixels', 'pdq'] as const)('returns a %s match from the POST', async (matchType) => {
      const lookup = jest
        .fn()
        .mockResolvedValueOnce({ results: { [SHA256_OF_JPEG_BYTES]: { matchType: 'none' } } })
        .mockResolvedValueOnce({
          results: {
            [SHA256_OF_JPEG_BYTES]: {
              matchType,
              ...(matchType === 'pdq' ? { pdqDistance: 12 } : {}),
              photo: { sha256: 'a'.repeat(64) },
            },
          },
        });
      const handler = captureHandler(makeMockClient(lookup));
      const result = await handler({ imagePath: jpegPath });
      expect(lookup).toHaveBeenCalledTimes(2);
      expect(lookup.mock.calls[0][0]).toEqual({ sha256: SHA256_OF_JPEG_BYTES });
      expect(lookup.mock.calls[1][0]).toEqual({ imagesBase64: [JPEG_BYTES.toString('base64')] });
      const hit = JSON.parse(result.content[0].text);
      expect(hit.matchType).toBe(matchType);
      expect(hit.photo.sha256).toBe('a'.repeat(64));
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

describe('lookup_photo embedded registry id (before the cascade)', () => {
  const FIXTURE_PATH = path.join(__dirname, 'fixtures/registry-id.jpg');
  const FIXTURE_BYTES = fs.readFileSync(FIXTURE_PATH);
  const EMBEDDED_ID = fs.readFileSync(path.join(__dirname, 'fixtures/registry-id.txt'), 'utf8').trim();
  const FILE_SHA = crypto.createHash('sha256').update(FIXTURE_BYTES).digest('hex');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const localImage = require('../src/lib/local-image');

  afterEach(() => jest.restoreAllMocks());

  it('looks up the embedded id first and skips hashing the file when it hits', async () => {
    const hashSpy = jest.spyOn(localImage, 'computeSha256');
    const lookup = jest.fn().mockResolvedValueOnce({
      results: { [EMBEDDED_ID]: { matchType: 'exact', photo: { sha256: EMBEDDED_ID } } },
    });
    const handler = captureHandler(makeMockClient(lookup));

    const result = await handler({ imagePath: FIXTURE_PATH });

    expect(result.isError).toBeFalsy();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith({ sha256: EMBEDDED_ID });
    expect(hashSpy).not.toHaveBeenCalled();
    const hit = JSON.parse(result.content[0].text);
    expect(hit.matchType).toBe('exact');
    // The record found is the original's: the embedded id, also the resource.
    expect(hit.photo.sha256).toBe(EMBEDDED_ID);
    // Says how it matched, so an exact hit on a since-edited file is explainable.
    expect(hit.matchedBy).toBe('registryId');
    // Returns through the flattened envelope, resource and resource link included.
    expect(hit.resource).toBe(`phototology://photo/${EMBEDDED_ID}`);
    expect(result.structuredContent).toEqual(hit);
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'resource_link', name: EMBEDDED_ID }));
  });

  it('never reads the embedded id from a file the allow-list refused', async () => {
    const ENV = 'PHOTOTOLOGY_MCP_ALLOWED_DIRS';
    const saved = process.env[ENV];
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-lookup-allowed-'));
    process.env[ENV] = allowed;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const readerSpy = jest.spyOn(require('../src/lib/registry-id'), 'readEmbeddedRegistryId');
    try {
      const lookup = jest.fn();
      const handler = captureHandler(makeMockClient(lookup));
      const result = await handler({ imagePath: FIXTURE_PATH });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('PATH_OUTSIDE_ALLOWED_DIRS');
      expect(lookup).not.toHaveBeenCalled();
      expect(readerSpy).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env[ENV];
      else process.env[ENV] = saved;
      fs.rmSync(allowed, { recursive: true, force: true });
    }
  });

  it('marks nothing as matchedBy registryId when the cascade, not the embedded id, matched', async () => {
    const lookup = jest
      .fn()
      .mockResolvedValueOnce({ results: { [EMBEDDED_ID]: { matchType: 'none' } } })
      .mockResolvedValueOnce({ results: { [FILE_SHA]: { matchType: 'exact', photo: { sha256: FILE_SHA } } } });
    const handler = captureHandler(makeMockClient(lookup));

    const result = await handler({ imagePath: FIXTURE_PATH });

    expect(JSON.parse(result.content[0].text)).not.toHaveProperty('matchedBy');
  });

  it('does the same for imageBase64', async () => {
    const lookup = jest.fn().mockResolvedValueOnce({
      results: { [EMBEDDED_ID]: { matchType: 'exact', photo: { sha256: EMBEDDED_ID } } },
    });
    const handler = captureHandler(makeMockClient(lookup));

    await handler({ imageBase64: FIXTURE_BYTES.toString('base64') });

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith({ sha256: EMBEDDED_ID });
  });

  it('falls back to the existing cascade when the embedded id misses', async () => {
    const lookup = jest
      .fn()
      .mockResolvedValueOnce({ results: { [EMBEDDED_ID]: { matchType: 'none' } } })
      .mockResolvedValueOnce({ results: { [FILE_SHA]: { matchType: 'none' } } })
      .mockResolvedValueOnce({ results: { [FILE_SHA]: { matchType: 'fuzzy', hammingDistance: 3 } } });
    const handler = captureHandler(makeMockClient(lookup));

    const result = await handler({ imagePath: FIXTURE_PATH });

    expect(lookup).toHaveBeenCalledTimes(3);
    expect(lookup.mock.calls[0][0]).toEqual({ sha256: EMBEDDED_ID });
    expect(lookup.mock.calls[1][0]).toEqual({ sha256: FILE_SHA });
    expect(lookup.mock.calls[2][0]).toEqual({ imagesBase64: [FIXTURE_BYTES.toString('base64')] });
    expect(JSON.parse(result.content[0].text).matchType).toBe('fuzzy');
  });

  it('treats a fuzzy match on the embedded id as a miss and hashes the real bytes', async () => {
    // Defensive: the API's sha256-only GET now answers exact or none, but the
    // id is untrusted input, so only an exact match on it counts.
    const lookup = jest
      .fn()
      .mockResolvedValueOnce({ results: { [EMBEDDED_ID]: { matchType: 'fuzzy', hammingDistance: 2 } } })
      .mockResolvedValueOnce({ results: { [FILE_SHA]: { matchType: 'exact', photo: { sha256: FILE_SHA } } } });
    const handler = captureHandler(makeMockClient(lookup));

    const result = await handler({ imagePath: FIXTURE_PATH });

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(lookup.mock.calls[0][0]).toEqual({ sha256: EMBEDDED_ID });
    expect(lookup.mock.calls[1][0]).toEqual({ sha256: FILE_SHA });
    expect(JSON.parse(result.content[0].text).matchType).toBe('exact');
  });

  it('runs the cascade unchanged when the file carries no id', async () => {
    const lookup = jest.fn().mockResolvedValueOnce({
      results: { [SHA256_OF_JPEG_BYTES]: { matchType: 'exact' } },
    });
    const handler = captureHandler(makeMockClient(lookup));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-lookup-noid-'));
    try {
      const p = path.join(tmp, 'plain.jpg');
      fs.writeFileSync(p, JPEG_BYTES);
      await handler({ imagePath: p });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith({ sha256: SHA256_OF_JPEG_BYTES });
  });
});

describe('lookup_photo pHash input format', () => {
  function inputSchema(): z.ZodObject<z.ZodRawShape> {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const spy = jest.spyOn(server, 'registerTool');
    registerLookupPhoto(server, makeMockClient(jest.fn()));
    const call = spy.mock.calls.find((c) => c[0] === 'lookup_photo')!;
    return z.object((call[1] as { inputSchema: z.ZodRawShape }).inputSchema);
  }

  it('accepts the 64-character bit string that analyze and lookup return', () => {
    expect(inputSchema().safeParse({ pHash: '01'.repeat(32) }).success).toBe(true);
  });

  it('accepts 16 hex characters in any case', () => {
    expect(inputSchema().safeParse({ pHash: '8F14e45fceea167a' }).success).toBe(true);
  });

  it.each([['15 characters', 'a'.repeat(15)], ['63 characters', '0'.repeat(63)], ['non-hex', 'g'.repeat(16)]])(
    'rejects %s',
    (_label, pHash) => {
      expect(inputSchema().safeParse({ pHash }).success).toBe(false);
    },
  );

  it('passes the pHash through to the API unchanged', async () => {
    const lookup = jest.fn().mockResolvedValueOnce({ results: {} });
    const handler = captureHandler(makeMockClient(lookup));
    await handler({ pHash: '01'.repeat(32) });
    expect(lookup).toHaveBeenCalledWith({ pHash: '01'.repeat(32) });
  });
});

describe('lookup_photo reports resolvedPath only for a path reached through a symlink', () => {
  let base: string;

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-lookup-photo-link-')));
    fs.mkdirSync(path.join(base, 'real'));
    fs.writeFileSync(path.join(base, 'real', 'p.jpg'), JPEG_BYTES);
    fs.symlinkSync(path.join(base, 'real'), path.join(base, 'linked'));
  });

  afterAll(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  function exactHit(): jest.Mock {
    return jest.fn().mockResolvedValue({
      results: { [SHA256_OF_JPEG_BYTES]: { matchType: 'exact', photo: { sha256: SHA256_OF_JPEG_BYTES } } },
    });
  }

  it('adds resolvedPath when a parent folder is a symlink', async () => {
    const handler = captureHandler(makeMockClient(exactHit()));
    const result = await handler({ imagePath: path.join(base, 'linked', 'p.jpg') });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.resolvedPath).toBe(path.join(base, 'real', 'p.jpg'));
    expect(payload.matchType).toBe('exact');
  });

  it('adds resolvedPath on the pHash fall-through too', async () => {
    const lookup = jest.fn()
      .mockResolvedValueOnce({ results: {} })
      .mockResolvedValueOnce({ results: { x: { matchType: 'none' } } });
    const handler = captureHandler(makeMockClient(lookup));
    const result = await handler({ imagePath: path.join(base, 'linked', 'p.jpg') });
    expect(JSON.parse(result.content[0].text).resolvedPath).toBe(path.join(base, 'real', 'p.jpg'));
  });

  it('omits resolvedPath for a plain path', async () => {
    const handler = captureHandler(makeMockClient(exactHit()));
    const result = await handler({ imagePath: path.join(base, 'real', 'p.jpg') });
    expect(JSON.parse(result.content[0].text).resolvedPath).toBeUndefined();
  });
});

describe('lookup_photo typed result', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LookupPhotoOutputSchema } = require('../src/schemas');

  const SHA = 'a'.repeat(64);
  const RECORD = {
    sha256: SHA,
    pHash: 'f0f0f0f0f0f0f0f0',
    dHash: '0f0f0f0f0f0f0f0f',
    firstAnalyzedAt: '2026-10-01T00:00:00.000Z',
    lastAnalyzedAt: '2026-10-02T00:00:00.000Z',
    totalCreditsSpent: 2,
    analyzeCallCount: 1,
    lenses: {
      dating: {
        eventId: 'evt_1', output: { estimatedDate: { year: 1990 } }, version: '1.0.0',
        producedAt: '2026-10-01T00:00:00.000Z', coRunHash: 'h', provider: 'gemini',
      },
    },
  };
  const META = { imagesSubmitted: 1, imagesMatched: 1, processingTimeMs: 3, requestId: 'req_l' };
  const HIT = { object: 'lookup', results: { [SHA]: { matchType: 'exact', photo: RECORD } }, meta: META };
  const MISS = { object: 'lookup', results: { [SHA]: { matchType: 'none' } }, meta: { ...META, imagesMatched: 0 } };

  function captureRegistration(client: any): { config: any; handler: (args: any) => Promise<any> } {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const spy = jest.spyOn(server, 'registerTool');
    registerLookupPhoto(server, client);
    const call = spy.mock.calls.find((c) => c[0] === 'lookup_photo')!;
    return { config: call[1], handler: call[2] as (args: any) => Promise<any> };
  }

  it('registers the lookup_photo output schema', () => {
    expect(captureRegistration(makeMockClient(jest.fn())).config.outputSchema).toBe(LookupPhotoOutputSchema);
  });

  it('a hit returns the single flattened result with a resource and a resource link', async () => {
    const { handler } = captureRegistration(makeMockClient(jest.fn().mockResolvedValue(HIT)));
    const result = await handler({ sha256: SHA });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent;
    expect(LookupPhotoOutputSchema.safeParse(sc).success).toBe(true);
    expect(sc.results).toBeUndefined();
    expect(sc.matchType).toBe('exact');
    expect(sc.photo).toEqual(RECORD);
    expect(sc.receipts).toEqual([]);
    expect('credentials' in sc).toBe(false);
    expect(sc.resource).toBe(`phototology://photo/${SHA}`);
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify(sc, null, 2) });
    expect(result.content).toContainEqual({
      type: 'resource_link', uri: `phototology://photo/${SHA}`, name: SHA, mimeType: 'application/json',
    });
  });

  it('a miss has no resource and no resource link', async () => {
    const { handler } = captureRegistration(makeMockClient(jest.fn().mockResolvedValue(MISS)));
    const result = await handler({ sha256: SHA });
    const sc = result.structuredContent;
    expect(LookupPhotoOutputSchema.safeParse(sc).success).toBe(true);
    expect(sc.matchType).toBe('none');
    expect(sc.receipts).toEqual([]);
    expect('resource' in sc).toBe(false);
    expect(result.content.some((c: any) => c.type === 'resource_link')).toBe(false);
  });

  it('an empty results map reads as a miss', async () => {
    const { handler } = captureRegistration(makeMockClient(jest.fn().mockResolvedValue({ object: 'lookup', results: {}, meta: META })));
    const sc = (await handler({ imageUrl: 'https://example.com/a.jpg' })).structuredContent;
    expect(LookupPhotoOutputSchema.safeParse(sc).success).toBe(true);
    expect(sc.matchType).toBe('none');
  });

  it('a fuzzy cascade hit links the matched record and keeps distance and computed hashes', async () => {
    const other = 'b'.repeat(64);
    const lookup = jest.fn()
      .mockResolvedValueOnce({ object: 'lookup', results: { [SHA256_OF_JPEG_BYTES]: { matchType: 'none' } }, meta: META })
      .mockResolvedValueOnce({
        object: 'lookup',
        results: {
          [SHA256_OF_JPEG_BYTES]: {
            matchType: 'fuzzy', hammingDistance: 3, photo: { ...RECORD, sha256: other },
            computedHashes: { sha256: SHA256_OF_JPEG_BYTES, pHash: '1111111111111111', dHash: '2222222222222222' },
          },
        },
        meta: META,
      });
    const { handler } = captureRegistration(makeMockClient(lookup));
    const result = await handler({ imageBase64: JPEG_BYTES.toString('base64') });
    const sc = result.structuredContent;
    expect(LookupPhotoOutputSchema.safeParse(sc).success).toBe(true);
    expect(sc.matchType).toBe('fuzzy');
    expect(sc.hammingDistance).toBe(3);
    expect(sc.computedHashes.sha256).toBe(SHA256_OF_JPEG_BYTES);
    expect(sc.resource).toBe(`phototology://photo/${other}`);
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'resource_link', name: other }));
  });

  it('a cascade hit with no record still links the photo by the hash of its bytes', async () => {
    const lookup = jest.fn().mockResolvedValueOnce({ results: { [SHA256_OF_JPEG_BYTES]: { matchType: 'exact' } } });
    const { handler } = captureRegistration(makeMockClient(lookup));
    const sc = (await handler({ imageBase64: JPEG_BYTES.toString('base64') })).structuredContent;
    expect(sc.resource).toBe(`phototology://photo/${SHA256_OF_JPEG_BYTES}`);
  });

  it('a direct sha256 hit with no record links the photo by the sha256 the caller passed', async () => {
    const lookup = jest.fn().mockResolvedValue({ object: 'lookup', results: { [SHA]: { matchType: 'exact' } }, meta: META });
    const sc = (await captureRegistration(makeMockClient(lookup)).handler({ sha256: SHA })).structuredContent;
    expect(sc.resource).toBe(`phototology://photo/${SHA}`);
  });

  it('passes receipts and credentials through when the API sends them', async () => {
    const withProof = { ...HIT, results: { [SHA]: { matchType: 'exact', photo: RECORD, receipts: [{ id: 'r1' }], credentials: { present: false } } } };
    const { handler } = captureRegistration(makeMockClient(jest.fn().mockResolvedValue(withProof)));
    const sc = (await handler({ sha256: SHA })).structuredContent;
    expect(sc.receipts).toEqual([{ id: 'r1' }]);
    expect(sc.credentials).toEqual({ present: false });
  });

  it('passes the MCP SDK output validation end to end', async () => {
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = require('@modelcontextprotocol/sdk/inMemory.js');
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    registerLookupPhoto(server, makeMockClient(jest.fn().mockResolvedValue(HIT)));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const mcpClient = new Client({ name: 'c', version: '0.0.1' });
    await mcpClient.connect(clientTransport);
    try {
      const { tools } = await mcpClient.listTools();
      const tool = tools.find((t: any) => t.name === 'lookup_photo');
      expect(tool.outputSchema.properties).toEqual(expect.objectContaining({ matchType: expect.anything(), receipts: expect.anything() }));
      const result = await mcpClient.callTool({ name: 'lookup_photo', arguments: { sha256: SHA } });
      expect(result.isError).toBeFalsy();
      expect((result.structuredContent as any).resource).toBe(`phototology://photo/${SHA}`);
    } finally {
      await mcpClient.close();
      await server.close();
    }
  });
});
