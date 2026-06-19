import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CacheManager } from '@nathapp/nestjs-cache';
import { PrismaProjectRepository } from '../../projects/prisma-project.repository';
import { AgentsService } from '../../agents/agents.service';
import { authConfig } from '../../config/auth.config';

export const mockPrismaService = {
  client: {},
} as unknown as PrismaService;

export const mockTransactionManager: ITransactionManager = {
  run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  getClient: () => undefined,
  isInTransaction: () => false,
};

export const mockAgentsService = {
  findByProject: async () => [],
  update: async () => undefined,
} as unknown as AgentsService;

export const mockCacheManager = {
  get: async () => undefined,
  set: async () => undefined,
  del: async () => undefined,
} as unknown as CacheManager;

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [authConfig],
      envFilePath: ['.env.test'],
    }),
  ],
  providers: [
    { provide: PrismaService, useValue: mockPrismaService },
    { provide: TRANSACTION_MANAGER, useValue: mockTransactionManager },
    PrismaProjectRepository,
    { provide: AgentsService, useValue: mockAgentsService },
    { provide: CacheManager, useValue: mockCacheManager },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER, ConfigModule, PrismaProjectRepository, AgentsService, CacheManager],
})
export class GlobalStubsModule {}
