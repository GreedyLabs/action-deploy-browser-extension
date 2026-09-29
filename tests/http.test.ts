import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../src/http.js';
const options = { requestTimeoutMs: 1000, pollTimeoutMs: 4, pollIntervalMs: 1, maxAttempts: 3 };
afterEach(() => vi.unstubAllGlobals());
describe('HTTP retries and uncertainty', () => {
  it('retries a rate limited GET respecting Retry-After', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '0' } })).mockResolvedValueOnce(new Response('{"ok":true}'));
    vi.stubGlobal('fetch', fetch);
    expect(await new HttpClient(options).json('https://store.example/status')).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not retry rejected credentials', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 401 })); vi.stubGlobal('fetch', fetch);
    await expect(new HttpClient(options).request('https://store.example/status')).rejects.toMatchObject({ code: 'HTTP_401' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([500, 502, 503])('never blindly repeats a POST after HTTP %s', async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response('', { status })); vi.stubGlobal('fetch', fetch);
    await expect(new HttpClient(options).request('https://store.example/upload', { method: 'POST' })).rejects.toMatchObject({ outcome: 'pending', uncertain: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('treats lost POST response as uncertain', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('lost connection')); vi.stubGlobal('fetch', fetch);
    await expect(new HttpClient(options).request('https://store.example/upload', { method: 'POST' })).rejects.toMatchObject({ outcome: 'pending', code: 'REQUEST_UNCERTAIN' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('treats invalid successful POST response as uncertain', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json')));
    await expect(new HttpClient(options).json('https://store.example/upload', { method: 'POST' })).rejects.toMatchObject({ outcome: 'pending', code: 'INVALID_RESPONSE' });
  });
  it('reports pending when polling runs out of time', async () => {
    await expect(new HttpClient(options).poll(async () => 'InProgress', () => false)).rejects.toMatchObject({ outcome: 'pending', code: 'POLL_TIMEOUT' });
  });
  it('lets semantic failures stop polling', async () => {
    const read = vi.fn().mockResolvedValue({ state: 'Failed' });
    await expect(new HttpClient(options).poll(read, () => { throw new Error('Store rejected ZIP'); })).rejects.toThrow('Store rejected ZIP');
    expect(read).toHaveBeenCalledTimes(1);
  });
});

it('bounds Retry-After waits by the overall poll deadline', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response('', { status: 429, headers: { 'Retry-After': '60' } }));
  vi.stubGlobal('fetch', fetch);
  const client = new HttpClient({ ...options, pollTimeoutMs: 20 });
  const start = Date.now();
  await expect(client.poll(() => client.json('https://store.example/status'), () => false)).rejects.toMatchObject({ code: 'POLL_TIMEOUT', outcome: 'pending' });
  expect(Date.now() - start).toBeLessThan(500);
  expect(fetch).toHaveBeenCalledTimes(1);
});
