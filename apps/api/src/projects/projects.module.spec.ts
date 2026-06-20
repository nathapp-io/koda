import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { AgentsService } from '../agents/agents.service';
import { MemoryGovernanceService } from '../memory/memory-governance.service';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';

describe('ProjectsModule — DI wiring', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        { provide: ProjectsService, useValue: {} },
        { provide: AgentsService, useValue: {} },
        { provide: MemoryGovernanceService, useValue: {} },
        { provide: ImpactAnalysisService, useValue: {} },
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
});
