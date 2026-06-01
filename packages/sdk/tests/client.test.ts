import { PhototologyClient } from '../src/client';
import { AuthenticationError, PhototologyError } from '../src/errors';
import type { AnalyzeResponse, ModulesResponse } from '../src/types';

// Mock global fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

/** Helper to create a mock Response. */
function mockJsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

const TEST_KEY = 'pt_test_abc123def456';
const FIXTURE_RESPONSE: AnalyzeResponse = {
  id: 'ana_test123',
  object: 'analysis',
  livemode: true,
  schemaVersion: '1.0.0',
  createdAt: '2026-01-01T00:00:00Z',
  outputSchema: 'photo',
  output: { estimatedDate: { year: 1990, decade: '1990s', confidence: 'high' } },
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modulesUsed: ['dating'],
  },
  warnings: [],
  meta: {
    processingTimeMs: 1,
    provider: 'test-sandbox',
    promptHash: 'test-fixture',
    requestId: 'req_test',
    ai_generated: true,
    model: 'gemini-2.0-flash',
    vendor: 'google',
  },
};

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.PHOTOTOLOGY_API_KEY;
});

describe('PhototologyClient', () => {
  describe('constructor', () => {
    it('accepts apiKey in config', () => {
      const client = new PhototologyClient({ apiKey: TEST_KEY });
      expect(client).toBeDefined();
    });

    it('sends the default User-Agent on every request', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, FIXTURE_RESPONSE));
      const client = new PhototologyClient({ apiKey: TEST_KEY });
      await client.analyze({ imageUrl: 'https://example.com/photo.jpg' });

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['User-Agent']).toMatch(/^@phototology\/sdk\/\d+\.\d+\.\d+$/);
    });

    it('prepends a caller-provided userAgent to the SDK default', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, FIXTURE_RESPONSE));
      const client = new PhototologyClient({
        apiKey: TEST_KEY,
        userAgent: '@phototology/mcp/0.1.4',
      });
      await client.analyze({ imageUrl: 'https://example.com/photo.jpg' });

      const init = mockFetch.mock.calls[0][1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers['User-Agent']).toMatch(
        /^@phototology\/mcp\/0\.1\.4 @phototology\/sdk\/\d+\.\d+\.\d+$/,
      );
    });

    it('reads apiKey from PHOTOTOLOGY_API_KEY env var', () => {
      process.env.PHOTOTOLOGY_API_KEY = TEST_KEY;
      const client = new PhototologyClient();
      expect(client).toBeDefined();
    });

    it('throws if no apiKey provided and no env var', () => {
      expect(() => new PhototologyClient()).toThrow(PhototologyError);
    });

    it('accepts custom baseUrl, maxRetries, timeout', () => {
      const client = new PhototologyClient({
        apiKey: TEST_KEY,
        baseUrl: 'https://custom.api.test',
        maxRetries: 5,
        timeout: 30000,
      });
      expect(client).toBeDefined();
    });
  });

  describe('analyze', () => {
    it('sends POST /v1/analyze with correct headers and body', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, FIXTURE_RESPONSE));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });
      const result = await client.analyze({ imageUrl: 'https://example.com/photo.jpg' });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test/v1/analyze');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TEST_KEY}`);
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');

      const sentBody = JSON.parse(init?.body as string);
      expect(sentBody.imageUrl).toBe('https://example.com/photo.jpg');

      expect(result.id).toBe('ana_test123');
      expect(result.outputSchema).toBe('photo');
    });

    it('passes preset, modules, context, and options', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, FIXTURE_RESPONSE));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });
      await client.analyze({
        imageUrl: 'https://example.com/photo.jpg',
        preset: 'memorial',
        context: { knownPeople: [{ name: 'Alice' }] },
        options: { includeEmbedding: true },
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(sentBody.preset).toBe('memorial');
      expect(sentBody.context.knownPeople[0].name).toBe('Alice');
      expect(sentBody.options.includeEmbedding).toBe(true);
    });

    it('passes multi-image request', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, {
        ...FIXTURE_RESPONSE,
        outputSchema: 'vehicle',
        output: {},
      }));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });
      await client.analyze({
        images: [
          { url: 'https://example.com/front.jpg' },
          { url: 'https://example.com/rear.jpg' },
        ],
        preset: 'vehicle-condition',
      });

      const sentBody = JSON.parse(mockFetch.mock.calls[0][1]?.body as string);
      expect(sentBody.images).toHaveLength(2);
      expect(sentBody.images[0].url).toBe('https://example.com/front.jpg');
    });

    it('throws typed error on 401', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(401, {
        error: { code: 'AUTH_FAILED', message: 'Invalid key', retryable: false, requestId: 'req_1' },
      }));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });
      await expect(client.analyze({ imageUrl: 'https://example.com/photo.jpg' }))
        .rejects.toThrow(AuthenticationError);
    });

    it('uses custom baseUrl without trailing slash', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, FIXTURE_RESPONSE));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://custom.api/' });
      await client.analyze({ imageUrl: 'https://example.com/photo.jpg' });

      expect(mockFetch.mock.calls[0][0]).toBe('https://custom.api/v1/analyze');
    });
  });

  describe('modules', () => {
    it('sends GET /v1/modules with auth header', async () => {
      const modulesResponse: ModulesResponse = {
        modules: [{
          name: 'dating',
          description: 'Date estimation',
          category: 'temporal',
          outputFields: ['estimatedDate'],
          billable: true,
          defaultColumns: [
            { label: 'estimated_year', jsonPath: 'dating.estimatedYear', format: 'number' },
          ],
        }],
        presets: [{ name: 'full-analysis', description: 'Full analysis', modules: ['dating'] }],
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, modulesResponse));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });
      const result = await client.modules();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test/v1/modules');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TEST_KEY}`);

      expect(result.modules[0].name).toBe('dating');
      expect(result.presets[0].name).toBe('full-analysis');
    });
  });

  describe('usage', () => {
    it('sends GET /v1/usage with auth header and returns the dual-pool balance', async () => {
      const usageResponse = {
        tier: 'starter',
        community: { balance: 980, monthlyAllowance: 1000, resetsInDays: 14 },
        purchased: { balance: 0 },
        reserved: 2,
      };
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, usageResponse));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });
      const result = await client.usage();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test/v1/usage');
      expect(init?.method).toBe('GET');
      expect((init?.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TEST_KEY}`);

      expect(result.tier).toBe('starter');
      expect(result.community.balance).toBe(980);
      expect(result.community.resetsInDays).toBe(14);
      expect(result.purchased.balance).toBe(0);
      expect(result.reserved).toBe(2);
    });

    it('does not send a request body for the GET', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, {
        tier: 'starter',
        community: { balance: 1000, monthlyAllowance: 1000, resetsInDays: 30 },
        purchased: { balance: 0 },
        reserved: 0,
      }));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });
      await client.usage();

      const init = mockFetch.mock.calls[0][1];
      expect(init?.body).toBeUndefined();
    });

    it('throws AuthenticationError on 401', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(401, {
        error: { code: 'AUTH_FAILED', message: 'Invalid key', retryable: false, requestId: 'req_u1' },
      }));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });
      await expect(client.usage()).rejects.toThrow(AuthenticationError);
    });
  });

  describe('pre-emptive rate limit backoff', () => {
    it('delays next request when X-RateLimit-Remaining is 0', async () => {
      const resetTime = Math.floor(Date.now() / 1000) + 2; // 2 seconds from now
      // First call succeeds but signals rate limit exhausted
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, FIXTURE_RESPONSE, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(resetTime),
      }));
      // Second call succeeds normally
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, FIXTURE_RESPONSE));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });

      // First call — should return immediately
      await client.analyze({ imageUrl: 'https://example.com/photo.jpg' });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call — should delay until reset time
      const startMs = Date.now();
      await client.analyze({ imageUrl: 'https://example.com/photo2.jpg' });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      // Verify some delay occurred (at least 1s, allowing for timer imprecision)
      expect(Date.now() - startMs).toBeGreaterThanOrEqual(1000);
    });

    it('does not delay when X-RateLimit-Remaining is > 0', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, FIXTURE_RESPONSE, {
        'x-ratelimit-remaining': '5',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 60),
      }));
      mockFetch.mockResolvedValueOnce(mockJsonResponse(200, FIXTURE_RESPONSE));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });
      await client.analyze({ imageUrl: 'https://example.com/photo.jpg' });
      await client.analyze({ imageUrl: 'https://example.com/photo2.jpg' });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('API key security', () => {
    it('never includes API key in error messages', async () => {
      mockFetch.mockResolvedValueOnce(mockJsonResponse(401, {
        error: {
          code: 'AUTH_FAILED',
          message: `Key ${TEST_KEY} is invalid`,
          retryable: false,
          requestId: 'req_1',
        },
      }));

      const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });
      try {
        await client.analyze({ imageUrl: 'https://example.com/photo.jpg' });
      } catch (err) {
        expect((err as Error).message).not.toContain(TEST_KEY);
        expect((err as Error).message).toContain('[REDACTED]');
      }
    });
  });
});
