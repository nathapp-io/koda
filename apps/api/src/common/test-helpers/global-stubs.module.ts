import { vi } from 'vitest';
import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { ITransactionManager, TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService } from '@nathapp/nestjs-outbox';
import { CacheManager } from '@nathapp/nestjs-cache';
import { INotifyService, NOTIFY_SERVICE, PREFERENCE_SERVICE } from '@nathapp/nestjs-notify';
import { AgentsService } from '../../agents/agents.service';
import { EmailAvailability } from '../../email/email-availability';
import { EmailScheduleService } from '../../email/schedule/email-schedule.service';
import { AUTH_CFG, IAuthConfig, authConfig } from '../../config/auth.config';
import { RAG_CFG, IRagConfig } from '../../config/rag.config';
import { VCS_CFG, IVcsConfig, vcsConfig } from '../../config/vcs.config';
import { outboxConfig } from '../../config/outbox.config';
import { LIVE_CFG, ILiveConfig } from '../../config/live.config';
import { WEBHOOK_CFG, IWebhookConfig } from '../../config/webhook.config';
import { FLEET_CFG, IFleetConfig } from '../../config/fleet.config';
import { testFleetConfig } from './fleet-config';

export const mockPrismaService = {
  client: {
    project: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    projectMember: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
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

export const mockOutboxService = {
  record: vi.fn(async (event: { type: string }) => ({ id: 'outbox-stub', ...event })),
} as unknown as OutboxService;

/** S4b US-001: NotificationPreferencesService injects the package preference service (global). */
export const mockPreferenceService = {
  getPreferences: vi.fn(async () => []),
  updatePreference: vi.fn(async () => ({})),
  isChannelEnabled: vi.fn(async () => true),
};

/** S4b US-001: NotificationPreferencesService injects EmailAvailability (global EmailCoreModule). */
export const mockEmailAvailability = {
  configured: true,
  config: () => ({ smtpUrl: null, from: null, webPublicUrl: null, delaySec: 300, approvalDelaySec: 60, maxAttempts: 5, inviteTtlDays: 7 }),
  webUrl: vi.fn((path: string) => `http://web.test${path}`),
} as unknown as EmailAvailability;

/** S4b US-001: EmailScheduleService is provided globally by EmailCoreModule; stub it for module specs. */
export const mockEmailScheduleService = {
  scheduleNotifications: vi.fn(async () => 0),
  scheduleMemberAdded: vi.fn(async () => undefined),
  startInviteSend: vi.fn(),
  claimDue: vi.fn(async () => []),
  closeAbandonedInvites: vi.fn(async () => 0),
  markSent: vi.fn(async () => undefined),
  markSkipped: vi.fn(async () => undefined),
  markFailed: vi.fn(async () => undefined),
  retryAt: vi.fn(async () => undefined),
} as unknown as EmailScheduleService;

/** S4b US-002: the dispatcher injects nestjs-notify's package service; stub it for module specs. */
export const mockNotifyService = {
  send: vi.fn(async () => undefined),
} as unknown as INotifyService;

export const mockAuthConfig: IAuthConfig = {
  jwtSecret: 'test-secret',
  jwtExpiresIn: '15m',
  jwtRefreshSecret: 'test-refresh-secret',
  jwtRefreshExpiresIn: '7d',
  apiKeySecret: 'test-api-key-secret',
  registrationEnabled: false,
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
  gitlabApiUrl: 'https://gitlab.com/api/v4',
};

export const mockLiveConfig: ILiveConfig = { heartbeatMs: 25000, maxStreamsPerUser: 5 };

export const mockWebhookConfig: IWebhookConfig = {
  allowedHostnames: [],
  allowedCidrs: [],
  deliveryTimeoutMs: 5000,
};

export const mockFleetConfig: IFleetConfig = testFleetConfig();

@Global()
@Module({
  imports: [
    // ConfigModule.forRoot is required here (not a lightweight mock) because
    // ProjectsModule → AgentsModule → NathappAuthModule.forRootAsync requires a
    // real ConfigService that can resolve the JWT config object structure.
    ConfigModule.forRoot({
      isGlobal: true,
      load: [authConfig, vcsConfig, outboxConfig],
      envFilePath: ['.env.test'],
    }),
  ],
  providers: [
    { provide: PrismaService, useValue: mockPrismaService },
    { provide: TRANSACTION_MANAGER, useValue: mockTransactionManager },
    { provide: AgentsService, useValue: mockAgentsService },
    { provide: CacheManager, useValue: mockCacheManager },
    { provide: OutboxService, useValue: mockOutboxService },
    { provide: PREFERENCE_SERVICE, useValue: mockPreferenceService },
    { provide: NOTIFY_SERVICE, useValue: mockNotifyService },
    { provide: EmailAvailability, useValue: mockEmailAvailability },
    { provide: EmailScheduleService, useValue: mockEmailScheduleService },
    { provide: AUTH_CFG, useValue: mockAuthConfig },
    { provide: RAG_CFG, useValue: mockRagConfig },
    { provide: VCS_CFG, useValue: mockVcsConfig },
    { provide: LIVE_CFG, useValue: mockLiveConfig },
    { provide: WEBHOOK_CFG, useValue: mockWebhookConfig },
    { provide: FLEET_CFG, useValue: mockFleetConfig },
  ],
  exports: [PrismaService, TRANSACTION_MANAGER, ConfigModule, AgentsService, CacheManager, OutboxService, PREFERENCE_SERVICE, NOTIFY_SERVICE, EmailAvailability, EmailScheduleService, AUTH_CFG, RAG_CFG, VCS_CFG, LIVE_CFG, WEBHOOK_CFG, FLEET_CFG],
})
export class GlobalStubsModule {}
