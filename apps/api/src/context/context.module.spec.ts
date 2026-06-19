import { Test } from '@nestjs/testing';
import { ContextBuilderService } from './context-builder.service';
import { PrismaContextRepository } from './prisma-context.repository';
import { CONTEXT_REPOSITORY } from './domain/context.domain';
import { CanonicalStateService } from '../memory/canonical-state.service';
import { PrismaMemoryItemRepository } from '../memory/prisma-memory-item.repository';
import { HybridRetrieverService } from '../rag/hybrid-retriever.service';
import { EntityGraphService } from '../entity-graph/entity-graph.service';
import { ImpactAnalysisService } from '../code-intel/impact-analysis.service';
import { PrismaService } from '@nathapp/nestjs-prisma';

/**
 * Unit-level DI wiring tests for the context module.
 * Uses a flat provider list instead of importing ContextModule to avoid
 * requiring a database or the full module import graph.
 */
describe('ContextModule DI wiring', () => {
  it('compiles ContextBuilderService with all its dependencies', async () => {
    const prismaMock = { client: {} };

    const module = await Test.createTestingModule({
      providers: [
        ContextBuilderService,
        PrismaContextRepository,
        { provide: CONTEXT_REPOSITORY, useExisting: PrismaContextRepository },
        { provide: PrismaService, useValue: prismaMock },
        { provide: CanonicalStateService, useValue: {} },
        { provide: PrismaMemoryItemRepository, useValue: {} },
        { provide: HybridRetrieverService, useValue: {} },
        { provide: EntityGraphService, useValue: {} },
        { provide: ImpactAnalysisService, useValue: {} },
      ],
    }).compile();

    const service = module.get(ContextBuilderService);
    expect(service).toBeInstanceOf(ContextBuilderService);
  });

  it('binds CONTEXT_REPOSITORY token to PrismaContextRepository', async () => {
    const prismaMock = { client: {} };

    const module = await Test.createTestingModule({
      providers: [
        ContextBuilderService,
        PrismaContextRepository,
        { provide: CONTEXT_REPOSITORY, useExisting: PrismaContextRepository },
        { provide: PrismaService, useValue: prismaMock },
        { provide: CanonicalStateService, useValue: {} },
        { provide: PrismaMemoryItemRepository, useValue: {} },
        { provide: HybridRetrieverService, useValue: {} },
        { provide: EntityGraphService, useValue: {} },
        { provide: ImpactAnalysisService, useValue: {} },
      ],
    }).compile();

    const repo = module.get(CONTEXT_REPOSITORY);
    expect(repo).toBeInstanceOf(PrismaContextRepository);
  });
});
