import type { FleetJobRecord } from '../jobs/domain/fleet-job.domain';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';
import { FleetCommandType } from '../../common/enums';
import { FenceService } from './fence.service';

describe('FenceService bookkeeping', () => {
  it('AC-11: marks ABANDON command creation and activity under runner.fence-abandon', async () => {
    const repo = {
      findPendingCommand: vi.fn(async () => null),
      createCommand: vi.fn(async () => {
        expect(currentBookkeepingReason()).toBe('runner.fence-abandon');
      }),
    };
    const activity = {
      record: vi.fn(async (event: { action: string }) => {
        expect(event.action).toBe('job.abandon_queued');
        expect(currentBookkeepingReason()).toBe('runner.fence-abandon');
      }),
    };
    const service = new FenceService(repo as never, activity as never);

    await expect(service.abandon('r1', { id: 'j1', projectId: 'p1', leaseEpoch: 1 } as FleetJobRecord, 2)).resolves.toBe(true);
    expect(repo.createCommand).toHaveBeenCalledWith(expect.objectContaining({ type: FleetCommandType.ABANDON }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'job.abandon_queued' }));
  });
});
