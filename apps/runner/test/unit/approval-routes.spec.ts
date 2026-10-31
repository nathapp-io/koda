import { describe, expect, test } from 'bun:test';
import { decideApproval, listJobApprovals } from '../integration/harness/approval-routes';

type Http = (method: string, path: string, options?: { body?: unknown }) => Promise<{ status: number; body: unknown }>;

describe('runner harness approval routes', () => {
  test('AC-1: deny posts a reject decision', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const http: Http = async (method, path, options) => {
      calls.push({ method, path, ...options });
      return { status: 200, body: null };
    };

    expect(await decideApproval(http, 'a1', 'deny')).toBe(200);
    expect(calls).toEqual([{ method: 'POST', path: '/approvals/a1/decisions', body: { decision: 'reject' } }]);
  });

  test('AC-2: allow_for_job posts an approve decision with its choice', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const http: Http = async (method, path, options) => {
      calls.push({ method, path, ...options });
      return { status: 200, body: null };
    };

    expect(await decideApproval(http, 'a1', 'allow_for_job')).toBe(200);
    expect(calls).toEqual([{ method: 'POST', path: '/approvals/a1/decisions', body: { decision: 'approve', params: { choice: 'allow_for_job' } } }]);
  });

  test('AC-3: lists details but preserves status from the summary row', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const http: Http = async (method, path) => {
      calls.push({ method, path });
      if (path === '/approvals?jobId=j1') {
        return { status: 200, body: { data: { records: [{ id: 'a1', status: 'executed' }] } } };
      }
      return { status: 200, body: { data: { details: { resolvedBy: 'user', outcome: { delivery: { result: 'ok' } } } } } };
    };

    expect(await listJobApprovals(http, 'j1')).toEqual([
      { id: 'a1', status: 'executed', resolvedBy: 'user', outcome: { delivery: { result: 'ok' } } },
    ]);
    expect(calls).toEqual([{ method: 'GET', path: '/approvals?jobId=j1' }, { method: 'GET', path: '/approvals/a1' }]);
  });

  test('AC-4: preserves a refused decision response status', async () => {
    const http: Http = async () => ({ status: 403, body: { message: 'forbidden' } });

    expect(await decideApproval(http, 'a1', 'allow')).toBe(403);
  });
});
