import { ProjectsController } from '../../projects/projects.controller';
import { AgentsController } from '../../agents/agents.controller';
import { AdminSkillsController } from '../../skills/admin-skills.controller';
import type { ProjectsService } from '../../projects/projects.service';
import type { AgentsService } from '../../agents/agents.service';
import type { SkillsService } from '../../skills/skills.service';
import type { ImpactAnalysisService } from '../../code-intel/impact-analysis.service';
import type { PermissionService } from '../../permissions/permission.service';
import { ApprovalRouteGate } from './approval-route-gate';
import { ApprovalPending } from './approval-pending';
import { APPROVAL_GATED_METADATA } from './approval-gated.decorator';

describe('admin delete HTTP handler mappings', () => {
  for (const domain of ['project', 'agent', 'skill.source'] as const) {
    function build() {
      const run = vi.fn();
      const gate = { run } as unknown as ApprovalRouteGate;
      const findBySlug = vi.fn().mockResolvedValue({ id: 'target-1', slug: 'alpha' });
      const service = { findBySlug, softDelete: vi.fn(), remove: vi.fn(), deleteSource: vi.fn() };
      const controller = domain === 'project'
        ? new ProjectsController(service as unknown as ProjectsService, {} as ImpactAnalysisService, {} as AgentsService, {} as PermissionService, gate)
        : domain === 'agent' ? new AgentsController(service as unknown as AgentsService, gate)
          : new AdminSkillsController(service as unknown as SkillsService, gate);
      const invoke = () => domain === 'project'
        ? (controller as ProjectsController).remove('alpha', { project: { id: 'p1', slug: 'alpha' } })
        : (controller as AgentsController | AdminSkillsController).remove('alpha');
      return { run, service, controller, invoke };
    }
    it(`${domain}: maps executed outcome and never directly calls the service`, async () => {
      const { run, service, controller, invoke } = build();
      const result = { slug: 'alpha' };
      run.mockResolvedValue({ status: 'executed', result });
      const output = await invoke();
      expect(run).toHaveBeenCalledExactlyOnceWith({
        key: `${domain}.delete`,
        variant: domain === 'project' ? 'rest:projects.delete' : domain === 'agent' ? 'rest:agents.delete' : 'rest:admin-skill-sources.delete',
        projectId: domain === 'project' ? 'p1' : null,
        input: domain === 'skill.source' ? { id: 'alpha' } : domain === 'project' ? { slug: 'alpha', projectId: 'p1' } : { slug: 'alpha', agentId: 'target-1' },
      });
      if (domain === 'agent') expect(output).toMatchObject({ data: result });
      else expect(output).toBeUndefined();
      for (const mock of [service.softDelete, service.remove, service.deleteSource]) expect(mock).not.toHaveBeenCalled();
      if (domain === 'agent') expect(service.findBySlug).toHaveBeenCalledExactlyOnceWith('alpha');
      expect(Reflect.getMetadata(APPROVAL_GATED_METADATA, controller.remove)).toBe(true);
    });
    it(`${domain}: throws ApprovalPending with the request unchanged`, async () => {
      const { run, invoke } = build();
      const request = { id: 'approval-1', permissionKey: `${domain}.delete` };
      run.mockResolvedValue({ status: 'pending', request });
      const error: unknown = await invoke().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ApprovalPending);
      expect((error as ApprovalPending).request).toBe(request);
    });
  }
});
