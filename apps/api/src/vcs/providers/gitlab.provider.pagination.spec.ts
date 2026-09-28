import { GitLabProvider } from './gitlab.provider';
import type { HttpClient } from '../factory';

function issue(iid: number, updatedAt: string) {
  return {
    iid,
    title: `#${iid}`,
    description: null,
    author: { username: 'dev' },
    web_url: `https://gitlab.com/g/r/-/issues/${iid}`,
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: updatedAt,
  };
}

describe('GitLabProvider.fetchIssues pagination (M10)', () => {
  let get: jest.Mock;
  let provider: GitLabProvider;

  beforeEach(() => {
    get = jest.fn();
    provider = new GitLabProvider('g', 'r', 'tok', { get, post: jest.fn() } as unknown as HttpClient);
  });

  it('pages with X-Next-Page in update order, since the cursor', async () => {
    get
      .mockResolvedValueOnce({ data: [issue(1, '2026-09-01T00:00:00Z')], headers: { 'x-next-page': '2' } })
      .mockResolvedValueOnce({ data: [issue(2, '2026-09-02T00:00:00Z')], headers: { 'x-next-page': '' } });

    const result = await provider.fetchIssues(new Date('2026-08-01T00:00:00Z'));

    const base = { state: 'opened', order_by: 'updated_at', sort: 'asc', per_page: 100, updated_after: '2026-07-31T23:59:59.000Z' };
    expect(get).toHaveBeenNthCalledWith(1, 'https://gitlab.com/api/v4/projects/g%2Fr/issues', { headers: { 'PRIVATE-TOKEN': 'tok' }, params: { ...base, page: 1 } });
    expect(get).toHaveBeenNthCalledWith(2, 'https://gitlab.com/api/v4/projects/g%2Fr/issues', { headers: { 'PRIVATE-TOKEN': 'tok' }, params: { ...base, page: 2 } });
    expect(result.issues.map((i) => i.number)).toEqual([1, 2]);
    expect(result.cursor).toEqual(new Date('2026-09-02T00:00:00Z'));
    expect(result.capped).toBe(false);
  });

  it('stops after 10 pages and reports the fetch as capped', async () => {
    get.mockImplementation(async (_url: string, config: { params: { page: number } }) => ({
      data: [issue(config.params.page, '2026-09-01T00:00:00Z')],
      headers: { 'x-next-page': String(config.params.page + 1) },
    }));

    const result = await provider.fetchIssues();

    expect(get).toHaveBeenCalledTimes(10);
    expect(result.capped).toBe(true);
  });
});
