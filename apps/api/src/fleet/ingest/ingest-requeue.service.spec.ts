import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import type { AuditRecorder } from '../../audit/audit-recorder.service';
import { withCommittedEffects } from '../../common/committed-effects';
import type { FleetActivityService } from '../activity/fleet-activity.service';
import type { IFleetJobRepository } from '../jobs/domain/fleet-job.domain';
import type { BundleIngestService } from './bundle-ingest.service';
import type { IBundleIngestRepository } from './domain/bundle-ingest.domain';
import { INGEST_PARSER_VERSION } from './domain/bundle-ingest.domain';
import { IngestRequeueService } from './ingest-requeue.service';

function build() {
  const repo = { backfill: vi.fn().mockResolvedValue(0), rerunJob: vi.fn().mockResolvedValue(2), rerunOutdated: vi.fn().mockResolvedValue(1) };
  const jobs = { findById: vi.fn().mockResolvedValue(null) };
  const ingest = { kick: vi.fn() };
  const activity = { record: vi.fn() };
  const audit = { record: vi.fn() };
  const tx = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()) };
  const service = new IngestRequeueService(repo as unknown as IBundleIngestRepository, jobs as unknown as IFleetJobRepository, ingest as unknown as BundleIngestService, activity as unknown as FleetActivityService, tx as unknown as ITransactionManager, audit as unknown as AuditRecorder);
  return { service, repo, jobs, ingest, activity, audit, tx };
}
describe('IngestRequeueService', () => {
  it('AC-10: refuses a missing job without writes', async () => {
    const f = build();
    await expect(f.service.rerunJob('u1', 'missing')).rejects.toMatchObject(new NotFoundAppException({}, 'fleet.jobs'));
    expect(f.jobs.findById).toHaveBeenCalledWith('missing');
    expect(f.tx.run).not.toHaveBeenCalled();
    expect(f.repo.rerunJob).not.toHaveBeenCalled();
    expect(f.activity.record).not.toHaveBeenCalled();
    expect(f.audit.record).not.toHaveBeenCalled();
    expect(f.ingest.kick).not.toHaveBeenCalled();
  });
  it('AC-11: omits audit for zero while preserving progress', async () => {
    const f = build();
    expect(await f.service.backfill('u1')).toEqual({ queued: 0 });
    expect(f.repo.backfill).toHaveBeenCalledWith(INGEST_PARSER_VERSION);
    expect(f.audit.record).not.toHaveBeenCalled();
    expect(f.activity.record).toHaveBeenCalledWith(expect.objectContaining({ actorType: 'USER', actorId: 'u1', payload: { queued: 0, parserVersion: INGEST_PARSER_VERSION } }));
    expect(f.ingest.kick).toHaveBeenCalledOnce();
  });
  it('AC-12: wakes only after the owning callback returns', async () => {
    const f = build();
    const order: string[] = [];
    f.repo.backfill.mockResolvedValue(1);
    f.ingest.kick.mockImplementation(() => { order.push('kick'); });
    await withCommittedEffects(async () => {
      expect(await f.service.backfill('u1')).toEqual({ queued: 1 });
      expect(f.ingest.kick).not.toHaveBeenCalled();
      order.push('returned');
    });
    expect(order).toEqual(['returned', 'kick']);
    expect(f.audit.record).toHaveBeenCalledWith(expect.objectContaining({ key: 'fleet.ingest.backfill', summary: 'backfill queued 1' }));
  });
  it('drops the wake when the owning transaction fails', async () => {
    const f = build();
    await expect(withCommittedEffects(async () => { await f.service.backfill('u1'); throw new Error('rollback'); })).rejects.toThrow('rollback');
    expect(f.ingest.kick).not.toHaveBeenCalled();
  });
  it('preserves job and outdated bookkeeping', async () => {
    const f = build();
    f.jobs.findById.mockResolvedValue({ id: 'j1', projectId: 'p1' });
    expect(await f.service.rerunJob('u1', 'j1')).toEqual({ queued: 2 });
    expect(f.repo.rerunJob).toHaveBeenCalledWith('j1');
    expect(f.activity.record).toHaveBeenCalledWith(expect.objectContaining({ entityType: 'job', jobId: 'j1', projectId: 'p1', actorType: 'USER' }));
    expect(await f.service.rerunOutdated('u1')).toEqual({ queued: 1 });
    expect(f.repo.rerunOutdated).toHaveBeenCalledWith(INGEST_PARSER_VERSION);
  });
});
