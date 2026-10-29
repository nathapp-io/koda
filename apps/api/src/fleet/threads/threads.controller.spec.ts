import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import type { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import type { PermissionService } from '../../permissions/permission.service';
import type { ThreadsService } from './threads.service';
import { ThreadsController } from './threads.controller';

const principal = { id: 'a1', actorType: 'agent', slug: 'agent', status: 'ACTIVE', capabilities: [] } satisfies AgentPrincipal;
const ctx = { project: { id: 'p1', slug: 'web' } };

describe('ThreadsController approval gate', () => {
  const cases = [
    { key: 'thread.create', variant: 'rest:threads.create', input: { thread: { kind: 'PROJECT', title: 'T', backend: { kind: 'native', model: 'm1' } } }, invoke: (c: ThreadsController) => c.create({ kind: 'PROJECT', title: 'T', backend: { kind: 'native', model: 'm1' } }, ctx, principal) },
    { key: 'thread.cap.update', variant: 'rest:threads.update', input: { id: 't1', patch: { maxCostUsd: 7 } }, invoke: (c: ThreadsController) => c.update('t1', { maxCostUsd: 7 }, ctx, principal) },
    { key: 'thread.archive', variant: 'rest:threads.archive', input: { id: 't1' }, invoke: (c: ThreadsController) => c.archive('t1', ctx, principal) },
  ];
  it.each(cases)('AC-12: $key sends frozen project input and returns executed result', async ({ key, variant, input, invoke }) => {
    const result = { id: 't1', status: 'ARCHIVED' };
    const run = vi.fn().mockResolvedValue({ status: 'executed', result });
    const c = new ThreadsController({} as ThreadsService, {} as PermissionService, { run } as unknown as ApprovalRouteGate);
    expect(await invoke(c)).toEqual(JsonResponse.Ok(result));
    expect(run).toHaveBeenCalledExactlyOnceWith({ key, variant, projectId: 'p1', input: { slug: 'web', projectId: 'p1', ...input } });
  });
  it.each(cases)('$key signals pending without calling the service', async ({ invoke }) => {
    const run = vi.fn().mockResolvedValue({ status: 'pending', request: { id: 'approval1' } });
    const c = new ThreadsController({} as ThreadsService, {} as PermissionService, { run } as unknown as ApprovalRouteGate);
    await expect(invoke(c)).rejects.toBeInstanceOf(ApprovalPending);
  });
});
