import { GitHubProvider } from './github.provider';
import type { HttpClient } from '../factory';

const API = 'https://api.github.com';

function issue(number: number, updatedAt: string, isPr = false) {
  return {
    number,
    title: `#${number}`,
    body: null,
    user: { login: 'dev' },
    html_url: `https://github.com/o/r/issues/${number}`,
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: updatedAt,
    ...(isPr ? { pull_request: {} } : {}),
  };
}

function page(items: unknown[], next?: string) {
  return { data: items, headers: next ? { link: `<${next}>; rel="next"` } : {} };
}

describe('GitHubProvider.fetchIssues pagination (M10)', () => {
  let get: jest.Mock;
  let provider: GitHubProvider;

  beforeEach(() => {
    get = jest.fn();
    provider = new GitHubProvider('o', 'r', 'tok', { get, post: jest.fn() } as unknown as HttpClient, API);
  });

  it('asks for 100 per page in update order, since the cursor', async () => {
    get.mockResolvedValueOnce(page([]));

    await provider.fetchIssues(new Date('2026-09-01T00:00:00Z'));

    expect(get).toHaveBeenCalledWith(`${API}/repos/o/r/issues`, {
      headers: { Authorization: 'Bearer tok' },
      params: { state: 'open', sort: 'updated', direction: 'asc', per_page: 100, since: '2026-08-31T23:59:59.000Z' },
    });
  });

  it('follows next links, drops PRs, and takes the cursor from every item', async () => {
    get
      .mockResolvedValueOnce(page([issue(1, '2026-09-01T00:00:00Z'), issue(2, '2026-09-02T00:00:00Z', true)], `${API}/repos/o/r/issues?page=2`))
      .mockResolvedValueOnce(page([issue(3, '2026-09-03T00:00:00Z', true)]));

    const result = await provider.fetchIssues();

    expect(get).toHaveBeenNthCalledWith(2, `${API}/repos/o/r/issues?page=2`, { headers: { Authorization: 'Bearer tok' }, params: undefined });
    expect(result.issues.map((i) => i.number)).toEqual([1]);
    expect(result.cursor).toEqual(new Date('2026-09-03T00:00:00Z'));
    expect(result.capped).toBe(false);
  });

  it('stops after 10 pages and reports the fetch as capped', async () => {
    get.mockImplementation(async (url: string) => {
      const n = Number(new URL(url).searchParams.get('page') ?? '1');
      return page([issue(n, `2026-09-${String(n).padStart(2, '0')}T00:00:00Z`)], `${API}/repos/o/r/issues?page=${n + 1}`);
    });

    const result = await provider.fetchIssues();

    expect(get).toHaveBeenCalledTimes(10);
    expect(result.capped).toBe(true);
    expect(result.cursor).toEqual(new Date('2026-09-10T00:00:00Z'));
  });

  it('never sends the token to another origin', async () => {
    get.mockResolvedValueOnce(page([issue(1, '2026-09-01T00:00:00Z')], 'https://evil.example/steal'));

    const result = await provider.fetchIssues();

    expect(get).toHaveBeenCalledTimes(1);
    expect(result.capped).toBe(true);
    expect(result.issues).toHaveLength(1);
  });

  it('reports a null cursor when nothing came back', async () => {
    get.mockResolvedValueOnce(page([]));
    await expect(provider.fetchIssues()).resolves.toEqual({ issues: [], cursor: null, capped: false });
  });
});
