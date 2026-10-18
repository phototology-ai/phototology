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
