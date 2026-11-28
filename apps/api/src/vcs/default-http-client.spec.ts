import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultHttpClient, createVcsProvider } from './factory';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDefaultHttpClient', () => {
  it('AC-1: GET uses manual redirects and an AbortSignal', async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchStub);

    const result = await createDefaultHttpClient().get('https://api.example.test/x', { headers: {} });

    expect(result.data).toEqual({ ok: true });
    expect(fetchStub).toHaveBeenCalledOnce();
    const options = fetchStub.mock.calls[0][1];
    expect(options?.redirect).toBe('manual');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('AC-2: POST uses manual redirects and an AbortSignal', async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchStub);

    const result = await createDefaultHttpClient().post('https://api.example.test/x', { headers: {}, body: {} });

    expect(result.data).toEqual({ ok: true });
    expect(fetchStub).toHaveBeenCalledOnce();
    const options = fetchStub.mock.calls[0][1];
    expect(options?.redirect).toBe('manual');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('AC-3: GET rejects a redirect with its HTTP status', async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 302 }));
    vi.stubGlobal('fetch', fetchStub);

    await expect(createDefaultHttpClient().get('https://api.example.test/x', { headers: {} }))
      .rejects.toMatchObject({ response: { status: 302 } });
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('AC-4: GET rejects when its configured timeout aborts fetch', async () => {
    const fetchStub = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchStub);

    const startedAt = Date.now();
    await expect(createDefaultHttpClient({ timeoutMs: 50 }).get('https://api.example.test/x', { headers: {} }))
      .rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(fetchStub.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('AC-5: POST rejects when its configured timeout aborts fetch', async () => {
    const fetchStub = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchStub);

    const startedAt = Date.now();
    await expect(createDefaultHttpClient({ timeoutMs: 50 }).post('https://api.example.test/x', { headers: {}, body: {} }))
      .rejects.toBeDefined();
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(fetchStub.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('AC-6: createVcsProvider uses the protected default HTTP client', async () => {
    const fetchStub = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ default_branch: 'main' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchStub);
    const provider = createVcsProvider('github', {
      provider: 'github',
      token: 't',
      repoUrl: 'https://github.com/acme/widgets',
    });

    await expect(provider.getDefaultBranch()).resolves.toBe('main');
    expect(fetchStub).toHaveBeenCalledOnce();
    expect(fetchStub.mock.calls[0][1]?.redirect).toBe('manual');
  });
});
