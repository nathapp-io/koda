/**
 * US-004 — the project approvals prefix hands the service a route with the project's id only.
 *
 * Permissions P1 removed the project role from `ApprovalRoute` (it decided nothing after US-006), so the
 * controller's route builder must not read `ctx.role` — the handler's `@CurrentProject()` value no longer
 * carries one.
 */
import { JsonResponse, Page } from '@nathapp/nestjs-common';
import { ApprovalPending } from '../../approvals/route/approval-pending';
import { validate } from 'class-validator';
import { ListApprovalsQuery } from './dto/list-approvals.query';
import type { ApprovalsService } from './approvals.service';
import { ProjectFleetApprovalsController } from './project-fleet-approvals.controller';

describe('ProjectFleetApprovalsController (US-004)', () => {
  const PROJECT = { project: { id: 'p1', slug: 'koda' } };

  const list = vi.fn();
  const checkDecide = vi.fn();
  const executeDecided = vi.fn();
  const view = vi.fn();
  const run = vi.fn();
  const approvals = { list, get: vi.fn(), checkDecide, executeDecided, view } as unknown as ApprovalsService;
  const controller = new ProjectFleetApprovalsController(approvals, { run } as never);

  beforeEach(() => {
    vi.resetAllMocks();
    list.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));
  });

  it('US-012 AC-1: the query validator rejects the removed assistant filter', async () => {
    const errors = await validate(Object.assign(new ListApprovalsQuery(), { type: 'assistant_action' }));
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ property: 'type', constraints: expect.objectContaining({ isIn: expect.any(String) }) }),
    ]));
  });

  it.each(['nax_bash_escalate', 'budget_override_required'])('still accepts the %s filter', async (type) => {
    expect(await validate(Object.assign(new ListApprovalsQuery(), { type }))).toEqual([]);
  });

  it('AC-7: list calls approvals.list with exactly { kind: \'project\', projectId: \'p1\' }', async () => {
    await controller.list({}, PROJECT);

    expect(list).toHaveBeenCalledWith(
      { kind: 'project', projectId: 'p1' },
      { status: undefined, type: undefined, jobId: undefined },
      { current: 1, size: 20 },
    );
    // Exactly two fields, not "a route that happens to carry a role too".
    expect(Object.keys(list.mock.calls[0]?.[0] as object).sort()).toEqual(['kind', 'projectId']);
  });
  it('AC-13/AC-14: gates translated input, awaits execution, then reloads the fleet view', async () => {
    const principal = { actorType: 'agent', id: 'agent' } as never;
    const input = { requestId: 'a1', decision: 'approve', comment: null };
    checkDecide.mockResolvedValueOnce({ key: 'fleet.approval.decide.bash', input });
    run.mockResolvedValueOnce({ status: 'executed', result: {} });
    const order: string[] = [];
    executeDecided.mockImplementationOnce(async () => { order.push('execute'); });
    view.mockImplementationOnce(async () => { order.push('view'); return { id: 'a1' }; });
    expect(await controller.decide('a1', { decision: 'allow' }, PROJECT, principal)).toEqual(JsonResponse.Ok({ id: 'a1' }));
    expect(checkDecide).toHaveBeenCalledWith({ id: 'agent', principal }, { kind: 'project', projectId: 'p1' }, 'a1', { decision: 'allow' });
    expect(run).toHaveBeenCalledWith({ key: 'fleet.approval.decide.bash', variant: 'rest:project-fleet-approvals.decide', projectId: 'p1', input, keyCheck: false });
    expect(executeDecided).toHaveBeenCalledWith(principal, 'a1');
    expect(view).toHaveBeenCalledWith('a1');
    expect(order).toEqual(['execute', 'view']);
  });
  it('pending does not execute or reload; immediate reject only reloads', async () => {
    const principal = { actorType: 'agent', id: 'agent' } as never;
    checkDecide.mockResolvedValue({ key: 'fleet.approval.decide.bash', input: { requestId: 'a1', decision: 'reject', comment: null } });
    run.mockResolvedValueOnce({ status: 'pending', request: { id: 'outer' } });
    await expect(controller.decide('a1', { decision: 'deny' }, PROJECT, principal)).rejects.toBeInstanceOf(ApprovalPending);
    expect(executeDecided).not.toHaveBeenCalled();
    expect(view).not.toHaveBeenCalled();
    run.mockResolvedValueOnce({ status: 'executed', result: {} });
    view.mockResolvedValueOnce({ id: 'a1', status: 'rejected' });
    expect(await controller.decide('a1', { decision: 'deny' }, PROJECT, principal)).toEqual(JsonResponse.Ok({ id: 'a1', status: 'rejected' }));
    expect(executeDecided).not.toHaveBeenCalled();
  });
});
