import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import type { ApprovalRouteGate } from '../../approvals/route/approval-route-gate';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import type { ThreadsService } from './threads.service';
import { ThreadsController } from './threads.controller';

const principal = { id: 'a1', actorType: 'agent', slug: 'agent', status: 'ACTIVE', capabilities: [] } satisfies AgentPrincipal;
const ctx = { project: { id: 'p1', slug: 'web' } };
/** #399, US-001: the create route asks the service whether some runner can host the thread before the gate. */
const served = () => ({ assertThreadServed: vi.fn(async () => undefined), assertModeServed: vi.fn(async () => undefined), assertModeAllowed: vi.fn(async () => undefined) }) as unknown as ThreadsService;

describe('ThreadsController approval gate', () => {
  it.each([false, true])('message projects raw results and sets 200 only for duplicates (%s)', async (deduplicated) => {
    const result = { message: { id: 'm1' }, jobId: null, deduplicated };
    const run = vi.fn().mockResolvedValue({ status: 'executed', result });
    const status = vi.fn();
    const c = new ThreadsController(served(), { run } as unknown as ApprovalRouteGate);
    expect(await c.sendMessage('t1', { text: 'hi', clientMessageId: 'c1' }, ctx, principal, { status })).toEqual(JsonResponse.Ok({ message: result.message, jobId: null }));
    expect(run).toHaveBeenCalledExactlyOnceWith({ key: 'thread.message.send', variant: 'rest:threads.message', projectId: 'p1', input: { slug: 'web', projectId: 'p1', id: 't1', message: { text: 'hi', clientMessageId: 'c1' } } });
    if (deduplicated) expect(status).toHaveBeenCalledExactlyOnceWith(200);
    else expect(status).not.toHaveBeenCalled();
  });
  it('message maps pending without setting duplicate status', async () => {
    const run = vi.fn().mockResolvedValue({ status: 'pending', request: { id: 'approval1' } });
    const status = vi.fn();
    const c = new ThreadsController(served(), { run } as unknown as ApprovalRouteGate);
    await expect(c.sendMessage('t1', { text: 'hi', clientMessageId: 'c1' }, ctx, principal, { status })).rejects.toBeInstanceOf(ApprovalPending);
    expect(status).not.toHaveBeenCalled();
  });
  it('#399: create refuses a backend no runner serves before the approval gate opens', async () => {
    const run = vi.fn();
    const refusal = new Error('threads.backendUnavailable');
    const service = { assertThreadServed: vi.fn(async () => { throw refusal; }) } as unknown as ThreadsService;
    const c = new ThreadsController(service, { run } as unknown as ApprovalRouteGate);
    await expect(c.create({ kind: 'PROJECT', title: 'T', backend: { kind: 'native', model: 'nobody/offers' } }, ctx, principal)).rejects.toBe(refusal);
    expect(service.assertThreadServed).toHaveBeenCalledWith({ backend: { kind: 'native', model: 'nobody/offers' }, kind: 'PROJECT', mode: 'read' });
    expect(run).not.toHaveBeenCalled();
  });

  it('US-001: create judges a REPO thread with its own mode', async () => {
    const run = vi.fn().mockResolvedValue({ status: 'executed', result: { id: 't1' } });
    const service = { assertThreadServed: vi.fn(async () => undefined), assertModeAllowed: vi.fn(async () => undefined) } as unknown as ThreadsService;
    const c = new ThreadsController(service, { run } as unknown as ApprovalRouteGate);
    await c.create({ kind: 'REPO', repoId: 'r1', feature: 'f', title: 'T', mode: 'ask', backend: { kind: 'native', model: 'm1' } }, ctx, principal);
    expect(service.assertThreadServed).toHaveBeenCalledWith({ backend: { kind: 'native', model: 'm1' }, kind: 'REPO', mode: 'ask' });
  });

  it('US-001: a mode change asks the service before the approval gate opens', async () => {
    const run = vi.fn();
    const refusal = new Error('threads.modeUnavailable');
    const service = { assertModeServed: vi.fn(async () => { throw refusal; }) } as unknown as ThreadsService;
    const c = new ThreadsController(service, { run } as unknown as ApprovalRouteGate);
    await expect(c.changeMode('t1', { mode: 'ask' }, ctx, principal)).rejects.toBe(refusal);
    expect(service.assertModeServed).toHaveBeenCalledWith('p1', 't1', 'ask');
    expect(run).not.toHaveBeenCalled();
  });
  const cases = [
    { key: 'thread.create', variant: 'rest:threads.create', input: { thread: { kind: 'PROJECT', title: 'T', backend: { kind: 'native', model: 'm1' } } }, invoke: (c: ThreadsController) => c.create({ kind: 'PROJECT', title: 'T', backend: { kind: 'native', model: 'm1' } }, ctx, principal) },
    { key: 'thread.cap.update', variant: 'rest:threads.update', input: { id: 't1', patch: { maxCostUsd: 7 } }, invoke: (c: ThreadsController) => c.update('t1', { maxCostUsd: 7 }, ctx, principal) },
    { key: 'thread.archive', variant: 'rest:threads.archive', input: { id: 't1' }, invoke: (c: ThreadsController) => c.archive('t1', ctx, principal) },
    { key: 'thread.publish', variant: 'rest:threads.publish', input: { id: 't1' }, invoke: (c: ThreadsController) => c.publish('t1', ctx, principal) },
    { key: 'thread.discard', variant: 'rest:threads.discard', input: { id: 't1' }, invoke: (c: ThreadsController) => c.discard('t1', ctx, principal) },
  ];
  it.each(cases)('AC-12: $key sends frozen project input and returns executed result', async ({ key, variant, input, invoke }) => {
    const result = { id: 't1', status: 'ARCHIVED' };
    const run = vi.fn().mockResolvedValue({ status: 'executed', result });
    const c = new ThreadsController(served(), { run } as unknown as ApprovalRouteGate);
    expect(await invoke(c)).toEqual(JsonResponse.Ok(result));
    expect(run).toHaveBeenCalledExactlyOnceWith({ key, variant, projectId: 'p1', input: { slug: 'web', projectId: 'p1', ...input } });
  });
  it.each(cases)('$key signals pending without calling the service', async ({ invoke }) => {
    const run = vi.fn().mockResolvedValue({ status: 'pending', request: { id: 'approval1' } });
    const c = new ThreadsController(served(), { run } as unknown as ApprovalRouteGate);
    await expect(invoke(c)).rejects.toBeInstanceOf(ApprovalPending);
  });
});
