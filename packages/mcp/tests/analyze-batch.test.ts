import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockAnalyze = jest.fn();
const mockLookup = jest.fn();

jest.mock('@phototology/sdk', () => {
  const actual = jest.requireActual('@phototology/sdk');
  return {
    ...actual,
    PhototologyClient: jest.fn().mockImplementation(() => ({
      analyze: mockAnalyze,
      modules: jest.fn(),
      lookup: mockLookup,
      usage: jest.fn(),
    })),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { registerTools } = require('../src/tools');

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

function freshAnalyzeResp(creditsCharged: number) {
  return {
    id: 'ana_batch_test',
    object: 'analysis',
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

beforeEach(() => {
  mockAnalyze.mockReset();
  mockLookup.mockReset();
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
    expect(payload.totalSubmitted).toBe(3);
    expect(payload.totalAnalyzed).toBe(3);
    expect(payload.totalCacheHits).toBe(0);
    expect(payload.results).toHaveLength(3);
    expect(payload.results.every((r: any) => r.source === 'fresh')).toBe(true);
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
    expect(payload.totalSubmitted).toBe(120);
    expect(payload.totalAnalyzed).toBe(120);
  });

  it('marks the failing photo as source:error and continues with the rest', async () => {
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
    expect(payload.totalSubmitted).toBe(2);
    expect(payload.totalErrors).toBe(1);
    expect(payload.totalAnalyzed).toBe(1);
    const errored = payload.results.find((r: any) => r.source === 'error');
    expect(errored).toBeDefined();
    expect(errored.error).toMatch(/boom/);
    const succeeded = payload.results.find((r: any) => r.source === 'fresh');
    expect(succeeded).toBeDefined();
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
    expect(payload.totalSubmitted).toBe(2);
    expect(payload.totalAnalyzed).toBe(2);
    // Each result echoes its source path.
    const paths = payload.results.map((r: any) => r.imagePath).sort();
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
    expect(payload.totalSubmitted).toBe(3);
    expect(payload.totalAnalyzed).toBe(3);
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
    expect(payload.totalSubmitted).toBe(3); // count includes the bad file
    expect(payload.totalAnalyzed).toBe(2);
    expect(payload.totalErrors).toBe(1);

    const errored = payload.results.find((r: any) => r.source === 'error');
    expect(errored).toBeDefined();
    expect(errored.imagePath).toBe(missing);
    expect(errored.input).toBe(missing);
    expect(errored.error).toContain('FILE_NOT_FOUND');

    const analyzed = payload.results.filter((r: any) => r.source === 'fresh');
    expect(analyzed).toHaveLength(2);
  });

  // Regression (1.2.1, live 2026-06-01): a zero-charge analyze means the server
  // delta-billed everything from cache. Local files skip the client lookup, so
  // this is the only signal the re-run was free — it must count as a cache hit
  // AND show up in estimatedCreditsSaved (previously stuck at 0 for local files).
  it('counts a zero-charge analyze (server delta hit) as a cache hit + saving', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });
    const cb = captureToolCallback(server, 'analyze_batch');
    mockLookup.mockResolvedValue(emptyLookupResp()); // lookup misses -> analyze runs
    mockAnalyze
      .mockResolvedValueOnce(freshAnalyzeResp(0)) // server returned it free (cached)
      .mockResolvedValueOnce(freshAnalyzeResp(1)); // genuine fresh charge

    const res = await cb({
      imageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
      lenses: ['dating'],
    });
    const payload = JSON.parse(res.content[0].text);

    expect(payload.totalCacheHits).toBe(1);
    expect(payload.totalAnalyzed).toBe(1);
    expect(payload.totalCreditsCharged).toBe(1);
    expect(payload.estimatedCreditsSaved).toBe(1); // lensCount(1) - charged(0) on the cached one
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
