import { PrismaMonitoringRepository, QUERY_METRICS_LIMIT } from './prisma-monitoring.repository';

describe('PrismaMonitoringRepository.findQueryMetrics (VCS LOW)', () => {
  it('bounds the rows it loads, newest first', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const repo = new PrismaMonitoringRepository({ client: { memoryQueryMetric: { findMany } } } as never);
    const window = { from: new Date('2026-09-27T00:00:00Z'), to: new Date('2026-09-28T00:00:00Z') };

    await repo.findQueryMetrics(window);

    expect(QUERY_METRICS_LIMIT).toBe(10_000);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { createdAt: { gte: window.from, lte: window.to } },
      orderBy: { createdAt: 'desc' },
      take: 10_000,
    }));
  });
});
