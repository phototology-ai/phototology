import { CreditExhaustedError } from '@phototology/sdk';
import { renderToolError } from '../src/tools/errors';

describe('renderToolError', () => {
  describe('CreditExhaustedError', () => {
    it('C1: leads with OUT_OF_CREDITS, states NOT retryable + STOP, mirrors machine fields in structuredContent', () => {
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
      const text = result.content[0].text;
      // Spec §7: the stop-signal phrases a model must read.
      expect(text).toContain('OUT_OF_CREDITS');
      expect(text).toContain('NOT retryable');
      expect(text).toContain('STOP');
      expect(text).toContain('Agents cannot purchase');
      expect(text).toContain('5 credits'); // creditsRequired
      expect(text).toContain('12 days'); // resetsInDays
      expect(text).toContain('https://phototology.com/wallet'); // purchaseUrl inline

      // Machine-legible mirror.
      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent!.code).toBe('OUT_OF_CREDITS');
      expect(result.structuredContent!.retryable).toBe(false);
      expect(result.structuredContent!.actionUrl).toBe('https://phototology.com/wallet');
      expect(result.structuredContent!.creditsRequired).toBe(5);
      expect(result.structuredContent!.balance).toBe(0); // === totalBalance
      expect(result.structuredContent!.actions).toHaveLength(1);
      expect(result.structuredContent!.actions[0]).toMatchObject({
        type: 'open_url',
        label: expect.stringMatching(/buy credits/i),
        url: expect.stringContaining('phototology.com/wallet'),
      });
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
      expect(result.structuredContent!.balance).toBe(1);
      expect(result.structuredContent!.actions[0].type).toBe('open_url');
    });
  });

  describe('generic Error', () => {
    it('renders Error: <message> with no structuredContent', () => {
      const result = renderToolError(new Error('boom'));
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error: boom');
      expect(result.structuredContent).toBeUndefined();
    });

    it('stringifies non-Error throwables', () => {
      const result = renderToolError('plain string');
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('Error: plain string');
    });
  });
});
