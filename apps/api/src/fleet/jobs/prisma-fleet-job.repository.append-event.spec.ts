import { Prisma } from '@prisma/client';
import { PrismaFleetJobRepository } from './prisma-fleet-job.repository';

/**
 * 2b TYPE-2: a duplicate (jobId, leaseEpoch, runnerSeq) insert is mapped to a no-op.
 * Build a minimal PrismaService-shaped stub with the methods this code path uses.
 */
describe('PrismaFleetJobRepository.appendEvent P2002 no-op', () => {
  const existing = { id: 'e1', jobId: 'j1', seq: 1, leaseEpoch: 2, runnerSeq: 3, type: 'log', payload: {}, createdAt: new Date() };
  const update = jest.fn(async () => ({ eventSeq: 1 }));
  const findUnique = jest.fn(async () => existing);
  const create = jest.fn(async () => { throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }); });
  const prisma = { client: { fleetJob: { update }, fleetJobEvent: { create, findUnique } } };
  const repo = new PrismaFleetJobRepository(prisma as never);

  it('returns the existing row when the unique (jobId, leaseEpoch, runnerSeq) collides', async () => {
    const r = await repo.appendEvent('j1', { leaseEpoch: 2, runnerSeq: 3, type: 'log', payload: { text: 'again' } });
    expect(r).toBe(existing);
    expect(findUnique).toHaveBeenCalledWith({ where: { jobId_leaseEpoch_runnerSeq: { jobId: 'j1', leaseEpoch: 2, runnerSeq: 3 } } });
  });

  it('rethrows the P2002 when the colliding row does not exist (server-side seq race)', async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(repo.appendEvent('j1', { leaseEpoch: 2, runnerSeq: 3, type: 'log', payload: {} })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it('does not intercept P2002 on a server-side (runnerSeq = null) insert', async () => {
    create.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    await expect(repo.appendEvent('j1', { leaseEpoch: 2, runnerSeq: null, type: 'state', payload: {} })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });
});
