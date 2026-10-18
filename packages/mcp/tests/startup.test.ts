/**
 * Start-up and sandbox behaviour found by the 2026-10-18 production smoke
 * (mcp-e2e-smoke-report.md): the handshake must never wait on the key check
 * (C2), rate limits come back as RATE_LIMITED with a wait (I1), and a sandbox
 * key gets a plain SANDBOX_KEY answer from lookup_photo and get_credits (I2).
 *
 * Runs the real server and the real SDK client over an in-memory transport;
 * only global fetch is replaced.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { startServer } from '../src/server';

const SHA = 'a'.repeat(64);
const realFetch = global.fetch;
let fetchMock: jest.Mock;

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function apiError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code, message, retryable: status === 429, requestId: 'req_t' } }, headers);
}

/** A fetch that never answers, except to honour an abort. */
function neverAnswers(_url: unknown, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
}

async function connect(apiKey: string, budgetMs = 2000): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const started = startServer(apiKey, serverTransport, { version: '0.0.0-test' });
  const client = new Client({ name: 'startup-test', version: '0.0.1' });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    client.connect(clientTransport),
    new Promise((_r, reject) => { timer = setTimeout(() => reject(new Error(`initialize took longer than ${budgetMs} ms`)), budgetMs); }),
  ]).finally(() => clearTimeout(timer));
  const { server } = await started;
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function textOf(result: any): string {
  return result.content?.[0]?.text ?? '';
}

/** A tool error's first line: JSON with the machine fields. */
function headOf(result: any): Record<string, any> {
  return JSON.parse(textOf(result).split('\n')[0]);
}

/** A tool error's sentence: everything after the JSON first line. */
function sentenceOf(result: any): string {
  return textOf(result).split('\n').slice(1).join('\n');
}

let stderr: jest.SpyInstance;
let exit: jest.SpyInstance;

beforeEach(() => {
  fetchMock = jest.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
  stderr = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  exit = jest.spyOn(process, 'exit').mockImplementation(() => undefined as never);
});

afterEach(() => {
  global.fetch = realFetch;
  stderr.mockRestore();
  exit.mockRestore();
});

describe('C2: the handshake never waits for the key check', () => {
  it('initialize completes in under 2 s while the key check never answers', async () => {
    fetchMock.mockImplementation(neverAnswers);
    const start = Date.now();
    const { client, close } = await connect('pt_live_startupcheck');
    try {
      expect(Date.now() - start).toBeLessThan(2000);
      expect(client.getServerVersion()?.name).toBe('phototology');
    } finally {
      await close();
    }
  });

  it('the key check is one attempt: a network failure logs one warning, is not retried, and marks nothing', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    fetchMock.mockImplementation(async () => apiError(401, 'AUTH_FAILED', 'Invalid or revoked API key'));
    const { client, close } = await connect('pt_live_startupcheck');
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const warnings = stderr.mock.calls.map((c) => String(c[0])).filter((m) => /could not verify/i.test(m));
      expect(warnings).toHaveLength(1);
      expect(exit).not.toHaveBeenCalled();
      // A network failure says nothing about the key: later tool errors carry no start-up note.
      const result: any = await client.callTool({ name: 'get_credits', arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).not.toMatch(/start-up/i);
    } finally {
      await close();
    }
  });

  it('an invalid key does not exit after the handshake; the tools name the start-up failure', async () => {
    fetchMock.mockImplementation(async () => apiError(401, 'AUTH_FAILED', 'Invalid or revoked API key'));
    const { client, close } = await connect('pt_live_startupcheck');
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(exit).not.toHaveBeenCalled();
      const result: any = await client.callTool({ name: 'list_lenses', arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/at start-up/i);
      expect(textOf(result)).toContain('https://phototology.com/signup');
      expect(textOf(result)).not.toContain('api.phototology.com');
    } finally {
      await close();
    }
  });

  it('a pt_test_ key spends no sandbox request on start-up: its only call is the free /v1/usage probe', async () => {
    fetchMock.mockImplementation(neverAnswers);
    const { close } = await connect('pt_test_startupcheck');
    try {
      await new Promise((r) => setTimeout(r, 300));
      // GET /v1/usage is served before the API's anonymous limiter, so it costs no sandbox quota.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/v1\/usage$/);
    } finally {
      await close();
    }
  });
});

describe('I1: rate limits come back as RATE_LIMITED with the wait', () => {
  it('list_lenses on a spent sandbox day: isError, RATE_LIMITED, retryAfterSeconds, the one plain sentence', async () => {
    const reset = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    fetchMock.mockImplementation(async () => apiError(429, 'RATE_LIMITED', 'Anonymous test key daily limit exceeded. 10 requests per day per IP. Sign up for higher limits.', {
      'retry-after': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset),
    }));
    const { client, close } = await connect('pt_test_ratelimited');
    try {
      const start = Date.now();
      const result: any = await client.callTool({ name: 'list_lenses', arguments: {} });
      expect(Date.now() - start).toBeLessThan(2000);
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(sentenceOf(result).startsWith('RATE_LIMITED:')).toBe(true);
      expect(text).toContain('The sandbox key allows 2 requests a minute and 10 a day per IP; sign up for an account key at https://phototology.com/signup to lift this.');
      expect(result.structuredContent).toBeUndefined();
      // A day-long wait: no retry inside the session helps.
      expect(headOf(result)).toEqual(expect.objectContaining({ code: 'RATE_LIMITED', retryable: false }));
      expect(headOf(result).retryAfterSeconds).toBeGreaterThan(24 * 60 * 60 - 60);
      // One request for list_lenses (the other is the free /v1/usage start-up probe).
      expect(fetchMock.mock.calls.filter((c) => !String(c[0]).endsWith('/v1/usage'))).toHaveLength(1);
    } finally {
      await close();
    }
  });
});

describe('I1 with an account key', () => {
  it('a rate-limited start-up check does not add a start-up note to the RATE_LIMITED tool error', async () => {
    fetchMock.mockImplementation(async () => apiError(429, 'RATE_LIMITED', 'Rate limit exceeded.', { 'retry-after': '60' }));
    const { client, close } = await connect('pt_live_ratelimited');
    try {
      await new Promise((r) => setTimeout(r, 300));
      const result: any = await client.callTool({ name: 'list_lenses', arguments: {} });
      const text = textOf(result);
      expect(sentenceOf(result).startsWith('RATE_LIMITED:')).toBe(true);
      expect(text).not.toMatch(/start-up/i);
      // An account key is not told about the sandbox limits.
      expect(text).not.toContain('The sandbox key allows');
      expect(headOf(result).retryAfterSeconds).toBeGreaterThanOrEqual(59);
      expect(headOf(result).retryable).toBe(true);
    } finally {
      await close();
    }
  });
});

describe('I2: sandbox keys get a plain answer from lookup_photo and get_credits', () => {
  it.each([
    ['lookup_photo', { sha256: SHA }, 'Lookup requires an API key linked to an account'],
    ['get_credits', {}, 'Invalid or revoked API key'],
  ])('%s with a pt_test_ key: SANDBOX_KEY, not retryable, no "auth failed"', async (tool, args, apiMessage) => {
    fetchMock.mockImplementation(async () => apiError(401, 'AUTH_FAILED', apiMessage));
    const { client, close } = await connect('pt_test_sandboxkey');
    try {
      const result: any = await client.callTool({ name: tool, arguments: args });
      expect(result.isError).toBe(true);
      const text = textOf(result);
      expect(sentenceOf(result).startsWith('SANDBOX_KEY:')).toBe(true);
      expect(text).toContain('Sandbox keys cannot read the registry or a balance');
      expect(text).toContain('analyze_photo and analyze_batch return fixture data');
      expect(text).toContain('https://phototology.com/signup');
      expect(text).not.toMatch(/auth failed/i);
      expect(result.structuredContent).toBeUndefined();
      expect(headOf(result)).toEqual(expect.objectContaining({ code: 'SANDBOX_KEY', retryable: false }));
    } finally {
      await close();
    }
  });

  it('the same 401 with a pt_live_ key is an auth failure that points at the signup page', async () => {
    fetchMock.mockImplementation(async () => apiError(401, 'AUTH_FAILED', 'Invalid or revoked API key'));
    const { client, close } = await connect('pt_live_badkey');
    try {
      const result: any = await client.callTool({ name: 'get_credits', arguments: {} });
      const text = textOf(result);
      expect(sentenceOf(result).startsWith('SANDBOX_KEY:')).toBe(false);
      expect(text).toMatch(/auth failed/i);
      expect(text).toContain('https://phototology.com/signup');
      expect(text).not.toContain('api.phototology.com');
    } finally {
      await close();
    }
  });
});
