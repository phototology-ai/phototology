import { CreditExhaustedError, RateLimitedError } from '@phototology/sdk';
import { renderToolError } from '../src/tools/errors';
import { LocalImageError } from '../src/lib/local-image';
import { setKeyContext, setStartupProblem } from '../src/lib/key-status';

describe('renderToolError', () => {
  describe('CreditExhaustedError', () => {
    it('C1: a JSON first line with the machine fields, then OUT_OF_CREDITS, NOT retryable + STOP; no structuredContent', () => {
      const err = new CreditExhaustedError('Out of credits', {
        code: 'PLAN_LIMIT_EXCEEDED',
        status: 402,
        retryable: false,
        requestId: 'req_1',
        creditsRequired: 5,
        communityBalance: 0,
        purchasedBalance: 0,
        totalBalance: 0,
        resetsInDays: 12,
      });

      const result = renderToolError(err);

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].type).toBe('text');
      const [head, text] = result.content[0].text.split('\n');
      // Spec §7: the stop-signal phrases a model must read, on the line after the
      // machine fields. The server instructions describe both lines
      // (tests/server-instructions.test.ts).
      expect(text.startsWith('OUT_OF_CREDITS:')).toBe(true);
      expect(text).toContain('NOT retryable');
      expect(text).toContain('STOP');
      expect(text).toContain('Agents cannot purchase');
      expect(text).toContain('5 credits'); // creditsRequired
      expect(text).toContain('12 days'); // resetsInDays
      expect(text).toContain('https://phototology.com/wallet'); // purchaseUrl inline

      // Machine-legible first line. No structuredContent: the official client
      // validates it against the outputSchema even on isError (tests/error-roundtrip.test.ts).
      expect(JSON.parse(head)).toEqual({
        code: 'OUT_OF_CREDITS',
        retryable: false,
        actionUrl: 'https://phototology.com/wallet',
        creditsRequired: 5,
        balance: 0, // === totalBalance
      });
      expect((result as any).structuredContent).toBeUndefined();
    });

    it('omits the community auto-refill sentence when resetsInDays is missing; balance reflects totalBalance', () => {
      const err = new CreditExhaustedError('Out of credits', {
        code: 'PLAN_LIMIT_EXCEEDED',
        status: 402,
        retryable: false,
        requestId: 'req_2',
        creditsRequired: 3,
        communityBalance: 0,
        purchasedBalance: 1,
        totalBalance: 1,
      });

      const result = renderToolError(err);

      const text = result.content[0].text;
      expect(text).toContain('OUT_OF_CREDITS');
      expect(text).toContain('3 credits');
      expect(text).not.toContain('auto-refill');
      expect(text).toContain('STOP');
      expect(JSON.parse(text.split('\n')[0]).balance).toBe(1);
    });
  });

  describe('generic Error', () => {
    it('renders Error: <message> with no structuredContent', () => {
      const result = renderToolError(new Error('boom'));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error: boom');
      expect((result as any).structuredContent).toBeUndefined();
    });

    it('stringifies non-Error throwables', () => {
      const result = renderToolError('plain string');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error: plain string');
    });
  });

  describe('RateLimitedError', () => {
    const opts = { code: 'RATE_LIMITED', status: 429, retryable: true, requestId: 'req_rl' };

    it('a wait past 600 s is not retryable, and the sentence says when the limit resets', () => {
      const [head, text] = renderToolError(new RateLimitedError('Too many requests.', opts, 900)).content[0].text.split('\n');
      expect(JSON.parse(head)).toEqual({ code: 'RATE_LIMITED', retryable: false, retryAfterSeconds: 900 });
      expect(text).toContain('The limit resets in 15 minutes.');
      expect(text).toContain('No retry in this session will help');
    });

    it('does not repeat the reset when the SDK message already states it', () => {
      const text = renderToolError(new RateLimitedError('Limit hit. The limit resets in 24 hours (at x).', opts, 86_400)).content[0].text;
      expect(text.match(/resets in/g)).toHaveLength(1);
    });

    it('a wait of 600 s or less is retryable', () => {
      const head = renderToolError(new RateLimitedError('Too many requests.', opts, 600)).content[0].text.split('\n')[0];
      expect(JSON.parse(head)).toEqual({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 600 });
    });

    it('passes the API\'s upgrade hint on: actionUrl and limitScope in the head, the hint in the sentence', () => {
      setKeyContext('pt_live_x');
      const err = new RateLimitedError('Rate limit exceeded. 600 requests per minute allowed.', opts, 45, {
        rateLimit: { scope: 'account_per_minute', limit: 600, windowSeconds: 60, resetAt: '2026-11-16T15:00:45.000Z' },
        upgrade: { hint: 'Every account key has this same limit, and buying credits does not raise it.', url: 'https://phototology.com/pricing' },
      });
      const [head, text] = renderToolError(err).content[0].text.split('\n');
      expect(JSON.parse(head)).toEqual({
        code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 45,
        limitScope: 'account_per_minute', actionUrl: 'https://phototology.com/pricing',
      });
      expect(text).toContain('Retry after 45 seconds');
      expect(text).toContain('Retry after 45 seconds');
      // A retryable wait: retry first, the link only if the limit keeps blocking.
      expect(text).not.toContain('To lift this limit');
      expect(text).toContain('Only if the limit keeps blocking the work after waiting and retrying, tell the user how to lift it: Every account key has this same limit, and buying credits does not raise it. https://phototology.com/pricing');
      expect(text.indexOf('Retry after')).toBeLessThan(text.indexOf('https://phototology.com/pricing'));
    });

    it('a wait past the retry cap says to stop and gives the link as what lifts the limit', () => {
      setKeyContext('pt_live_x');
      const err = new RateLimitedError('Rate limit exceeded.', opts, 3_600, {
        rateLimit: { scope: 'sandbox_per_day', limit: 10, windowSeconds: 86_400, resetAt: null },
        upgrade: { hint: 'Sign up for a free account.', url: 'https://phototology.com/signup' },
      });
      const [head, text] = renderToolError(err).content[0].text.split('\n');
      expect(JSON.parse(head)).toMatchObject({ retryable: false, actionUrl: 'https://phototology.com/signup' });
      expect(text).toContain('No retry in this session will help');
      expect(text).toContain('To lift this limit: Sign up for a free account. https://phototology.com/signup');
    });

    it('a concurrency 429 tells the agent to send fewer or use analyze_batch before any link', () => {
      setKeyContext('pt_live_x');
      const err = new RateLimitedError('Too many concurrent requests.', { ...opts, code: 'CONCURRENCY_LIMIT_EXCEEDED' }, 5, {
        rateLimit: { scope: 'analyze_concurrency', limit: 5, windowSeconds: null, resetAt: null },
        upgrade: { hint: 'Keep at most 5 /analyze requests in flight per account and queue the rest.', url: 'https://phototology.com/pricing' },
      });
      const [head, text] = renderToolError(err).content[0].text.split('\n');
      expect(JSON.parse(head)).toMatchObject({ code: 'CONCURRENCY_LIMIT_EXCEEDED', retryable: true, retryAfterSeconds: 5 });
      expect(text).toContain('use analyze_batch');
      expect(text).not.toContain('To lift this limit');
      expect(text.indexOf('analyze_batch')).toBeLessThan(text.indexOf('https://phototology.com/pricing'));
    });

    it('a sandbox key with the API\'s signup hint does not repeat the local sandbox sentence', () => {
      setKeyContext('pt_test_x');
      const err = new RateLimitedError('Anonymous test key rate limit exceeded.', opts, 30, {
        rateLimit: { scope: 'sandbox_per_minute', limit: 2, windowSeconds: 60, resetAt: null },
        upgrade: { hint: 'Sandbox keys allow 2 requests a minute and 10 a day per IP.', url: 'https://phototology.com/signup' },
      });
      const text = renderToolError(err).content[0].text;
      expect(text.match(/2 requests a minute/g)).toHaveLength(1);
      expect(text).toContain('https://phototology.com/signup');
      setKeyContext('pt_live_reset');
    });

    it('a sandbox key without an API hint (older API) keeps the sandbox sentence', () => {
      setKeyContext('pt_test_x');
      const text = renderToolError(new RateLimitedError('Too many requests.', opts, 30)).content[0].text;
      expect(text).toContain('sign up for an account key');
      setKeyContext('pt_live_reset');
    });

    it('CONCURRENCY_LIMIT_EXCEEDED keeps its code and says to send at most 5 or use analyze_batch', () => {
      setKeyContext('pt_live_x');
      const err = new RateLimitedError(
        'Too many concurrent /analyze requests. 5 allowed per user.',
        { code: 'CONCURRENCY_LIMIT_EXCEEDED', status: 429, retryable: true, requestId: 'req_c' },
        5,
        { rateLimit: { scope: 'analyze_concurrency', limit: 5, windowSeconds: null, resetAt: null } },
      );
      const [head, text] = renderToolError(err).content[0].text.split('\n');
      expect(JSON.parse(head)).toEqual({
        code: 'CONCURRENCY_LIMIT_EXCEEDED', retryable: true, retryAfterSeconds: 5, limitScope: 'analyze_concurrency',
      });
      expect(text.startsWith('CONCURRENCY_LIMIT_EXCEEDED:')).toBe(true);
      expect(text).toContain('Retry after 5 seconds');
      expect(text).toContain('use analyze_batch, which queues photos 5 at a time');
    });
  });

  describe('start-up note', () => {
    afterEach(() => setKeyContext('pt_live_reset'));

    it('is never appended to a local-file error, which has the one-line JSON head and its sentence', () => {
      setKeyContext('pt_live_x');
      setStartupProblem('the API rejected it (Invalid or revoked API key).');
      const result = renderToolError(new LocalImageError('FILE_NOT_FOUND', 'No file at /tmp/x.jpg', { path: '/tmp/x.jpg' }));
      const [first, ...rest] = result.content[0].text.split('\n');
      expect(JSON.parse(first)).toEqual({ code: 'FILE_NOT_FOUND', retryable: false, path: '/tmp/x.jpg' });
      expect(rest.join('\n')).toBe('No file at /tmp/x.jpg');
    });

    it('is appended to other errors', () => {
      setKeyContext('pt_live_x');
      setStartupProblem('the API rejected it (Invalid or revoked API key).');
      expect(renderToolError(new Error('boom')).content[0].text).toMatch(/start-up/);
    });
  });
});
