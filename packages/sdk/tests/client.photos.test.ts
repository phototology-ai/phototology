import { PhototologyClient } from '../src/client';
import { ValidationError, PhototologyError } from '../src/errors';
import type { PhotoResponse, Receipt, VerifyResponse } from '../src/types';
import fixtures from './fixtures/receipts.json';

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

function mockJsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

const SHA = 'a'.repeat(64);
const receipt = fixtures.receipts[0].receipt as unknown as Receipt;
const client = () => new PhototologyClient({ apiKey: 'pt_test_abc123', baseUrl: 'https://api.test', maxRetries: 3 });

beforeEach(() => mockFetch.mockReset());

describe('client.getPhoto', () => {
  const body: PhotoResponse = {
    object: 'photo',
    photo: {
      sha256: SHA,
      pHash: 'b'.repeat(16),
      dHash: 'c'.repeat(16),
      firstAnalyzedAt: '2026-10-17T00:00:00.000Z',
      lastAnalyzedAt: '2026-10-17T00:00:00.000Z',
      totalCreditsSpent: 1,
      analyzeCallCount: 1,
      lenses: {},
    },
    receipts: [receipt],
    credentials: { status: 'unread', note: 'Content Credentials are not read yet.' },
    firstSeenAt: '2026-10-17T00:00:00.000Z',
    lastAnalyzedAt: '2026-10-17T00:00:00.000Z',
  };

  it('GETs /v2/photos/<sha256> and returns the record with receipts', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, body));
    const res = await client().getPhoto(SHA);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe(`https://api.test/v2/photos/${SHA}`);
    expect(init?.method).toBe('GET');
    expect(res.receipts[0].payload.id).toBe('rcpt_fixture_minimal');
    expect(res.credentials.status).toBe('unread');
  });

  it.each([
    ['a path', '../v1/usage'],
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['non-hex', 'g'.repeat(64)],
    ['empty', ''],
  ])('rejects a sha256 that is %s with ValidationError and never calls fetch', async (_label, sha) => {
    const err = await client().getPhoto(sha).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).code).toBe('VALIDATION_FAILED');
    expect((err as ValidationError).status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('accepts an uppercase hex sha256', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, body));
    await client().getPhoto(SHA.toUpperCase());
    expect(mockFetch.mock.calls[0][0]).toBe(`https://api.test/v2/photos/${SHA.toUpperCase()}`);
  });

  it('throws on 404 PHOTO_NOT_IN_REGISTRY without retrying', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse(404, {
        error: { code: 'PHOTO_NOT_IN_REGISTRY', message: 'Photo not found', retryable: false, requestId: 'req_1' },
      }),
    );
    const err = await client().getPhoto(SHA).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhototologyError);
    expect((err as PhototologyError).code).toBe('PHOTO_NOT_IN_REGISTRY');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('client.verifyReceipt', () => {
  const ok: VerifyResponse = {
    valid: true,
    livemode: false,
    keyId: 'sandbox',
    signature: 'valid',
    timestamp: 'pending',
    issuedAt: '2026-10-17T00:00:00.000Z',
    checkedAt: '2026-10-17T00:00:01.000Z',
  };

  it('POSTs { receipt } to /v1/verify', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, ok));
    const res = await client().verifyReceipt(receipt);
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test/v1/verify');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ receipt });
    expect(res).toEqual(ok);
  });

  it('does not retry a 4xx', async () => {
    mockFetch.mockResolvedValue(
      mockJsonResponse(400, {
        error: { code: 'VALIDATION_FAILED', message: 'bad receipt', retryable: false, requestId: 'req_2' },
      }),
    );
    await expect(client().verifyReceipt(receipt)).rejects.toBeInstanceOf(ValidationError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('client.getJwks', () => {
  it('GETs /.well-known/phototology-keys.json', async () => {
    const keys = { keys: [{ kty: 'EC', crv: 'P-256', x: 'x', y: 'y', kid: 'sandbox' }] };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, keys));
    const res = await client().getJwks();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.test/.well-known/phototology-keys.json');
    expect(init?.method).toBe('GET');
    expect(res.keys[0].kid).toBe('sandbox');
  });
});

describe('API key on public routes', () => {
  function headersOf(call: number): Record<string, string> {
    return (mockFetch.mock.calls[call][1]?.headers ?? {}) as Record<string, string>;
  }

  it('verifyReceipt and getJwks send no Authorization header; getPhoto does', async () => {
    const verified: VerifyResponse = {
      valid: true, livemode: false, keyId: 'sandbox', signature: 'valid', timestamp: 'unavailable',
      timestampedAt: null, issuedAt: '2026-10-17T00:00:00.000Z', checkedAt: '2026-10-17T00:00:01.000Z',
    };
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, verified));
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, { keys: [] }));
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, { object: 'photo', receipts: [] }));

    const c = client();
    await c.verifyReceipt(receipt);
    await c.getJwks();
    await c.getPhoto(SHA);

    expect(headersOf(0)).not.toHaveProperty('Authorization');
    expect(headersOf(1)).not.toHaveProperty('Authorization');
    expect(headersOf(2).Authorization).toBe('Bearer pt_test_abc123');
    // The other headers stay on the public calls.
    expect(headersOf(0)['Content-Type']).toBe('application/json');
    expect(headersOf(1)['User-Agent']).toBeDefined();
  });
});
