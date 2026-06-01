import {
  PhototologyError,
  AuthenticationError,
  ValidationError,
  RateLimitedError,
  ParseError,
  InternalError,
  ProviderError,
  PlanLimitError,
} from '../src/errors';

describe('PhototologyError', () => {
  it('extends Error with code, status, retryable, requestId', () => {
    const err = new PhototologyError('Test error', {
      code: 'INTERNAL_ERROR',
      status: 500,
      retryable: false,
      requestId: 'req_123',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Test error');
    expect(err.code).toBe('INTERNAL_ERROR');
    expect(err.status).toBe(500);
    expect(err.retryable).toBe(false);
    expect(err.requestId).toBe('req_123');
    expect(err.name).toBe('PhototologyError');
  });

  describe('fromResponse', () => {
    it('creates AuthenticationError for AUTH_FAILED', () => {
      const err = PhototologyError.fromResponse(401, {
        error: { code: 'AUTH_FAILED', message: 'Invalid key', retryable: false, requestId: 'req_1' },
      });
      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err.status).toBe(401);
      expect(err.retryable).toBe(false);
    });

    it('creates ValidationError for VALIDATION_FAILED', () => {
      const err = PhototologyError.fromResponse(400, {
        error: { code: 'VALIDATION_FAILED', message: 'Bad input', retryable: false, requestId: 'req_2' },
      });
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.status).toBe(400);
    });

    it('creates RateLimitedError for RATE_LIMITED with retryAfter', () => {
      const err = PhototologyError.fromResponse(
        429,
        { error: { code: 'RATE_LIMITED', message: 'Too fast', retryable: true, requestId: 'req_3' } },
        { 'retry-after': '30' },
      );
      expect(err).toBeInstanceOf(RateLimitedError);
      expect(err.retryable).toBe(true);
      expect((err as RateLimitedError).retryAfter).toBe(30);
    });

    it('creates ParseError for PARSE_FAILED (retryable)', () => {
      const err = PhototologyError.fromResponse(500, {
        error: { code: 'PARSE_FAILED', message: 'Bad JSON from AI', retryable: true, requestId: 'req_4' },
      });
      expect(err).toBeInstanceOf(ParseError);
      expect(err.retryable).toBe(true);
    });

    it('creates InternalError for INTERNAL_ERROR (not retryable)', () => {
      const err = PhototologyError.fromResponse(500, {
        error: { code: 'INTERNAL_ERROR', message: 'Server bug', retryable: false, requestId: 'req_5' },
      });
      expect(err).toBeInstanceOf(InternalError);
      expect(err.retryable).toBe(false);
    });

    it('creates ProviderError for PROVIDER_UNAVAILABLE', () => {
      const err = PhototologyError.fromResponse(502, {
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'Gemini down', retryable: true, requestId: 'req_6' },
      });
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(true);
    });

    it('creates ProviderError for PROVIDER_ERROR', () => {
      const err = PhototologyError.fromResponse(502, {
        error: { code: 'PROVIDER_ERROR', message: 'Bad response', retryable: true, requestId: 'req_7' },
      });
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.retryable).toBe(true);
    });

    it('creates PlanLimitError for PLAN_LIMIT_EXCEEDED with 402 status', () => {
      const err = PhototologyError.fromResponse(402, {
        error: { code: 'PLAN_LIMIT_EXCEEDED', message: 'Free limit reached', retryable: false, requestId: 'req_1' },
      });
      expect(err).toBeInstanceOf(PlanLimitError);
      expect(err.status).toBe(402);
      expect(err.name).toBe('PlanLimitError');
    });

    it('falls back to base PhototologyError for unknown codes', () => {
      const err = PhototologyError.fromResponse(418, {
        error: { code: 'TEAPOT', message: 'I am a teapot', retryable: false, requestId: 'req_8' },
      });
      expect(err).toBeInstanceOf(PhototologyError);
      expect(err).not.toBeInstanceOf(AuthenticationError);
      expect(err.code).toBe('TEAPOT');
    });
  });
});

describe('error message never contains API key', () => {
  it('PhototologyError strips pt_live_ keys from message', () => {
    const err = new PhototologyError('Key pt_live_abc123def is invalid', {
      code: 'AUTH_FAILED',
      status: 401,
      retryable: false,
      requestId: 'req_1',
    });
    expect(err.message).not.toContain('pt_live_');
    expect(err.message).toContain('[REDACTED]');
  });

  it('PhototologyError strips pt_test_ keys from message', () => {
    const err = new PhototologyError('Key pt_test_xyz789 is bad', {
      code: 'AUTH_FAILED',
      status: 401,
      retryable: false,
      requestId: 'req_2',
    });
    expect(err.message).not.toContain('pt_test_');
    expect(err.message).toContain('[REDACTED]');
  });
});
