import { fetchWithRetry } from '../src/retry';
import { PhototologyError } from '../src/errors';

// Mock global fetch
const mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
global.fetch = mockFetch;

/** Helper to create a mock Response. */
function mockResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('fetchWithRetry', () => {
  it('returns response on 200', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(200, { data: 'ok' }));

    const result = await fetchWithRetry('https://api.test/v1/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }, { maxRetries: 3, timeout: 60000 });

    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on non-retryable error (401)', async () => {
    mockFetch.mockResolvedValueOnce(mockResponse(401, {
      error: { code: 'AUTH_FAILED', message: 'Bad key', retryable: false, requestId: 'req_1' },
    }));

    await expect(
      fetchWithRetry('https://api.test/v1/analyze', { method: 'POST' }, { maxRetries: 3, timeout: 60000 }),
    ).rejects.toThrow(PhototologyError);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error (502) up to maxRetries', async () => {
    const errBody = {
      error: { code: 'PROVIDER_UNAVAILABLE', message: 'Down', retryable: true, requestId: 'req_2' },
    };
    mockFetch
      .mockResolvedValueOnce(mockResponse(502, errBody))
      .mockResolvedValueOnce(mockResponse(502, errBody))
      .mockResolvedValueOnce(mockResponse(200, { data: 'ok' }));

    const promise = fetchWithRetry('https://api.test/v1/analyze', { method: 'POST' }, { maxRetries: 3, timeout: 60000 });

    // Advance timers past the backoff delays
    await jest.advanceTimersByTimeAsync(500);  // first retry backoff
    await jest.advanceTimersByTimeAsync(1000); // second retry backoff

    const result = await promise;
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('throws after exhausting maxRetries', async () => {
    const errBody = {
      error: { code: 'PARSE_FAILED', message: 'Bad parse', retryable: true, requestId: 'req_3' },
    };
    mockFetch
      .mockResolvedValueOnce(mockResponse(500, errBody))
      .mockResolvedValueOnce(mockResponse(500, errBody))
      .mockResolvedValueOnce(mockResponse(500, errBody))
      .mockResolvedValueOnce(mockResponse(500, errBody));

    const promise = fetchWithRetry('https://api.test/v1/analyze', { method: 'POST' }, { maxRetries: 3, timeout: 60000 });

    // Attach rejection handler BEFORE advancing timers to avoid unhandled rejection
    const assertion = expect(promise).rejects.toThrow(PhototologyError);

    // Flush all pending timers (backoff sleeps between retries)
    await jest.runAllTimersAsync();

    await assertion;
    expect(mockFetch).toHaveBeenCalledTimes(4); // initial + 3 retries
  });

  it('respects Retry-After header exactly', async () => {
    const errBody = {
      error: { code: 'RATE_LIMITED', message: 'Slow down', retryable: true, requestId: 'req_4' },
    };
    mockFetch
      .mockResolvedValueOnce(mockResponse(429, errBody, { 'retry-after': '5' }))
      .mockResolvedValueOnce(mockResponse(200, { data: 'ok' }));

    const promise = fetchWithRetry('https://api.test/v1/analyze', { method: 'POST' }, { maxRetries: 3, timeout: 60000 });

    // Must wait the full 5 seconds from Retry-After
    await jest.advanceTimersByTimeAsync(5000);

    const result = await promise;
    expect(result.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('handles non-JSON error response gracefully', async () => {
    const badResponse = {
      ok: false,
      status: 500,
      headers: new Headers(),
      json: () => Promise.reject(new Error('not JSON')),
      text: () => Promise.resolve('Internal Server Error'),
    } as Response;
    mockFetch.mockResolvedValueOnce(badResponse);

    await expect(
      fetchWithRetry('https://api.test/v1/analyze', { method: 'POST' }, { maxRetries: 0, timeout: 60000 }),
    ).rejects.toThrow(PhototologyError);
  });
});
