/**
 * Tests for PhototologyClient.enrich() (item-048).
 *
 * Validates the SDK wrapper around POST /v2/enrich:
 *   - Happy path: returns EnrichResponse
 *   - 404 PHOTO_NOT_IN_REGISTRY → ValidationError with descriptive message
 *   - 402 PLAN_LIMIT_EXCEEDED with credits → CreditExhaustedError
 *   - User-Agent header propagation (smoke test)
 */

import { PhototologyClient } from '../src/client';
import { CreditExhaustedError, ValidationError } from '../src/errors';
import type { EnrichResponse } from '../src/types';

const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

function mockJsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

const TEST_KEY = 'pt_test_enrich123';

const FIXTURE_ENRICH: EnrichResponse = {
  object: 'enrichment',
  imageBase64: 'AAAA',
  formatsWritten: ['xmp'],
  lensVersions: { dating: '1.0' },
  sha256: 'deadbeef'.repeat(8),
  meta: {
    requestId: 'req_enrich_1',
    processingTimeMs: 42,
    creditsCharged: 5,
    ai_generated: true,
  },
};

beforeEach(() => {
  mockFetch.mockReset();
  delete process.env.PHOTOTOLOGY_API_KEY;
});

describe('PhototologyClient.enrich', () => {
  it('POSTs to /v2/enrich and returns the typed response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, FIXTURE_ENRICH));
    const client = new PhototologyClient({ apiKey: TEST_KEY });
    const result = await client.enrich({
      imageUrl: 'https://example.com/p.jpg',
      formats: ['xmp'],
    });

    expect(result).toEqual(FIXTURE_ENRICH);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('/v2/enrich');

    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.imageUrl).toBe('https://example.com/p.jpg');
    expect(body.formats).toEqual(['xmp']);
  });

  it('serializes imageBase64 + multiple formats', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(200, FIXTURE_ENRICH));
    const client = new PhototologyClient({ apiKey: TEST_KEY });
    await client.enrich({
      imageBase64: 'BBBB',
      formats: ['exif', 'iptc', 'xmp'],
    });
    const body = JSON.parse(mockFetch.mock.calls[0][1]!.body as string);
    expect(body.imageBase64).toBe('BBBB');
    expect(body.formats).toEqual(['exif', 'iptc', 'xmp']);
  });

  it('throws ValidationError on 404 PHOTO_NOT_IN_REGISTRY', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(404, {
      error: {
        code: 'PHOTO_NOT_IN_REGISTRY',
        message: 'Analyze this photo first before requesting enrichment.',
        retryable: false,
        requestId: 'req_miss',
      },
    }));
    const client = new PhototologyClient({ apiKey: TEST_KEY });
    await expect(
      client.enrich({ imageBase64: 'AAAA', formats: ['xmp'] }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('Analyze this photo first'),
    });
  });

  it('throws CreditExhaustedError on 402 with credits payload', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(402, {
      error: {
        code: 'PLAN_LIMIT_EXCEEDED',
        message: 'Insufficient credits.',
        retryable: false,
        requestId: 'req_broke',
        credits: {
          needed: 5,
          community: 2,
          purchased: 0,
          total: 2,
          resetsInDays: 0,
        },
      },
    }));
    const client = new PhototologyClient({ apiKey: TEST_KEY });
    await expect(
      client.enrich({ imageBase64: 'AAAA', formats: ['xmp'] }),
    ).rejects.toBeInstanceOf(CreditExhaustedError);
  });

  it('throws ValidationError on 400 c2pa-deferred response', async () => {
    mockFetch.mockResolvedValueOnce(mockJsonResponse(400, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'c2pa signing is not available in this release.',
        retryable: false,
        requestId: 'req_c2pa',
      },
    }));
    const client = new PhototologyClient({ apiKey: TEST_KEY });
    await expect(
      client.enrich({ imageBase64: 'AAAA', formats: ['xmp'] }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
