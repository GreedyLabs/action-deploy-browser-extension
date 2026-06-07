import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { base64url, createGoogleAccessToken } from '../src/google-auth.js';

function decodeSegment(seg: string): Record<string, unknown> {
  const b64 = seg.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as Record<string, unknown>;
}

describe('base64url', () => {
  it('uses url-safe alphabet and strips padding', () => {
    // 0xff 0xff 0xfe -> base64 "//7+"-ish; ensure no +, /, or = remain.
    const out = base64url(Buffer.from([0xff, 0xff, 0xfe]));
    expect(out).not.toMatch(/[+/=]/);
  });

  it('round-trips back to the original bytes', () => {
    const bytes = Buffer.from('hello world?>', 'utf8');
    const decoded = Buffer.from(base64url(bytes).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(decoded.equals(bytes)).toBe(true);
  });
});

describe('createGoogleAccessToken', () => {
  afterEach(() => vi.restoreAllMocks());

  it('signs a valid RS256 JWT and exchanges it for a token', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const key = { client_email: 'svc@example.iam.gserviceaccount.com', private_key: privateKey };

    let capturedAssertion = '';
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      capturedAssertion = (init.body as URLSearchParams).get('assertion') ?? '';
      return new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const token = await createGoogleAccessToken(JSON.stringify(key), 1_000_000);
    expect(token).toBe('tok-123');

    const [header, payload, signature] = capturedAssertion.split('.');
    expect(decodeSegment(header!)).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(decodeSegment(payload!)).toMatchObject({
      iss: key.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_000_000,
      exp: 1_000_000 + 3600,
    });

    // The signature must verify against the public key.
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    const sigBuf = Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    expect(verifier.verify(publicKey, sigBuf)).toBe(true);
  });

  it('throws when the token endpoint returns no access_token', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 })));

    await expect(
      createGoogleAccessToken(JSON.stringify({ client_email: 'a@b.com', private_key: privateKey })),
    ).rejects.toThrow(/Failed to obtain access token/);
  });
});
