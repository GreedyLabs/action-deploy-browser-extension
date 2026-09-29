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
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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

describe('Google token request failure handling', () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const key = JSON.stringify({ client_email: 'test@example.invalid', private_key: privateKey });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('never includes malformed credential text in errors', async () => {
    await expect(createGoogleAccessToken('SECRET_PRIVATE_KEY')).rejects.toThrow('valid service-account JSON');
    await expect(createGoogleAccessToken('{"client_email":"x","private_key":"SECRET_PRIVATE_KEY"}')).rejects.toThrow('cannot sign');
  });

  it('rejects non-success HTTP responses even when they contain an access_token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ access_token: 'SECRET', detail: key }), { status: 403 })));
    await expect(createGoogleAccessToken(key)).rejects.toThrow('HTTP 403');
  });

  it.each([{}, { access_token: 123 }, { access_token: '' }, { access_token: '  ' }])('rejects malformed successful response %j', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body))));
    await expect(createGoogleAccessToken(key)).rejects.toThrow('no valid token');
  });

  it('rejects invalid JSON without leaking the server response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('SECRET_SERVER_BODY')));
    await expect(createGoogleAccessToken(key)).rejects.toThrow('invalid access-token response');
  });

  it('bounds authentication and reports network failure without its potentially sensitive details', async () => {
    const mock = vi.fn(async () => { throw new Error(`SECRET:${key}`); });
    vi.stubGlobal('fetch', mock);
    await expect(createGoogleAccessToken(key, undefined, 500)).rejects.toThrow('timed out or failed');
    expect(mock).toHaveBeenCalledOnce();
    expect(mock).toHaveBeenCalledWith('https://oauth2.googleapis.com/token', expect.objectContaining({ signal: expect.any(AbortSignal), redirect: 'error' }));
  });
});
