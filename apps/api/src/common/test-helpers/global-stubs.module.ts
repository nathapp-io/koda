import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { CacheManager } from '@nathapp/nestjs-cache';
import { PrismaProjectRepository } from '../../projects/prisma-project.repository';
import { AgentsService } from '../../agents/agents.service';
import { AUTH_CFG, IAuthConfig, authConfig } from '../../config/auth.config';
import { RAG_CFG, IRagConfig } from '../../config/rag.config';
import { VCS_CFG, IVcsConfig, vcsConfig } from '../../config/vcs.config';

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

export const mockAuthConfig: IAuthConfig = {
  jwtSecret: 'test-secret',
  jwtExpiresIn: '15m',
  jwtRefreshSecret: 'test-refresh-secret',
  jwtRefreshExpiresIn: '7d',
  apiKeySecret: 'test-api-key-secret',
};

export const mockRagConfig: IRagConfig = {
  embeddingProvider: 'ollama',
  embeddingModel: 'nomic-embed-text',
  ollamaBaseUrl: 'http://localhost:11434',
  openaiApiKey: '',
  lancedbPath: '/tmp/lancedb-test',
  inMemoryOnly: true,
  ftsIndexMode: 'disk',
  similarityHigh: 0.85,
  similarityMedium: 0.7,
  similarityLow: 0.5,
  ftsOptimizeStrategy: 'counter',
  ftsOptimizeThreshold: 100,
  ftsOptimizeIntervalMs: 60000,
  graphifyEnabledCacheTtlSec: 60,
};

export const mockVcsConfig: IVcsConfig = {
  encryptionKey: undefined,
  defaultPollingIntervalMs: 300000,
  githubApiUrl: 'https://api.github.com',
};

@Global()
@Module({
  imports: [
    // ConfigModule.forRoot is required here (not a lightweight mock) because
    // ProjectsModule → AgentsModule → NathappAuthModule.forRootAsync requires a
    // real ConfigService that can resolve the JWT config object structure.
    ConfigModule.forRoot({
      isGlobal: true,
      load: [authConfig, vcsConfig],
      envFilePath: ['.env.test'],
    }),
  ],
  providers: [
    { provide: PrismaService, useValue: mockPrismaService },
    { provide: TRANSACTION_MANAGER, useValue: mockTransactionManager },
    PrismaProjectRepository,
    { provide: AgentsService, useValue: mockAgentsService },
    { provide: CacheManager, useValue: mockCacheManager },
    { provide: AUTH_CFG, useValue: mockAuthConfig },
    { provide: RAG_CFG, useValue: mockRagConfig },
    { provide: VCS_CFG, useValue: mockVcsConfig },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER, ConfigModule, PrismaProjectRepository, AgentsService, CacheManager, AUTH_CFG, RAG_CFG, VCS_CFG],
})
export class GlobalStubsModule {}
