import { Test, TestingModule } from '@nestjs/testing';
import { MePermissionsController } from './me-permissions.controller';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { AgentsService } from '../agents/agents.service';
import { MemoryGovernanceService } from '../memory/memory-governance.service';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { ProjectAccessService } from './project-access.service';
import { PermissionService } from '../permissions/permission.service';

describe('ProjectsModule — DI wiring', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      // US-001: `MePermissionsController` is registered in `ProjectsModule`, so its two service
      // dependencies must resolve from the same container as the projects controller's.
      controllers: [ProjectsController, MePermissionsController],
      providers: [
        { provide: ProjectsService, useValue: {} },
        { provide: AgentsService, useValue: {} },
        { provide: MemoryGovernanceService, useValue: {} },
        { provide: ImpactAnalysisService, useValue: {} },
        // US-001: the route-level ProjectMembershipGuard is instantiated by the DI
        // container even though these tests check controller wiring only, so its
        // ProjectAccessService dependency must resolve.
        { provide: ProjectAccessService, useValue: {} },
        // US-007: the controller's required fourth dependency, and the route-level RequiresGuard.
        { provide: PermissionService, useValue: { can: vi.fn() } },
      ],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('ProjectsController resolves with MemoryGovernanceService injected', () => {
    const controller = module.get(ProjectsController);
    expect(controller).toBeDefined();
  });

  it('MePermissionsController resolves with ProjectAccessService and PermissionService injected', () => {
    expect(module.get(MePermissionsController)).toBeInstanceOf(MePermissionsController);
  });
});
