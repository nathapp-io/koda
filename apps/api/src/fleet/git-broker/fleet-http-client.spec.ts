import { FleetHttpClient } from './fleet-http-client';
import { RepoCheckException } from './repo-check.exception';
import { FakeForge, startFakeForge } from '../../../test/helpers/fake-forge';

describe('FleetHttpClient', () => {
  let forge: FakeForge;
  const client = new FleetHttpClient({ httpTimeoutMs: 1000 } as never);

  beforeAll(async () => {
    forge = await startFakeForge();
  });
  afterAll(() => forge.close());

  it('returns status and parsed body', async () => {
    forge.routes.set('GET /ok', () => ({ status: 200, body: { a: 1 } }));
    await expect(client.request('GET', `${forge.url}/ok`, {})).resolves.toEqual({ status: 200, body: { a: 1 } });
  });

  it('returns non-2xx without throwing', async () => {
    await expect(client.request('GET', `${forge.url}/missing`, {})).resolves.toEqual(expect.objectContaining({ status: 404 }));
  });

  it('refuses to follow a redirect (the token must not travel)', async () => {
    forge.routes.set('GET /moved', () => ({ status: 302, headers: { location: `${forge.url}/ok` } }));
    await expect(client.request('GET', `${forge.url}/moved`, { Authorization: 'Bearer t' })).rejects.toMatchObject({ reason: 'provider_unreachable' });
    expect(forge.requests.filter((r) => r.path === '/ok' && r.headers.authorization)).toHaveLength(0);
  });

  it('gives up at the configured timeout', async () => {
    forge.routes.set('GET /slow', () => ({ status: 200, body: {}, delayMs: 3000 }));
    const started = Date.now();
    await expect(client.request('GET', `${forge.url}/slow`, {})).rejects.toBeInstanceOf(RepoCheckException);
    expect(Date.now() - started).toBeLessThan(2500);
  });
});
