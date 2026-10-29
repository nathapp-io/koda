import { ProjectsController } from './projects.controller';
import type { ProjectsService } from './projects.service';
import type { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import type { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import type { AgentsService } from '../agents/agents.service';
import type { PermissionService } from '../permissions/permission.service';
import type { CreateProjectDto } from './dto/create-project.dto';

describe('ProjectsController approval routes', () => {
  it('AC-9: gates project creation with the validated body and global scope', async () => {
    const routeGate = { run: vi.fn().mockResolvedValue({ status: 'executed', result: { id: 'p1' } }) };
    const controller = new ProjectsController(
      {} as ProjectsService,
      {} as ImpactAnalysisService,
      {} as AgentsService,
      {} as PermissionService,
      routeGate as unknown as ApprovalRouteGate,
    );
    const dto = { name: 'Project', slug: 'project', key: 'PR' } as CreateProjectDto;

    await controller.create(dto);

    expect(routeGate.run).toHaveBeenCalledExactlyOnceWith({
      key: 'project.create',
      variant: 'rest:projects.create',
      projectId: null,
      input: dto,
    });
  });
});
