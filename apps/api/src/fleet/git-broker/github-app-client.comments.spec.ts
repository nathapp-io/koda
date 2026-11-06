import { FleetHttpClient } from './fleet-http-client';
import { GitHubAppClient } from './github-app-client';
import { RepoCheckException } from './repo-check.exception';
import { FakeForge, startFakeForge } from '../../../test/helpers/fake-forge';

describe('GitHubAppClient.listIssueComments', () => {
  let forge: FakeForge;
  // The fleet default is 1 s here: a 5 s read can only pass because of the per-request override.
  let client: GitHubAppClient;

  beforeAll(async () => {
    forge = await startFakeForge();
    client = new GitHubAppClient({} as never, { githubApiUrl: forge.url } as never, new FleetHttpClient({ httpTimeoutMs: 1000 } as never), {} as never);
  });
  afterAll(() => forge.close());

  it('AC-9: reads one page of issue comments with the given token and returns each body', async () => {
    forge.routes.set('GET /repos/o/n/issues/7/comments', () => ({ status: 200, body: [
      { id: 1, body: 'Ready for review' },
      { id: 2, body: 'nax items\n<!-- nax-bot:v1 key=w-index -->' },
    ] }));
    await expect(client.listIssueComments('ghs_thread', 'o', 'n', 7)).resolves.toEqual(['Ready for review', 'nax items\n<!-- nax-bot:v1 key=w-index -->']);
    const sent = forge.requests.filter((request) => request.path === '/repos/o/n/issues/7/comments');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ method: 'GET', query: 'per_page=100' });
    expect(sent[0].headers.authorization).toBe('Bearer ghs_thread');
  });

  it('AC-10: maps a non-200 answer to a provider error', async () => {
    forge.routes.set('GET /repos/o/n/issues/8/comments', () => ({ status: 403, body: { message: 'provider-internal-detail' } }));
    await expect(client.listIssueComments('ghs_thread', 'o', 'n', 8)).rejects.toMatchObject({ reason: 'provider_error' });
  });

  it('AC-11: aborts the read after five seconds, not at the client default', async () => {
    forge.routes.set('GET /repos/o/n/issues/9/comments', () => ({ status: 200, body: [], delayMs: 6500 }));
    const started = Date.now();
    await expect(client.listIssueComments('ghs_thread', 'o', 'n', 9)).rejects.toBeInstanceOf(RepoCheckException);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(4000);
    expect(elapsed).toBeLessThan(6000);
  }, 20000);
});
