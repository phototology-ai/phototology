import { CreditExhaustedError } from '@phototology/sdk';
import { renderToolError } from '../src/tools/errors';

describe('renderToolError', () => {
  describe('CreditExhaustedError', () => {
    it('returns isError:true with text + structured open_url action', () => {
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
      expect(result.content[0].text).toContain('Out of credits');
      expect(result.content[0].text).toContain('5 credits');
      expect(result.content[0].text).toContain('12 days');
      expect(result.content[0].text).toContain('https://phototology.com/wallet');

      expect(result.structuredContent).toBeDefined();
      expect(result.structuredContent!.actions).toHaveLength(1);
      expect(result.structuredContent!.actions[0]).toMatchObject({
        type: 'open_url',
        label: expect.stringMatching(/buy credits/i),
        url: expect.stringContaining('phototology.com/wallet'),
      });
    });

    it('omits the reset sentence in text when resetsInDays is missing', () => {
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

      expect(result.content[0].text).toContain('Out of credits');
      expect(result.content[0].text).not.toContain('reset in');
      // Structured action still present
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
