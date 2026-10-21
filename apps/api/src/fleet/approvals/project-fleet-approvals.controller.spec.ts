/**
 * US-004 — the project approvals prefix hands the service a route with the project's id only.
 *
 * Permissions P1 removed the project role from `ApprovalRoute` (it decided nothing after US-006), so the
 * controller's route builder must not read `ctx.role` — the handler's `@CurrentProject()` value no longer
 * carries one.
 */
import { Page } from '@nathapp/nestjs-common';
import type { ApprovalsService } from './approvals.service';
import { ProjectFleetApprovalsController } from './project-fleet-approvals.controller';

describe('ProjectFleetApprovalsController (US-004)', () => {
  const PROJECT = { project: { id: 'p1', slug: 'koda' } };

  const list = vi.fn();
  const approvals = { list, get: vi.fn(), decide: vi.fn() } as unknown as ApprovalsService;
  const controller = new ProjectFleetApprovalsController(approvals);

  beforeEach(() => {
    vi.clearAllMocks();
    list.mockResolvedValue(new Page({ current: 1, size: 20 }, 0, []));
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
});
