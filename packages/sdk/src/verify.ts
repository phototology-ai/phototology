import type { Receipt, ReceiptJwk } from './types';

/**
 * Offline receipt signature check. No network, no dependencies: WebCrypto
 * (`crypto.subtle`, global in Node 20+, browsers, and edge runtimes).
 *
 * Only the signature is checked here. The RFC 3161 timestamp token needs
 * the timestamp authority's certificate chain, so `timestamp` is always
 * `'unverified'`; check it with `openssl ts -verify` (see the README) or
 * server-side with `client.verifyReceipt`.
 */
export interface ReceiptSignatureCheck {
  signature: 'valid' | 'invalid' | 'unknown_key';
  timestamp: 'unverified';
  livemode: boolean;
  keyId: string;
}

const SANDBOX_KEY_ID = 'sandbox';

/**
 * Canonical JSON: RFC 8785 (JCS) for the value types receipts contain
 * (strings, finite numbers, booleans, null, arrays, objects). Object keys
 * sort by UTF-16 code unit at every depth; strings and numbers use
 * ECMAScript serialization, which is what RFC 8785 specifies. Object
 * members whose value is `undefined` are dropped, as in `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  const out = serialize(value);
  if (out === undefined) throw new TypeError('canonicalJson: value has no JSON representation');
  return out;
}

function serialize(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return serialize((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) return `[${value.map((v) => serialize(v) ?? 'null').join(',')}]`;
  const obj = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(obj).sort()) {
    const v = serialize(obj[key]);
    if (v !== undefined) members.push(`${JSON.stringify(key)}:${v}`);
  }
  return `{${members.join(',')}}`;
}

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(input) || input.length % 4 === 1) return null;
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Checks a receipt's detached JWS (ES256) against a JWKS, the same rules
 * the API's `POST /v1/verify` applies:
 *
 * - `unknown_key` when the signature's `kid` is not in the JWKS.
 * - `invalid` for a malformed key set (not `{ keys: [...] }`, or an entry
 *   that is null or has no string `kid`).
 * - `invalid` for a malformed signature, a payload `keyId` that differs
 *   from the `kid`, a key that is not EC P-256, or a failed check.
 * - `invalid` when the matched key is a sandbox key (`kid` `sandbox`, or
 *   the JWK carries `"phototology.sandbox": true`) and the payload's
 *   `livemode` is not `false`. The sandbox private key is public, so it
 *   proves nothing about a live receipt.
 *
 * Fetch the JWKS with `client.getJwks()` (or from
 * `https://api.phototology.com/.well-known/phototology-keys.json`) and
 * cache it; keys are only ever added, so old receipts keep verifying.
 */
export async function verifyReceiptSignature(
  receipt: Receipt,
  jwks: { keys: ReceiptJwk[] },
): Promise<ReceiptSignatureCheck> {
  const payload = receipt?.payload;
  const result = (signature: ReceiptSignatureCheck['signature']): ReceiptSignatureCheck => ({
    signature,
    timestamp: 'unverified',
    livemode: payload?.livemode === true,
    keyId: typeof payload?.keyId === 'string' ? payload.keyId : '',
  });

  const parts = typeof receipt?.signature === 'string' ? receipt.signature.split('.') : [];
  if (parts.length !== 3 || parts[1] !== '' || !parts[0] || !parts[2]) return result('invalid');
  const [headerB64, , sigB64] = parts;

  let header: { alg?: unknown; kid?: unknown };
  try {
    const headerBytes = base64UrlDecode(headerB64);
    if (!headerBytes) return result('invalid');
    header = JSON.parse(new TextDecoder().decode(headerBytes));
  } catch {
    return result('invalid');
  }
  if (header === null || typeof header !== 'object' || header.alg !== 'ES256' || typeof header.kid !== 'string') {
    return result('invalid');
  }

  // A malformed key set (from an untyped cache or a bad fetch) is a failed
  // check, never an exception.
  const keys: unknown = (jwks as { keys?: unknown } | null | undefined)?.keys;
  if (!Array.isArray(keys) || !keys.every((k) => typeof (k as ReceiptJwk | null)?.kid === 'string')) {
    return result('invalid');
  }
  const jwk = (keys as ReceiptJwk[]).find((k) => k.kid === header.kid);
  if (!jwk) return result('unknown_key');
  if (payload?.keyId !== header.kid) return result('invalid');
  const isSandboxKey = jwk.kid === SANDBOX_KEY_ID || jwk['phototology.sandbox'] === true;
  if (isSandboxKey && payload.livemode !== false) return result('invalid');
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return result('invalid');

  const sig = base64UrlDecode(sigB64);
  if (!sig || sig.length !== 64) return result('invalid');

  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const body = base64UrlEncode(new TextEncoder().encode(canonicalJson(payload)));
    const signingInput = new TextEncoder().encode(`${headerB64}.${body}`);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, signingInput);
    return result(ok ? 'valid' : 'invalid');
  } catch {
    return result('invalid');
  }
}
