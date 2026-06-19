import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { AgentsService } from '../agents/agents.service';
import { PrismaMemoryItemRepository } from '../memory/prisma-memory-item.repository';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { PrismaService } from '@nathapp/nestjs-prisma';

describe('ProjectsModule — DI wiring', () => {
  let module: TestingModule;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        { provide: ProjectsService, useValue: {} },
        { provide: AgentsService, useValue: {} },
        { provide: PrismaMemoryItemRepository, useValue: {} },
        { provide: ImpactAnalysisService, useValue: {} },
        {
          provide: PrismaService,
          useValue: { client: { projectMember: { findUnique: jest.fn() } } },
        },
      ],
    }).compile();
  });

  afterEach(async () => {
    await module.close();
  });

  it('ProjectsController resolves with AgentsService injected', () => {
    const controller = module.get(ProjectsController);
    expect(controller).toBeDefined();
  });
});
