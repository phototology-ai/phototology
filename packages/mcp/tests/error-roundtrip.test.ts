/**
 * Tool errors through the real @modelcontextprotocol/sdk Client (2026-10-18
 * local end-to-end run). The client validates `structuredContent` against the
 * tool's outputSchema even when `isError` is true, once `listTools` has cached
 * the schemas, so an error with `structuredContent` reached the agent as
 * "-32602 Structured content does not match the tool's output schema" and its
 * text never arrived. Errors now carry no `structuredContent`: the first text
 * line is JSON (`code`, `retryable`, ...), the sentence follows.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startServer } from '../src/server';

const SHA = 'b'.repeat(64);
const realFetch = global.fetch;
const realBaseUrl = process.env.PHOTOTOLOGY_BASE_URL;
let fetchMock: jest.Mock;

function apiError(status: number, code: string, message: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message, retryable: status === 429, requestId: 'req_rt', ...extra } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function connect(apiKey: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const started = startServer(apiKey, serverTransport, { version: '0.0.0-test' });
  const client = new Client({ name: 'roundtrip', version: '0.0.1' });
  await client.connect(clientTransport);
  const { server } = await started;
  // Arms the client's outputSchema validators, as a real host does.
  await client.listTools();
  return { client, close: async () => { await client.close(); await server.close(); } };
}

/** The first text line, parsed: the machine-readable part of a tool error. */
function head(result: any): Record<string, any> {
  return JSON.parse(String(result.content[0].text).split('\n')[0]);
}

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  global.fetch = realFetch;
  if (realBaseUrl === undefined) delete process.env.PHOTOTOLOGY_BASE_URL;
  else process.env.PHOTOTOLOGY_BASE_URL = realBaseUrl;
  jest.restoreAllMocks();
});

describe('tool errors round-trip through the real client', () => {
  it('RATE_LIMITED on list_lenses: no throw, no structuredContent, code in the first line, the reset in the sentence', async () => {
    const reset = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    fetchMock.mockImplementation(async () => apiError(429, 'RATE_LIMITED', 'Anonymous test key daily limit exceeded. 10 requests per day per IP.', {
      'retry-after': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset),
    }));
    const { client, close } = await connect('pt_test_roundtrip');
    try {
      const result: any = await client.callTool({ name: 'list_lenses', arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const h = head(result);
      expect(h.code).toBe('RATE_LIMITED');
      expect(h.retryAfterSeconds).toBeGreaterThan(24 * 60 * 60 - 60);
      expect(result.content[0].text).toContain('RATE_LIMITED');
      expect(result.content[0].text).toMatch(/resets in 24 hours/);
    } finally {
      await close();
    }
  });

  it.each([
    [600, true],
    [601, false],
  ])('RATE_LIMITED with a %i s wait is retryable: %s', async (seconds, retryable) => {
    fetchMock.mockImplementation(async () => apiError(429, 'RATE_LIMITED', 'Rate limit exceeded.', { 'retry-after': String(seconds) }));
    const { client, close } = await connect('pt_live_roundtrip');
    try {
      const result: any = await client.callTool({ name: 'list_lenses', arguments: {} });
      const h = head(result);
      expect(h).toEqual(expect.objectContaining({ code: 'RATE_LIMITED', retryable, retryAfterSeconds: seconds }));
      expect(result.content[0].text).toMatch(/resets in/);
    } finally {
      await close();
    }
  });

  it('SANDBOX_KEY on get_credits round-trips with its sentence', async () => {
    fetchMock.mockImplementation(async () => apiError(401, 'AUTH_FAILED', 'Invalid or revoked API key'));
    const { client, close } = await connect('pt_test_roundtrip');
    try {
      const result: any = await client.callTool({ name: 'get_credits', arguments: {} });
      expect(result.structuredContent).toBeUndefined();
      expect(head(result)).toEqual(expect.objectContaining({ code: 'SANDBOX_KEY', retryable: false }));
      expect(result.content[0].text).toContain('Sandbox keys cannot read the registry or a balance');
    } finally {
      await close();
    }
  });

  it('OUT_OF_CREDITS on analyze_photo round-trips with the wallet URL', async () => {
    fetchMock.mockImplementation(async () => apiError(402, 'PLAN_LIMIT_EXCEEDED', 'Out of credits', {}, {
      credits: { needed: 3, community: 0, purchased: 0, total: 0 },
    }));
    const { client, close } = await connect('pt_live_roundtrip');
    try {
      const result: any = await client.callTool({ name: 'analyze_photo', arguments: { imageUrl: 'https://example.com/a.jpg' } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(head(result)).toEqual(expect.objectContaining({ code: 'OUT_OF_CREDITS', retryable: false, actionUrl: 'https://phototology.com/wallet' }));
      expect(result.content[0].text).toContain('OUT_OF_CREDITS: Balance 0, need 3 credits.');
    } finally {
      await close();
    }
  });

  it('NETWORK_ERROR names the base URL in use and the variable that sets it', async () => {
    process.env.PHOTOTOLOGY_BASE_URL = 'http://127.0.0.1:9';
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const { client, close } = await connect('pt_live_roundtrip');
    try {
      const result: any = await client.callTool({ name: 'list_lenses', arguments: {} });
      expect(head(result)).toEqual(expect.objectContaining({ code: 'NETWORK_ERROR', retryable: true }));
      expect(result.content[0].text).toContain('http://127.0.0.1:9');
      expect(result.content[0].text).toContain('PHOTOTOLOGY_BASE_URL');
    } finally {
      await close();
    }
  }, 15_000);

  it('NETWORK_ERROR names the default base URL when the variable is unset', async () => {
    delete process.env.PHOTOTOLOGY_BASE_URL;
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const { client, close } = await connect('pt_live_roundtrip');
    try {
      const result: any = await client.callTool({ name: 'list_lenses', arguments: {} });
      expect(result.content[0].text).toContain('https://api.phototology.com');
      expect(result.content[0].text).toContain('PHOTOTOLOGY_BASE_URL');
    } finally {
      await close();
    }
  }, 15_000);
});

describe('enrich_photo when the paid sidecar cannot be saved', () => {
  const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n<rdf:RDF/>\n</x:xmpmeta>';
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00]);
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-enrich-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips as text only: JSON first line with code, retryable, sidecarPath and the packet; then the sentence', async () => {
    const photo = path.join(dir, 'signed.jpg');
    fs.writeFileSync(photo, JPEG);
    fs.writeFileSync(`${photo}.xmp`, 'darktable edits');
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/v2/enrich')) {
        return new Response(JSON.stringify({
          object: 'enrichment',
          mode: 'sidecar',
          sidecar: { xmp: XMP },
          formatsWritten: ['xmp'],
          lensVersions: { dating: '1.0' },
          sha256: 'deadbeef'.repeat(8),
          credentials: { status: 'valid' },
          reason: 'Writing into the file would invalidate its Content Credential.',
          meta: { requestId: 'req_side', processingTimeMs: 40, creditsCharged: 5, ai_generated: true },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return apiError(404, 'NOT_FOUND', 'not found');
    });
    const { client, close } = await connect('pt_live_roundtrip');
    try {
      const result: any = await client.callTool({ name: 'enrich_photo', arguments: { imagePath: photo } });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const [first, ...rest] = String(result.content[0].text).split('\n');
      const h = JSON.parse(first);
      expect(h).toEqual(expect.objectContaining({
        code: 'OUTPUT_EXISTS',
        retryable: false,
        sidecarPath: `${photo}.xmp`,
        sidecar: { xmp: XMP },
      }));
      expect(rest.join('\n')).toMatch(/sidecar was not saved/i);
      expect(fs.readFileSync(`${photo}.xmp`, 'utf8')).toBe('darktable edits');
    } finally {
      await close();
    }
  });
});

describe('local path errors round-trip as a one-line JSON head and a sentence', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-local-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it.each([
    ['analyze_photo', () => ({ imagePath: path.join(dir, 'missing.jpg'), lenses: ['describe'] }), 'FILE_NOT_FOUND'],
    ['lookup_photo', () => ({ imagePath: 'relative/photo.jpg' }), 'RELATIVE_PATH_REJECTED'],
    ['enrich_photo', () => {
      const p = path.join(dir, 'a.jpg');
      fs.writeFileSync(p, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]));
      return { imagePath: p, outputPath: p, overwrite: true };
    }, 'OUTPUT_IS_INPUT'],
  ])('%s: %s', async (tool, args, code) => {
    const { client, close } = await connect('pt_live_roundtrip');
    try {
      const result: any = await client.callTool({ name: tool, arguments: (args as () => Record<string, unknown>)() });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      const text = String(result.content[0].text);
      const [first, ...rest] = text.split('\n');
      expect(first.startsWith('{') && first.endsWith('}')).toBe(true);
      expect(JSON.parse(first)).toEqual(expect.objectContaining({ code, retryable: false }));
      expect(rest.join('\n').length).toBeGreaterThan(10);
      expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining('/v1/analyze'), expect.anything());
    } finally {
      await close();
    }
  });
});

describe('an anonymous sandbox key: SANDBOX_KEY locally, before any network call', () => {
  async function connectAnonymous(): Promise<{ client: Client; close: () => Promise<void> }> {
    // The free /v1/usage probe (outside the anonymous limiter) says this key has no account.
    fetchMock.mockImplementation(async () => apiError(401, 'AUTH_FAILED', 'Invalid or revoked API key'));
    const conn = await connect('pt_test_anonymous');
    await new Promise((r) => setTimeout(r, 50));
    fetchMock.mockClear();
    return conn;
  }

  it.each([
    ['lookup_photo', { sha256: SHA }],
    ['get_credits', {}],
    ['enrich_photo', { imageUrl: 'https://example.com/a.jpg' }],
  ])('%s makes no request and answers SANDBOX_KEY', async (tool, args) => {
    const { client, close } = await connectAnonymous();
    try {
      const result: any = await client.callTool({ name: tool, arguments: args });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(head(result)).toEqual(expect.objectContaining({ code: 'SANDBOX_KEY', retryable: false }));
    } finally {
      await close();
    }
  });

  it('the photo resource makes no request and reads as SANDBOX_KEY', async () => {
    const { client, close } = await connectAnonymous();
    try {
      const res: any = await client.readResource({ uri: `phototology://photo/${SHA}` });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(String(res.contents[0].text)).toContain('SANDBOX_KEY');
    } finally {
      await close();
    }
  });

  it('the only start-up request is the free GET /v1/usage probe', async () => {
    fetchMock.mockImplementation(async () => apiError(401, 'AUTH_FAILED', 'Invalid or revoked API key'));
    const { close } = await connect('pt_test_anonymous');
    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/usage$/);
    } finally {
      await close();
    }
  });

  it('an account-linked pt_test_ key (the probe answers 200) still reaches the network', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).endsWith('/v1/usage')) {
        return new Response(JSON.stringify({ tier: 'starter', community: { balance: 0 }, purchased: { balance: 0 }, reserved: 0, total: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ object: 'lookup', results: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const { client, close } = await connect('pt_test_accountlinked');
    try {
      await new Promise((r) => setTimeout(r, 50));
      fetchMock.mockClear();
      await client.callTool({ name: 'lookup_photo', arguments: { sha256: SHA } });
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/v2/lookup'), expect.anything());
    } finally {
      await close();
    }
  });
});

describe('the photo resource with a sandbox key', () => {
  it('reads as the SANDBOX_KEY sentence, not a protocol error', async () => {
    fetchMock.mockImplementation(async () => apiError(401, 'AUTH_FAILED', 'Lookup requires an API key linked to an account'));
    const { client, close } = await connect('pt_test_roundtrip');
    try {
      const res: any = await client.readResource({ uri: `phototology://photo/${SHA}` });
      const text = String(res.contents[0].text);
      expect(text).toContain('SANDBOX_KEY');
      expect(text).toContain('Sandbox keys cannot read the registry or a balance');
    } finally {
      await close();
    }
  });
});
