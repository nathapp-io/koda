import { ConflictAppException } from '../../common/exceptions/conflict-app.exception';
import { AssistantActionPort, type AssistantActionDecider } from './assistant-action.port';
import type { FleetApprovalRecord } from './domain/approval.domain';

const NOW = new Date('2026-10-23T09:00:00.000Z');
const approval = { id: 'a1', type: 'assistant_action' } as FleetApprovalRecord;
const caller = { id: 'u1', globalAdmin: false };
const dto = { decision: 'reject' as const };

describe('AssistantActionPort (2a-D1)', () => {
  it('forwards decide to the registered decider with every argument and answers its approval', async () => {
    const decided = { ...approval, status: 'rejected' } as FleetApprovalRecord;
    const decider: AssistantActionDecider = { decide: vi.fn(async () => decided) };
    const port = new AssistantActionPort();
    port.register(decider);

    await expect(port.decide(caller, approval, dto, NOW)).resolves.toBe(decided);
    expect(decider.decide).toHaveBeenCalledWith(caller, approval, dto, NOW);
  });

  it('answers 409 threads.disabled while nothing is registered', () => {
    const port = new AssistantActionPort();
    expect(() => port.decide(caller, approval, dto, NOW)).toThrow(ConflictAppException);
    expect(() => port.decide(caller, approval, dto, NOW)).toThrow(expect.objectContaining({ prefix: 'threads.disabled', code: 409 }));
  });
});
