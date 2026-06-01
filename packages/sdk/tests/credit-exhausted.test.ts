import { PhototologyClient } from '../src/client';
import { CreditExhaustedError, PhototologyError, PlanLimitError } from '../src/errors';

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

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.PHOTOTOLOGY_API_KEY;
});

describe('CreditExhaustedError (402 response)', () => {
  it('throws CreditExhaustedError on 402 with credits object', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(402, {
        error: {
          code: 'PLAN_LIMIT_EXCEEDED',
          message: 'Insufficient credits. 5 needed, 2 available.',
          retryable: false,
          requestId: 'req_credit_1',
          credits: {
            needed: 5,
            community: 2,
            purchased: 0,
            total: 2,
            resetsInDays: 12,
          },
        },
      }),
    );

    const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });

    await expect(
      client.analyze({
        imageUrl: 'https://example.com/photo.jpg',
        modules: ['dating', 'people', 'atmosphere', 'location', 'entities'],
      }),
    ).rejects.toBeInstanceOf(CreditExhaustedError);
  });

  it('populates all fields from the credits object', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(402, {
        error: {
          code: 'PLAN_LIMIT_EXCEEDED',
          message: 'Insufficient credits. 5 needed, 2 available.',
          retryable: false,
          requestId: 'req_credit_2',
          credits: {
            needed: 5,
            community: 2,
            purchased: 0,
            total: 2,
            resetsInDays: 12,
          },
        },
      }),
    );

    const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });

    try {
      await client.analyze({ imageUrl: 'https://example.com/photo.jpg' });
      fail('Expected CreditExhaustedError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CreditExhaustedError);
      const e = err as CreditExhaustedError;
      expect(e.creditsRequired).toBe(5);
      expect(e.communityBalance).toBe(2);
      expect(e.purchasedBalance).toBe(0);
      expect(e.totalBalance).toBe(2);
      expect(e.resetsInDays).toBe(12);
      expect(e.purchaseUrl).toBe('https://phototology.com/wallet');
      expect(e.status).toBe(402);
      expect(e.code).toBe('PLAN_LIMIT_EXCEEDED');
      expect(e.requestId).toBe('req_credit_2');
      expect(e.retryable).toBe(false);
    }
  });

  it('is also an instance of PhototologyError (shared hierarchy)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(402, {
        error: {
          code: 'PLAN_LIMIT_EXCEEDED',
          message: 'Insufficient credits.',
          retryable: false,
          requestId: 'req_credit_3',
          credits: { needed: 1, community: 0, purchased: 0, total: 0, resetsInDays: 7 },
        },
      }),
    );

    const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });

    try {
      await client.analyze({ imageUrl: 'https://example.com/photo.jpg' });
      fail('Expected CreditExhaustedError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CreditExhaustedError);
      expect(err).toBeInstanceOf(PhototologyError);
    }
  });

  it('handles missing resetsInDays (purchased-only user with no community pool to reset)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(402, {
        error: {
          code: 'PLAN_LIMIT_EXCEEDED',
          message: 'Insufficient credits.',
          retryable: false,
          requestId: 'req_credit_4',
          credits: { needed: 3, community: 0, purchased: 1, total: 1 },
        },
      }),
    );

    const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });

    try {
      await client.analyze({ imageUrl: 'https://example.com/photo.jpg' });
      fail('Expected CreditExhaustedError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CreditExhaustedError);
      const e = err as CreditExhaustedError;
      expect(e.creditsRequired).toBe(3);
      expect(e.resetsInDays).toBeUndefined();
    }
  });

  it('falls back to PlanLimitError when 402 has no credits object (backward compat)', async () => {
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse(402, {
        error: {
          code: 'PLAN_LIMIT_EXCEEDED',
          message: 'Free tier limit reached',
          retryable: false,
          requestId: 'req_credit_5',
        },
      }),
    );

    const client = new PhototologyClient({ apiKey: TEST_KEY, baseUrl: 'https://api.test' });

    await expect(
      client.analyze({ imageUrl: 'https://example.com/photo.jpg' }),
    ).rejects.toBeInstanceOf(PlanLimitError);
  });

  it('allows callers to override purchaseUrl when constructing directly', () => {
    const err = new CreditExhaustedError('Out of credits', {
      code: 'PLAN_LIMIT_EXCEEDED',
      status: 402,
      retryable: false,
      requestId: 'req_direct',
      creditsRequired: 10,
      communityBalance: 0,
      purchasedBalance: 0,
      totalBalance: 0,
      resetsInDays: 5,
      purchaseUrl: 'https://enterprise.example.com/buy',
    });

    expect(err.purchaseUrl).toBe('https://enterprise.example.com/buy');
  });

  it('defaults purchaseUrl when constructing without one', () => {
    const err = new CreditExhaustedError('Out of credits', {
      code: 'PLAN_LIMIT_EXCEEDED',
      status: 402,
      retryable: false,
      requestId: 'req_default',
      creditsRequired: 1,
      communityBalance: 0,
      purchasedBalance: 0,
      totalBalance: 0,
    });

    expect(err.purchaseUrl).toBe('https://phototology.com/wallet');
  });
});
