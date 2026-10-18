import { canonicalJson, verifyReceiptSignature } from '../src/verify';
import type { Receipt, ReceiptJwk } from '../src/types';
import fixtures from './fixtures/receipts.json';
import sandboxPublicJwk from './fixtures/sandbox-key.public.jwk.json';

type Entry = { name: string; canonical: string; receipt: Receipt };
const receipts = fixtures.receipts as unknown as Entry[];
const forged = fixtures.forged as unknown as Entry[];
const byName = (list: Entry[], name: string): Receipt => {
  const found = list.find((e) => e.name === name);
  if (!found) throw new Error(`fixture ${name} missing`);
  return JSON.parse(JSON.stringify(found.receipt)) as Receipt;
};

// The JWKS as the API serves it: the sandbox key with the marker, then live keys.
const { _comment, ...sandboxKey } = sandboxPublicJwk as Record<string, unknown>;
void _comment;
const jwks = { keys: [{ ...sandboxKey, 'phototology.sandbox': true }, fixtures.livePublicJwk] as ReceiptJwk[] };

describe('canonicalJson', () => {
  it.each(receipts.map((e) => [e.name, e] as const))('matches the API canonicalJson for the %s fixture', (_name, e) => {
    expect(canonicalJson(e.receipt.payload)).toBe(e.canonical);
  });

  it('sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it('throws on a value with no JSON form', () => {
    expect(() => canonicalJson(undefined)).toThrow(TypeError);
  });
});

describe('verifyReceiptSignature', () => {
  it('returns valid for a sandbox-signed sandbox receipt', async () => {
    const r = byName(receipts, 'sandbox-minimal');
    await expect(verifyReceiptSignature(r, jwks)).resolves.toEqual({
      signature: 'valid',
      timestamp: 'unverified',
      livemode: false,
      keyId: 'sandbox',
    });
  });

  it('returns valid for the full sandbox fixture (optional subject fields, unicode, nested credentials)', async () => {
    const r = await verifyReceiptSignature(byName(receipts, 'sandbox-full'), jwks);
    expect(r.signature).toBe('valid');
  });

  it('returns valid for a live receipt signed by a live key', async () => {
    await expect(verifyReceiptSignature(byName(receipts, 'live'), jwks)).resolves.toEqual({
      signature: 'valid',
      timestamp: 'unverified',
      livemode: true,
      keyId: 'receipt-test',
    });
  });

  it('accepts the committed sandbox JWK file as-is (no marker, kid sandbox)', async () => {
    const r = await verifyReceiptSignature(byName(receipts, 'sandbox-minimal'), { keys: [sandboxKey as ReceiptJwk] });
    expect(r.signature).toBe('valid');
  });

  it('returns invalid when one character of the payload changes', async () => {
    const r = byName(receipts, 'sandbox-minimal');
    r.payload.subject.bytesSha256 = 'b' + r.payload.subject.bytesSha256.slice(1);
    expect((await verifyReceiptSignature(r, jwks)).signature).toBe('invalid');
  });

  it('returns invalid when one character of the signature changes', async () => {
    const r = byName(receipts, 'live');
    const last = r.signature.length - 2;
    r.signature = r.signature.slice(0, last) + (r.signature[last] === 'A' ? 'B' : 'A') + r.signature.slice(last + 1);
    expect((await verifyReceiptSignature(r, jwks)).signature).toBe('invalid');
  });

  it('returns unknown_key when the kid is not in the JWKS', async () => {
    const r = byName(receipts, 'live');
    const result = await verifyReceiptSignature(r, { keys: [{ ...sandboxKey, 'phototology.sandbox': true } as ReceiptJwk] });
    expect(result).toEqual({ signature: 'unknown_key', timestamp: 'unverified', livemode: true, keyId: 'receipt-test' });
  });

  it('returns invalid when the payload keyId differs from the signature kid', async () => {
    const r = byName(receipts, 'live');
    r.payload.keyId = 'sandbox';
    expect((await verifyReceiptSignature(r, jwks)).signature).toBe('invalid');
  });

  it.each([
    ['empty', ''],
    ['not three parts', 'abc.def'],
    ['attached payload', 'eyJhbGciOiJFUzI1NiIsImtpZCI6InNhbmRib3gifQ.e30.AAAA'],
    ['header not JSON', 'bm90LWpzb24..AAAA'],
    ['wrong alg', `${Buffer.from('{"alg":"HS256","kid":"sandbox"}').toString('base64url')}..AAAA`],
  ])('returns invalid for a malformed signature (%s)', async (_label, signature) => {
    const r = byName(receipts, 'sandbox-minimal');
    r.signature = signature;
    expect((await verifyReceiptSignature(r, jwks)).signature).toBe('invalid');
  });

  it.each([
    ['jwks null', null],
    ['keys missing', {}],
    ['keys not an array', { keys: 'nope' }],
    ['a null entry', { keys: [null] }],
    ['an entry without kid', { keys: [{ kty: 'EC' }] }],
  ])('returns invalid, never throws, for a malformed key set (%s)', async (_label, bad) => {
    const r = byName(receipts, 'sandbox-minimal');
    const result = await verifyReceiptSignature(r, bad as unknown as { keys: ReceiptJwk[] });
    expect(result.signature).toBe('invalid');
  });

  describe('sandbox keys never vouch for a live receipt', () => {
    it('returns invalid for a live payload signed with the sandbox key (kid sandbox)', async () => {
      // The signature bytes are mathematically correct; the rule alone rejects it.
      const r = byName(forged, 'live-payload-sandbox-kid');
      await expect(verifyReceiptSignature(r, jwks)).resolves.toEqual({
        signature: 'invalid',
        timestamp: 'unverified',
        livemode: true,
        keyId: 'sandbox',
      });
    });

    it('returns invalid for a live payload when the key carries only the phototology.sandbox marker', async () => {
      const markerOnly = { keys: [{ ...sandboxKey, kid: 'sandbox-alt', 'phototology.sandbox': true } as ReceiptJwk] };
      const r = byName(forged, 'live-payload-marker-only-kid');
      expect((await verifyReceiptSignature(r, markerOnly)).signature).toBe('invalid');
    });

    it('returns valid for a sandbox payload under a marker-only key', async () => {
      const markerOnly = { keys: [{ ...sandboxKey, kid: 'sandbox-alt', 'phototology.sandbox': true } as ReceiptJwk] };
      const r = byName(forged, 'sandbox-payload-marker-only-kid');
      expect((await verifyReceiptSignature(r, markerOnly)).signature).toBe('valid');
    });

    it('the forged live receipt would verify without the rule (proves the rule is what rejects it)', async () => {
      const unmarked = { keys: [{ ...sandboxKey, kid: 'sandbox-alt' } as ReceiptJwk] };
      const r = byName(forged, 'live-payload-marker-only-kid');
      expect((await verifyReceiptSignature(r, unmarked)).signature).toBe('valid');
    });
  });
});
