import { FleetJobLogsController } from './fleet-job-logs.controller';

/** HTTP status of a rejected call (AppException extends HttpException). */
const statusOf = (p: Promise<unknown>) => p.then(() => 0, (e: { getStatus(): number }) => e.getStatus());

describe('FleetJobLogsController', () => {
  const reads = { list: vi.fn(async () => ({ attempts: [] })), entries: vi.fn(), raw: vi.fn(), download: vi.fn() };
  const controller = new FleetJobLogsController(reads as never);
  const ctx = { project: { id: 'p1' } } as never;
  const agent = { actorType: 'agent', id: 'a1' } as never;
  const user = { actorType: 'user', id: 'u1' } as never;

  it('refuses agent principals on every route (R10)', async () => {
    await expect(statusOf(controller.list('j1', ctx, agent))).resolves.toBe(403);
    await expect(statusOf(controller.entries('j1', 'run', {} as never, ctx, agent))).resolves.toBe(403);
    await expect(statusOf(controller.raw('j1', 'run', {} as never, ctx, agent))).resolves.toBe(403);
    expect(reads.list).not.toHaveBeenCalled();
    expect(reads.entries).not.toHaveBeenCalled();
  });

  it('defaults entries to forward with limit 200 and parses numbers', async () => {
    reads.entries.mockResolvedValue({ entries: [] });
    await controller.entries('j1', 'run', { cursor: '12', level: 'warn' } as never, ctx, user);
    expect(reads.entries).toHaveBeenCalledWith('p1', 'j1', 'run', { cursor: 12, level: 'warn', direction: 'forward', limit: 200 });
  });

  it('carries the 600/min read throttle (R10, D331)', () => {
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', FleetJobLogsController);
    expect(limit).toBe(600);
  });
});
