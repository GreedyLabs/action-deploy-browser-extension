import crypto from 'node:crypto';
import { DeployError } from './types.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore';
const TOKEN_TTL_SECONDS = 3600;
interface ServiceAccountKey { client_email: string; private_key: string }

/** Base64url encoding (RFC 4648 §5), without padding. */
export function base64url(buf: Buffer): string { return buf.toString('base64url'); }

/** Exchange a service-account JWT for a token without logging credentials or response bodies. */
export async function createGoogleAccessToken(
  rawKey: string,
  now: number = Math.floor(Date.now() / 1000),
  timeoutMs = 30000,
): Promise<string> {
  let key: ServiceAccountKey;
  try {
    const parsed: unknown = JSON.parse(rawKey.trim());
    if (!parsed || typeof parsed !== 'object' || !('client_email' in parsed) || !('private_key' in parsed) ||
      typeof parsed.client_email !== 'string' || !parsed.client_email || typeof parsed.private_key !== 'string' || !parsed.private_key) throw new Error();
    key = { client_email: parsed.client_email, private_key: parsed.private_key };
  } catch { throw new DeployError('GOOGLE_KEY_INVALID', 'CHROME_SERVICE_ACCOUNT_KEY must be valid service-account JSON with client_email and private_key.'); }
  const header = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const payload = base64url(Buffer.from(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + TOKEN_TTL_SECONDS })));
  let signature: string;
  try { signature = base64url(crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key.private_key)); }
  catch { throw new DeployError('GOOGLE_KEY_INVALID', 'The Chrome service-account private key cannot sign an access-token request.'); }
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${payload}.${signature}` }),
    });
  } catch { throw new DeployError('GOOGLE_AUTH_REQUEST_FAILED', 'Google access-token request timed out or failed. No store write was sent.'); }
  if (!res.ok) throw new DeployError('GOOGLE_AUTH_FAILED', `Failed to obtain access token (HTTP ${res.status}). Check the service-account credentials and access permissions.`);
  let data: unknown;
  try { data = await res.json(); }
  catch { throw new DeployError('GOOGLE_AUTH_INVALID_RESPONSE', 'Google returned an invalid access-token response.'); }
  if (!data || typeof data !== 'object' || !('access_token' in data) || typeof data.access_token !== 'string' || !data.access_token.trim()) {
    throw new DeployError('GOOGLE_AUTH_INVALID_RESPONSE', 'Failed to obtain access token: Google returned no valid token.');
  }
  return data.access_token;
}
