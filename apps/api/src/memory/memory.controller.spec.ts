import { MemoryController } from './memory.controller';
import { MemoryWriteService } from './memory-write.service';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { MemoryKind } from '../common/enums';
import type { KodaPrincipal, UserPrincipal } from '../auth/principal/koda-principal.types';

const principal: UserPrincipal = {
  actorType: 'user', id: 'user-1', name: undefined, blacklisted: false, revoked: false,
  authorities: [], role: 'ADMIN' as UserPrincipal['role'], email: 'user@example.test',
};

describe('MemoryController gated writes', () => {
  it('AC-10 calls routeGate.run for create with the dto project and body', async () => {
    const input = { projectId: 'p1', kind: MemoryKind.FACT, subject: 's', predicate: 'p' };
    const run = vi.fn().mockResolvedValue({ status: 'executed', result: { id: 'memory-1' } });
    const controller = new MemoryController({} as MemoryWriteService, { run } as unknown as ApprovalRouteGate);

    await controller.createMemory(input, principal);

    expect(run).toHaveBeenCalledExactlyOnceWith({ key: 'memory.create', variant: 'rest:memory.create', projectId: 'p1', input: { memory: input } });
  });

  it.each([
    ['createMemory', 'memory.create', 'create', { projectId: 'p1', kind: MemoryKind.FACT, subject: 's', predicate: 'p' }],
    ['recordDecision', 'memory.decision.record', 'recordDecision', { projectId: 'p1', topic: 't', decision: 'd' }],
    ['extractFromEvent', 'memory.extract', 'extract', { projectId: 'p1', type: 'ticket_event', action: 'status_changed', data: {} }],
  ] as const)('%s delegates through the matching command and preserves the result', async (handler, key, method, body) => {
    const result = { result: true };
    const write = vi.fn().mockResolvedValue(result);
    const memoryWrites = { create: write, recordDecision: write, extract: write };
    const run = vi.fn(async (call: { key: string; input: Record<string, unknown> }) => {
      const member = handler === 'createMemory' ? 'memory' : handler === 'recordDecision' ? 'decision' : 'event';
      return { status: 'executed', result: await write(principal as KodaPrincipal, call.input[member]) };
    });
    const controller = new MemoryController(memoryWrites as unknown as MemoryWriteService, { run } as unknown as ApprovalRouteGate);

    if (handler === 'createMemory') await controller.createMemory(body, principal);
    else if (handler === 'recordDecision') await controller.recordDecision(body, principal);
    else await controller.extractFromEvent(body, principal);

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ key }));
    expect(write).toHaveBeenCalledOnce();
  });
});
