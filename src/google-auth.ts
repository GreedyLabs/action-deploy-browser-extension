import crypto from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const TOKEN_TTL_SECONDS = 3600;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

interface TokenResponse {
  access_token?: string;
}

/** Base64url encoding (RFC 4648 §5) — base64 with `+/` swapped and padding stripped. */
export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * Mints a short-lived Google OAuth2 access token for the Chrome Web Store API
 * by signing a JWT with the service account's private key (RS256) and
 * exchanging it via the JWT-bearer grant.
 *
 * @param rawKey JSON string of the service account key (the contents of
 *   `CHROME_SERVICE_ACCOUNT_KEY`).
 * @param now Current Unix time in seconds. Injectable for testing.
 */
export async function createGoogleAccessToken(
  rawKey: string,
  now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = JSON.parse(rawKey.trim()) as ServiceAccountKey;

  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({
    iss: key.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
  })));

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = base64url(sign.sign(key.private_key));

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${payload}.${signature}`,
    }),
  });

  const data = await res.json() as TokenResponse;
  if (!data.access_token) {
    throw new Error(`Failed to obtain access token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}
