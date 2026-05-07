import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '@prisma/client';
import { ContextBuilderService } from './src/context/context-builder.service';
import { CanonicalStateService } from './src/memory/canonical-state.service';
import { PrismaMemoryItemRepository } from './src/memory/prisma-memory-item.repository';
import { HybridRetrieverService } from './src/rag/hybrid-retriever.service';
import { EntityGraphService } from './src/entity-graph/entity-graph.service';
import { ImpactAnalysisService } from './src/code-intel/impact-analysis.service';

async function test() {
  const mockPrisma = {
    client: {
      project: {
        findUnique: jest.fn().mockResolvedValue({ id: 'test', deletedAt: null }),
      },
    },
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ContextBuilderService,
      { provide: CanonicalStateService, useValue: { getSnapshot: jest.fn() } },
      { provide: PrismaMemoryItemRepository, useValue: { findByProjectMemory: jest.fn() } },
      { provide: HybridRetrieverService, useValue: { search: jest.fn() } },
      { provide: EntityGraphService, useValue: { getRelatedEntities: jest.fn() } },
      { provide: ImpactAnalysisService, useValue: { getChangeImpact: jest.fn() } },
      { provide: PrismaService, useValue: mockPrisma },
    ],
  }).compile();

  const service = module.get(ContextBuilderService);
  console.log('Service:', service);
  console.log('Service has prisma:', (service as any).prisma);
}

test().catch(console.error);
