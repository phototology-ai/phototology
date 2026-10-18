import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockAnalyze = jest.fn();
const mockLookup = jest.fn();
const mockModules = jest.fn();

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn().mockImplementation(() => ({
      analyze: mockAnalyze,
      modules: mockModules,
      lookup: mockLookup,
      usage: jest.fn(),
    })),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerTools } = require('../src/tools');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AnalyzeBatchOutputSchema } = require('../src/schemas');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createHash } = require('node:crypto');

type ToolCallback = (args: any) => Promise<{
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

function captureToolCallback(server: McpServer, toolName: string): ToolCallback {
  const spy = jest.spyOn(server, 'registerTool');
  registerTools(server, 'pt_test_abc123');
  const call = spy.mock.calls.find((c) => c[0] === toolName);
  if (!call) throw new Error(`Tool ${toolName} was not registered`);
  return call[2] as unknown as ToolCallback;
}

function emptyLookupResp() {
  return {
    object: 'lookup' as const,
    results: {},
    meta: { imagesSubmitted: 0, imagesMatched: 0, processingTimeMs: 1, requestId: 'req_l' },
  };
}

/** Deterministic per-photo sha256 so each analyzed photo gets its own resource. */
function shaOf(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function freshAnalyzeResp(creditsCharged: number, sha256 = shaOf('default')) {
  return {
    id: 'ana_batch_test',
    object: 'analysis',
    livemode: true,
    fingerprint: { sha256, pHash: 'f0f0f0f0f0f0f0f0', dHash: '0f0f0f0f0f0f0f0f' },
    outputSchema: 'photo',
    output: { estimatedDate: { year: 1990 } },
    usage: { totalTokens: 100, estimatedCostUsd: 0.001, modulesUsed: ['dating'], creditsCharged },
    meta: {
      requestId: 'req_test',
      processingTimeMs: 500,
      provider: 'test',
      promptHash: 'abc',
      ai_generated: true,
      model: 'gemini-2.0-flash',
      vendor: 'google',
    },
    warnings: [],
  };
}

/** Analyze mock that names each photo by its URL (or bytes) and charges `credits`. */
function analyzeBySource(credits: number) {
  return async (args: any) => freshAnalyzeResp(credits, shaOf(args.imageUrl ?? args.imageBase64));
}

/** A registry hit for one photo with the given lenses cached. */
function lookupHit(sha256: string, cached: Record<string, Record<string, unknown>>, matchType = 'exact') {
  return {
    object: 'lookup' as const,
    results: {
      [sha256]: {
        matchType,
        photo: {
          sha256, pHash: 'aaaaaaaaaaaaaaaa', dHash: 'bbbbbbbbbbbbbbbb',
          firstAnalyzedAt: '2026-10-01T00:00:00.000Z', lastAnalyzedAt: '2026-10-02T00:00:00.000Z',
          totalCreditsSpent: 2, analyzeCallCount: 1,
          lenses: Object.fromEntries(Object.entries(cached).map(([lens, output]) => [lens, {
            eventId: `evt_${lens}`, output, version: '1.0.0', producedAt: '2026-10-01T00:00:00.000Z', coRunHash: 'h', provider: 'gemini',
          }])),
        },
      },
    },
    meta: { imagesSubmitted: 1, imagesMatched: 1, processingTimeMs: 1, requestId: 'req_l' },
  };
}

beforeEach(() => {
  mockAnalyze.mockReset();
  mockLookup.mockReset();
  mockModules.mockReset();
});

describe('analyze_batch tool', () => {
  it('registers with the expected annotations', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const spy = jest.spyOn(server, 'registerTool');
    registerTools(server, 'pt_test_abc123');

    const call = spy.mock.calls.find((c) => c[0] === 'analyze_batch');
    expect(call).toBeDefined();
    const config = call![1] as { annotations: Record<string, unknown> };
    expect(config.annotations.readOnlyHint).toBe(true);
    expect(config.annotations.destructiveHint).toBe(false);
    expect(config.annotations.idempotentHint).toBe(true);
  });

  it('returns isError when neither lenses nor stack is provided', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const result = await cb({
      imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/lenses.*stack/i);
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockAnalyze).not.toHaveBeenCalled();
  });

  it('with refresh=true, skips lookup and calls analyze once per photo', async () => {
    mockAnalyze.mockResolvedValue(freshAnalyzeResp(1));

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const urls = Array.from({ length: 3 }, (_, i) => `https://example.com/${i}.jpg`);
    const result = await cb({
      imageUrls: urls,
      lenses: ['dating'],
      refresh: true,
    });

    expect(result.isError).toBeFalsy();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockAnalyze).toHaveBeenCalledTimes(3); // one per photo

    // Each call uses imageUrl (singular), not the multi-image `images` array.
    for (const call of mockAnalyze.mock.calls) {
      const args = call[0];
      expect(typeof args.imageUrl).toBe('string');
      expect(args.images).toBeUndefined();
      expect(args.modules).toEqual(['dating']);
      expect(args.refresh).toBe(true);
    }
    const calledUrls = mockAnalyze.mock.calls.map((c) => c[0].imageUrl).sort();
    expect(calledUrls).toEqual(urls.slice().sort());

    const payload = JSON.parse(result.content[0].text);
    expect(payload.summary.photos).toBe(3);
    expect(payload.summary.analyzed).toBe(3);
    expect(payload.summary.cacheHits).toBe(0);
    expect(payload.results).toHaveLength(3);
    expect(payload.results.every((r: any) => r.cacheHit === false)).toBe(true);
  });

  it('with refresh=false, runs bulk lookup before analyze', async () => {
    mockLookup.mockResolvedValue(emptyLookupResp());
    mockAnalyze.mockResolvedValue(freshAnalyzeResp(1));

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const result = await cb({
      imageUrls: ['https://example.com/x.jpg', 'https://example.com/y.jpg'],
      lenses: ['dating'],
    });

    expect(result.isError).toBeFalsy();
    expect(mockLookup).toHaveBeenCalled();
    expect(mockAnalyze).toHaveBeenCalled();
  });

  it('runs per-URL lookup + per-photo analyze for large jobs (no ordering assumption)', async () => {
    mockLookup.mockResolvedValue(emptyLookupResp());
    mockAnalyze.mockResolvedValue(freshAnalyzeResp(1));

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const urls = Array.from({ length: 120 }, (_, i) => `https://example.com/${i}.jpg`);
    const result = await cb({
      imageUrls: urls,
      lenses: ['dating'],
    });

    expect(result.isError).toBeFalsy();

    // Per-URL lookup: one call per image, NOT batched. This avoids
    // depending on the API to preserve input order in batched results.
    // Lookups are free; concurrency is bounded inside the tool.
    expect(mockLookup).toHaveBeenCalledTimes(120);
    for (const call of mockLookup.mock.calls) {
      // Each lookup is a single-image request.
      expect(call[0].images).toHaveLength(1);
    }

    // Analyze runs once per photo (empty lookup => all 120 are misses).
    expect(mockAnalyze).toHaveBeenCalledTimes(120);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.summary.photos).toBe(120);
    expect(payload.summary.analyzed).toBe(120);
  });

  it('reports the failing photo as an inline error and continues with the rest', async () => {
    // First call rejects, second resolves — verifies per-photo isolation.
    mockAnalyze
      .mockRejectedValueOnce(new Error('one boom'))
      .mockResolvedValueOnce(freshAnalyzeResp(1));

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const result = await cb({
      imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      lenses: ['dating'],
      refresh: true,
    });

    expect(result.isError).toBeFalsy(); // partial failures don't fail the whole batch
    const payload = JSON.parse(result.content[0].text);
    expect(payload.summary.photos).toBe(2);
    expect(payload.summary.errors).toBe(1);
    expect(payload.summary.analyzed).toBe(1);
    const errored = payload.results.find((r: any) => r.error);
    expect(errored).toBeDefined();
    expect(errored.error.message).toMatch(/boom/);
    expect(typeof errored.error.code).toBe('string');
    const succeeded = payload.results.find((r: any) => r.photo);
    expect(succeeded).toBeDefined();
    expect(AnalyzeBatchOutputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  it('emits structuredContent mirroring the text payload', async () => {
    mockAnalyze.mockResolvedValue(freshAnalyzeResp(1));

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const result = await cb({
      imageUrls: ['https://example.com/a.jpg'],
      lenses: ['dating'],
      refresh: true,
    });

    expect(result.structuredContent).toBeDefined();
    const text = JSON.parse(result.content[0].text);
    expect(result.structuredContent).toEqual(text);
  });
});

describe('analyze_batch local input modes', () => {
  // 20-byte minimal valid JPEG: magic bytes (FF D8 FF E0) + JFIF marker.
  // Needs >=8 bytes so detectFormat() in lib/local-image accepts it.
  const JPEG_BYTES = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00,
  ]);
  const JPEG_BASE64 = JPEG_BYTES.toString('base64');

  let tmpDir: string;
  let jpegA: string;
  let jpegB: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-analyze-batch-'));
    jpegA = path.join(tmpDir, 'a.jpg');
    jpegB = path.join(tmpDir, 'b.jpg');
    fs.writeFileSync(jpegA, JPEG_BYTES);
    fs.writeFileSync(jpegB, JPEG_BYTES);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('imagePaths: reads each literal path, forwards as imageBase64', async () => {
    mockAnalyze.mockResolvedValue(freshAnalyzeResp(1));

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const result = await cb({
      imagePaths: [jpegA, jpegB],
      lenses: ['dating'],
      refresh: true,
    });

    expect(result.isError).toBeFalsy();
    // No lookup for base64 inputs in v1.2.0 — they skip the registry pass.
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockAnalyze).toHaveBeenCalledTimes(2);
    for (const call of mockAnalyze.mock.calls) {
      expect(call[0].imageBase64).toBe(JPEG_BASE64);
      expect(call[0].imageUrl).toBeUndefined();
      expect(call[0].modules).toEqual(['dating']);
    }

    const payload = JSON.parse(result.content[0].text);
    expect(payload.summary.photos).toBe(2);
    expect(payload.summary.analyzed).toBe(2);
    // Each result echoes its source path.
    const paths = payload.results.map((r: any) => r.input).sort();
    expect(paths).toEqual([jpegA, jpegB].sort());
  });

  it('imagePaths: glob pattern expands and forwards each match', async () => {
    mockAnalyze.mockResolvedValue(freshAnalyzeResp(1));

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const result = await cb({
      imagePaths: [path.join(tmpDir, '*.jpg')],
      lenses: ['dating'],
      refresh: true,
    });

    expect(result.isError).toBeFalsy();
    expect(mockAnalyze).toHaveBeenCalledTimes(2); // two fixture files
    for (const call of mockAnalyze.mock.calls) {
      expect(call[0].imageBase64).toBe(JPEG_BASE64);
    }
  });

  it('imagesBase64: forwards each entry as imageBase64', async () => {
    mockAnalyze.mockResolvedValue(freshAnalyzeResp(1));

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const result = await cb({
      imagesBase64: [JPEG_BASE64, JPEG_BASE64, JPEG_BASE64],
      lenses: ['dating'],
      refresh: true,
    });

    expect(result.isError).toBeFalsy();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockAnalyze).toHaveBeenCalledTimes(3);
    for (const call of mockAnalyze.mock.calls) {
      expect(call[0].imageBase64).toBe(JPEG_BASE64);
      expect(call[0].imageUrl).toBeUndefined();
    }
  });

  it('combines imageUrls + imagePaths + imagesBase64 in one call', async () => {
    mockLookup.mockResolvedValue(emptyLookupResp());
    mockAnalyze.mockResolvedValue(freshAnalyzeResp(1));

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const result = await cb({
      imageUrls: ['https://example.com/a.jpg'],
      imagePaths: [jpegA],
      imagesBase64: [JPEG_BASE64],
      lenses: ['dating'],
    });

    expect(result.isError).toBeFalsy();

    // Only the URL participates in lookup (base64 inputs skip it in v1.2.0).
    expect(mockLookup).toHaveBeenCalledTimes(1);
    expect(mockLookup.mock.calls[0][0].images).toEqual(['https://example.com/a.jpg']);

    // All three inputs hit analyze (URL had empty lookup, base64 always misses).
    expect(mockAnalyze).toHaveBeenCalledTimes(3);
    const shapes = mockAnalyze.mock.calls.map((c) => ({
      hasUrl: c[0].imageUrl !== undefined,
      hasBase64: c[0].imageBase64 !== undefined,
    }));
    expect(shapes.filter((s) => s.hasUrl && !s.hasBase64)).toHaveLength(1);
    expect(shapes.filter((s) => !s.hasUrl && s.hasBase64)).toHaveLength(2);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.summary.photos).toBe(3);
    expect(payload.summary.analyzed).toBe(3);
  });

  it('GLOB_TOO_LARGE: rejects glob expanding past MAX_BATCH', async () => {
    // expandGlobs throws at >200 files. Create 205 minimal-magic-byte fixtures
    // in a fresh dir so we don't pollute the other tests' counts.
    const bigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-analyze-batch-toobig-'));
    try {
      for (let i = 0; i < 205; i++) {
        fs.writeFileSync(path.join(bigDir, `f${i}.jpg`), JPEG_BYTES);
      }

      const server = new McpServer({ name: 'test', version: '0.0.1' });
      const cb = captureToolCallback(server, 'analyze_batch');

      const result = await cb({
        imagePaths: [path.join(bigDir, '*.jpg')],
        lenses: ['dating'],
        refresh: true,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('GLOB_TOO_LARGE');
      expect(mockAnalyze).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(bigDir, { recursive: true, force: true });
    }
  });

  /** ISO-BMFF header: size, 'ftyp', major brand, minor version, compatible brands. */
  function ftyp(major: string, ...compatible: string[]): Buffer {
    const brands = Buffer.from(major + '\0\0\0\0' + compatible.join(''), 'ascii');
    const size = Buffer.alloc(4); size.writeUInt32BE(8 + brands.length);
    return Buffer.concat([size, Buffer.from('ftyp', 'ascii'), brands, Buffer.alloc(16)]);
  }

  it('a HEIC file is refused by its bytes, whatever its name, with a conversion hint; the rest still analyze', async () => {
    // 2026-10-05: 52 HEIC files went to the API and came back as opaque IMAGE_INVALID 422s.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-heic-'));
    const jpeg = path.join(tmpDir, 'ok.jpg');
    fs.writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]));
    const heic = path.join(tmpDir, 'IMG_5321.HEIC');
    fs.writeFileSync(heic, ftyp('heic', 'mif1', 'heic'));
    const renamedHeic = path.join(tmpDir, 'looks-like.jpg');
    fs.writeFileSync(renamedHeic, ftyp('mif1', 'heic'));
    // mif1 as the major brand with avif among the compatible brands is an AVIF, which the API decodes.
    const avif = path.join(tmpDir, 'photo.avif');
    fs.writeFileSync(avif, ftyp('mif1', 'avif', 'miaf'));
    mockAnalyze.mockResolvedValue(freshAnalyzeResp(1));

    const server = new McpServer({ name: 't', version: '0' });
    const cb = captureToolCallback(server, 'analyze_batch');
    const result = await cb({ imagePaths: [jpeg, heic, renamedHeic, avif], lenses: ['dating'], refresh: true });
    const payload = JSON.parse(result.content[0].text);

    expect(mockAnalyze).toHaveBeenCalledTimes(2);
    for (const p of [heic, renamedHeic]) {
      const outcome = payload.results.find((r: any) => r.input === p);
      expect(outcome.error.code).toBe('HEIC_UNSUPPORTED');
      expect(outcome.error.message).toContain('sips -s format jpeg');
    }
    expect(payload.results.find((r: any) => r.input === avif).cacheHit).toBe(false);
    expect(payload.summary.errors).toBe(2);
    expect(payload.summary.analyzed).toBe(2);
  });

  it('imagesBase64: HEIC bytes are refused the same way', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    const cb = captureToolCallback(server, 'analyze_batch');
    const result = await cb({ imagesBase64: [ftyp('heic').toString('base64')], lenses: ['dating'], refresh: true });
    const payload = JSON.parse(result.content[0].text);
    expect(mockAnalyze).not.toHaveBeenCalled();
    expect(payload.results[0].error.code).toBe('HEIC_UNSUPPORTED');
  });

  it('rejects when none of imageUrls, imagePaths, imagesBase64 is provided', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const result = await cb({
      lenses: ['dating'],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('UNSUPPORTED_FORMAT');
    expect(result.content[0].text.toLowerCase()).toMatch(/imageurls|imagepaths|imagesbase64/);
    expect(mockAnalyze).not.toHaveBeenCalled();
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it('per-file error isolation: a missing path errors out, valid inputs still analyze', async () => {
    // Mixed batch: 1 valid path + 1 missing path (FILE_NOT_FOUND) + 1 valid base64.
    // Expect the 2 valid inputs to analyze, the missing path to surface as
    // source:'error' with FILE_NOT_FOUND, and the batch to NOT fail wholesale.
    mockAnalyze.mockResolvedValue(freshAnalyzeResp(1));

    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');

    const missing = path.join(tmpDir, 'definitely-not-here.jpg');
    const result = await cb({
      imagePaths: [jpegA, missing],
      imagesBase64: [JPEG_BASE64],
      lenses: ['dating'],
      refresh: true,
    });

    expect(result.isError).toBeFalsy();
    // Two valid inputs reached analyze; the missing path was filtered to preErrors.
    expect(mockAnalyze).toHaveBeenCalledTimes(2);

    const payload = JSON.parse(result.content[0].text);
    expect(payload.summary.photos).toBe(3); // count includes the bad file
    expect(payload.summary.analyzed).toBe(2);
    expect(payload.summary.errors).toBe(1);

    const errored = payload.results.find((r: any) => r.error);
    expect(errored).toBeDefined();
    expect(errored.input).toBe(missing);
    expect(errored.error.code).toBe('FILE_NOT_FOUND');

    const analyzed = payload.results.filter((r: any) => r.photo);
    expect(analyzed).toHaveLength(2);
    expect(AnalyzeBatchOutputSchema.safeParse(result.structuredContent).success).toBe(true);
  });

  // Regression (1.2.1, live 2026-06-01): a server-side full cache hit must count
  // as a cache hit AND a saving. Local files skip the client lookup, so the
  // server's answer is the only signal the re-run was free. The API marks it
  // with meta.cacheHit; savings fall back to the billable lens count when an
  // older API omits usage.creditsSaved.
  it('counts a server-side cache hit as a cache hit and a saving', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');
    mockLookup.mockResolvedValue(emptyLookupResp()); // lookup misses -> analyze runs
    const cached = freshAnalyzeResp(0, shaOf('a'));
    mockAnalyze
      .mockResolvedValueOnce({ ...cached, meta: { ...cached.meta, cacheHit: true } }) // server served it free
      .mockResolvedValueOnce(freshAnalyzeResp(1, shaOf('b'))); // genuine fresh charge

    const res = await cb({
      imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      lenses: ['dating'],
    });
    const payload = JSON.parse(res.content[0].text);

    expect(payload.summary.cacheHits).toBe(1);
    expect(payload.summary.analyzed).toBe(1);
    expect(payload.summary.creditsCharged).toBe(1);
    expect(payload.summary.creditsSaved).toBe(1);
    expect(payload.summary.usd).toEqual({ charged: '0.01', saved: '0.01' });
  });
});

describe('analyze_batch — selectable lens enum', () => {
  // Regression (1.2.1): vehicle-condition is in LENS_FIELDS but stack-only; the
  // API rejects it on direct selection, so it must not appear in the `lenses` enum.
  it('rejects vehicle-condition but accepts a real lens', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const spy = jest.spyOn(server, 'registerTool');
    registerTools(server, 'pt_test_abc123');
    const call = spy.mock.calls.find((c) => c[0] === 'analyze_batch');
    if (!call) throw new Error('analyze_batch not registered');
    const lensesSchema = (call[1] as any).inputSchema.lenses;

    expect(lensesSchema.safeParse(['vehicle-condition']).success).toBe(false);
    expect(lensesSchema.safeParse(['dating']).success).toBe(true);
  });
});

describe('analyze_batch typed result', () => {
  function registration(): any {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const spy = jest.spyOn(server, 'registerTool');
    registerTools(server, 'pt_test_abc123');
    const call = spy.mock.calls.find((c) => c[0] === 'analyze_batch');
    if (!call) throw new Error('analyze_batch not registered');
    return call[1];
  }

  it('registers the batch output schema and a dryRun flag', () => {
    const config = registration();
    expect(config.outputSchema).toBe(AnalyzeBatchOutputSchema);
    expect(config.inputSchema.dryRun.safeParse(true).success).toBe(true);
    expect(config.inputSchema.dryRun.safeParse(undefined).success).toBe(true);
    expect(config.description).toContain(
      'Pass `dryRun: true` to see which photos the registry already knows and what the rest would cost, without spending.',
    );
    expect(config.description).not.toMatch(/\u2014/);
  });

  it('returns structuredContent that validates, a matching text block, and one resource link per photo', async () => {
    mockLookup.mockResolvedValue(emptyLookupResp());
    mockAnalyze.mockImplementation(analyzeBySource(2));
    const cb = captureToolCallback(new McpServer({ name: 'test', version: '0.0.1' }), 'analyze_batch');
    const urls = ['https://example.com/a.jpg', 'https://example.com/b.jpg'];

    const result = await cb({ imageUrls: urls, lenses: ['dating', 'people'] });

    const sc: any = result.structuredContent;
    expect(AnalyzeBatchOutputSchema.safeParse(sc).success).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify(sc, null, 2) });
    for (const url of urls) {
      expect(result.content).toContainEqual({
        type: 'resource_link', uri: `phototology://photo/${shaOf(url)}`, name: shaOf(url), mimeType: 'application/json',
      });
    }
    expect(sc.results.map((r: any) => r.input)).toEqual(urls);
    expect(sc.results[0].usage.usd).toEqual({ charged: '0.02', saved: '0.00' });
    expect(sc.summary).toEqual(expect.objectContaining({
      photos: 2, cacheHits: 0, analyzed: 2, errors: 0, creditsCharged: 4, creditsSaved: 0, usd: { charged: '0.04', saved: '0.00' },
    }));
  });

  it('estimates cache misses times billable lenses after the lookup pass and before any analyze call', async () => {
    const urls = ['https://example.com/hit.jpg', 'https://example.com/m1.jpg', 'https://example.com/m2.jpg'];
    const calls: string[] = [];
    mockLookup.mockImplementation(async ({ images }: any) => {
      calls.push('lookup');
      return images[0] === urls[0]
        ? lookupHit(shaOf(urls[0]), { dating: { estimatedDate: { year: 1971 } }, people: { peopleCount: 3 }, moderation: { moderation: { safe: true } } })
        : emptyLookupResp();
    });
    // The server answers both misses for free. The estimate must not move: it was fixed before analyzing.
    mockAnalyze.mockImplementation(async (args: any) => {
      calls.push('analyze');
      return analyzeBySource(0)(args);
    });
    const cb = captureToolCallback(new McpServer({ name: 'test', version: '0.0.1' }), 'analyze_batch');

    const result = await cb({ imageUrls: urls, lenses: ['dating', 'people', 'moderation'] });

    expect(calls.lastIndexOf('lookup')).toBeLessThan(calls.indexOf('analyze'));
    expect(mockAnalyze).toHaveBeenCalledTimes(2);
    const sc: any = result.structuredContent;
    // moderation is free, so 2 misses x 2 billable lenses.
    expect(sc.summary.estimate).toEqual({ photos: 3, cacheHits: 1, creditsNeeded: 4, usd: '0.04' });
    expect(result.content[1]).toEqual({ type: 'text', text: expect.stringMatching(/3 photos.*1 already in the registry.*4 credits.*\$0\.04/) });

    const hit = sc.results[0];
    expect(hit.input).toBe(urls[0]);
    expect(hit.cacheHit).toBe(true);
    expect(hit.photo.sha256).toBe(shaOf(urls[0]));
    expect(hit.output).toEqual({ estimatedDate: { year: 1971 }, peopleCount: 3, moderation: { safe: true } });
    expect(hit.usage).toEqual(expect.objectContaining({ creditsCharged: 0, creditsSaved: 2, usd: { charged: '0.00', saved: '0.02' } }));
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'resource_link', name: shaOf(urls[0]) }));
    expect(AnalyzeBatchOutputSchema.safeParse(sc).success).toBe(true);
  });

  it('sandbox results ignore the placeholder fingerprint: URLs link to nothing, bytes are named by their own hash', async () => {
    const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString('base64');
    mockLookup.mockResolvedValue(emptyLookupResp());
    mockAnalyze.mockResolvedValue({ ...freshAnalyzeResp(0, '0'.repeat(64)), livemode: false });
    const cb = captureToolCallback(new McpServer({ name: 'test', version: '0.0.1' }), 'analyze_batch');

    const result = await cb({ imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'], imagesBase64: [b64], lenses: ['dating'] });

    const sc: any = result.structuredContent;
    expect(AnalyzeBatchOutputSchema.safeParse(sc).success).toBe(true);
    for (const row of sc.results.slice(0, 2)) {
      expect(row.photo.sha256).toBe('');
      expect('resource' in row).toBe(false);
    }
    const localSha = shaOf(Buffer.from(b64, 'base64') as any);
    expect(sc.results[2].photo.sha256).toBe(localSha);
    const links = result.content.filter((c: any) => c.type === 'resource_link');
    expect(links).toEqual([expect.objectContaining({ name: localSha })]);
  });

  it('a registry row says how it matched, so a fuzzy substitution is visible', async () => {
    const urls = ['https://example.com/exact.jpg', 'https://example.com/near.jpg'];
    mockLookup.mockImplementation(async ({ images }: any) => images[0] === urls[0]
      ? lookupHit(shaOf(urls[0]), { dating: { estimatedDate: { year: 1971 } } })
      : lookupHit(shaOf('another photo'), { dating: { estimatedDate: { year: 1980 } } }, 'fuzzy'));
    const cb = captureToolCallback(new McpServer({ name: 'test', version: '0.0.1' }), 'analyze_batch');

    const result = await cb({ imageUrls: urls, lenses: ['dating'] });

    const sc: any = result.structuredContent;
    expect(mockAnalyze).not.toHaveBeenCalled();
    expect(sc.results[0].matchType).toBe('exact');
    expect(sc.results[1].matchType).toBe('fuzzy');
    expect(sc.results[1].photo.sha256).toBe(shaOf('another photo'));
    expect(AnalyzeBatchOutputSchema.safeParse(sc).success).toBe(true);
  });

  it('expands a stack through the free lens catalog to price it', async () => {
    mockModules.mockResolvedValue({
      modules: [],
      presets: [{ name: 'quick-scan', description: 'q', modules: ['dating', 'describe', 'moderation'] }],
    });
    mockLookup.mockResolvedValue(emptyLookupResp());
    mockAnalyze.mockImplementation(analyzeBySource(2));
    const cb = captureToolCallback(new McpServer({ name: 'test', version: '0.0.1' }), 'analyze_batch');

    const result = await cb({ imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'], stack: 'quick-scan' });

    expect(mockAnalyze.mock.calls[0][0].preset).toBe('quick-scan');
    expect((result.structuredContent as any).summary.estimate).toEqual({ photos: 2, cacheHits: 0, creditsNeeded: 4, usd: '0.04' });
  });

  it('dryRun: runs the free lookup only, never analyzes, and prices the misses', async () => {
    const urls = ['https://example.com/hit.jpg', 'https://example.com/m1.jpg', 'https://example.com/m2.jpg'];
    mockLookup.mockImplementation(async ({ images }: any) => images[0] === urls[0]
      ? lookupHit(shaOf(urls[0]), { dating: { estimatedDate: { year: 1971 } }, people: { peopleCount: 3 } })
      : emptyLookupResp());
    const cb = captureToolCallback(new McpServer({ name: 'test', version: '0.0.1' }), 'analyze_batch');

    const result = await cb({ imageUrls: urls, lenses: ['dating', 'people'], dryRun: true });

    expect(mockLookup).toHaveBeenCalledTimes(3);
    expect(mockAnalyze).not.toHaveBeenCalled();
    const sc: any = result.structuredContent;
    expect(AnalyzeBatchOutputSchema.safeParse(sc).success).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify(sc, null, 2) });
    expect(sc.summary.dryRun).toBe(true);
    expect(sc.summary.estimate).toEqual({ photos: 3, cacheHits: 1, creditsNeeded: 2 * 2, usd: '0.04' });
    expect(sc.summary.creditsCharged).toBe(0);
    expect(sc.results[0]).toEqual({
      input: urls[0], matchType: 'exact', cachedLenses: ['dating', 'people'], missingLenses: [],
      resource: `phototology://photo/${shaOf(urls[0])}`,
    });
    expect(sc.results[1]).toEqual({ input: urls[1], matchType: 'none', cachedLenses: [], missingLenses: ['dating', 'people'] });
    const links = result.content.filter((c: any) => c.type === 'resource_link');
    expect(links).toEqual([expect.objectContaining({ name: shaOf(urls[0]) })]);
  });

  it('dryRun: looks up local bytes too and counts only the missing lenses of a partial hit', async () => {
    const b64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]).toString('base64');
    mockLookup.mockResolvedValue(lookupHit(shaOf(b64), { dating: { estimatedDate: { year: 1971 } } }));
    const cb = captureToolCallback(new McpServer({ name: 'test', version: '0.0.1' }), 'analyze_batch');

    const result = await cb({ imagesBase64: [b64], lenses: ['dating', 'people'], dryRun: true });

    expect(mockLookup).toHaveBeenCalledWith({ imagesBase64: [b64] });
    expect(mockAnalyze).not.toHaveBeenCalled();
    const sc: any = result.structuredContent;
    expect(sc.results[0]).toEqual(expect.objectContaining({ input: 'base64[0]', cachedLenses: ['dating'], missingLenses: ['people'] }));
    expect(sc.summary.estimate).toEqual({ photos: 1, cacheHits: 0, creditsNeeded: 1, usd: '0.01' });
  });
});

describe('analyze_batch final-review fixes', () => {
  function batchCallback(): ToolCallback {
    return captureToolCallback(new McpServer({ name: 'test', version: '0.0.1' }), 'analyze_batch');
  }

  it('estimate.photos counts every input, the same set summary.photos counts', async () => {
    mockLookup.mockResolvedValue(emptyLookupResp());
    mockAnalyze.mockImplementation(analyzeBySource(1));
    const missing = path.join(os.tmpdir(), `mcp-batch-missing-${Date.now()}.jpg`);

    const result = await batchCallback()({ imageUrls: ['https://example.com/a.jpg'], imagePaths: [missing], lenses: ['dating'] });

    const sc: any = result.structuredContent;
    expect(sc.summary.errors).toBe(1);
    expect(sc.summary.photos).toBe(2);
    expect(sc.summary.estimate.photos).toBe(sc.summary.photos);
    expect(AnalyzeBatchOutputSchema.safeParse(sc).success).toBe(true);
  });

  it('documents that a real run estimate for local and base64 inputs is an upper bound', () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const spy = jest.spyOn(server, 'registerTool');
    registerTools(server, 'pt_test_abc123');
    const config: any = spy.mock.calls.find((c) => c[0] === 'analyze_batch')![1];
    expect(config.description).toMatch(/upper bound/);
    expect(config.description).toContain('ESTIMATE_UNAVAILABLE');
  });

  it('a stack batch whose catalog read fails still runs: estimate null, an ESTIMATE_UNAVAILABLE warning', async () => {
    mockModules.mockRejectedValue(new Error('modules endpoint down'));
    mockLookup.mockResolvedValue(emptyLookupResp());
    mockAnalyze.mockImplementation(analyzeBySource(3));

    const result = await batchCallback()({ imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'], stack: 'quick-scan' });

    expect(result.isError).toBeFalsy();
    const sc: any = result.structuredContent;
    expect(AnalyzeBatchOutputSchema.safeParse(sc).success).toBe(true);
    expect(sc.summary.estimate).toBeNull();
    expect(sc.summary.warnings).toEqual(['ESTIMATE_UNAVAILABLE']);
    expect(mockAnalyze).toHaveBeenCalledTimes(2);
    expect(mockAnalyze.mock.calls[0][0].preset).toBe('quick-scan');
    expect(sc.summary.creditsCharged).toBe(6);
    expect(result.content[1]).toEqual({ type: 'text', text: expect.stringContaining('unavailable') });
  });

  it('a stack dry run whose catalog read fails still reports what the registry knows', async () => {
    const url = 'https://example.com/a.jpg';
    mockModules.mockRejectedValue(new Error('modules endpoint down'));
    mockLookup.mockResolvedValue(lookupHit(shaOf(url), { dating: { estimatedDate: { year: 1971 } } }));

    const result = await batchCallback()({ imageUrls: [url], stack: 'quick-scan', dryRun: true });

    expect(result.isError).toBeFalsy();
    expect(mockAnalyze).not.toHaveBeenCalled();
    const sc: any = result.structuredContent;
    expect(AnalyzeBatchOutputSchema.safeParse(sc).success).toBe(true);
    expect(sc.summary.estimate).toBeNull();
    expect(sc.summary.warnings).toEqual(['ESTIMATE_UNAVAILABLE']);
    expect(sc.results[0]).toEqual({
      input: url, matchType: 'exact', cachedLenses: ['dating'], missingLenses: [],
      resource: `phototology://photo/${shaOf(url)}`,
    });
  });

  it('a stack the catalog does not list is still a tool error', async () => {
    mockModules.mockResolvedValue({ modules: [], presets: [] });
    const result = await batchCallback()({ imageUrls: ['https://example.com/a.jpg'], stack: 'quick-scan' });
    expect(result.isError).toBe(true);
  });

  it('refresh plus dryRun: rows keep their real matchType; the estimate prices every lens on every photo', async () => {
    const urls = ['https://example.com/hit.jpg', 'https://example.com/miss.jpg'];
    mockLookup.mockImplementation(async ({ images }: any) => images[0] === urls[0]
      ? lookupHit(shaOf(urls[0]), { dating: { estimatedDate: { year: 1971 } }, people: { peopleCount: 3 } })
      : emptyLookupResp());

    const result = await batchCallback()({ imageUrls: urls, lenses: ['dating', 'people'], refresh: true, dryRun: true });

    expect(mockAnalyze).not.toHaveBeenCalled();
    const sc: any = result.structuredContent;
    expect(sc.results[0]).toEqual(expect.objectContaining({ matchType: 'exact', cachedLenses: ['dating', 'people'], missingLenses: [] }));
    expect(sc.results[1]).toEqual(expect.objectContaining({ matchType: 'none' }));
    expect(sc.summary.estimate).toEqual({ photos: 2, cacheHits: 0, creditsNeeded: 4, usd: '0.04' });
    expect(sc.summary.cacheHits).toBe(0);
  });
});
