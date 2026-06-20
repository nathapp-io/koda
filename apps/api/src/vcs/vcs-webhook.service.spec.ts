import { Test, TestingModule } from '@nestjs/testing';
import { VcsWebhookService, GitHubWebhookPayload, WebhookHandleResult } from './vcs-webhook.service';
import { VcsSyncService } from './vcs-sync.service';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { OutboxService } from '../outbox/outbox.service';
import { VcsLinkExtractorService } from './vcs-link-extractor.service';
import { VCS_CFG } from '../config/vcs.config';
import type { VcsConnectionWithProjectDomain } from './domain/vcs.domain';
import type { OutboxEventDomain } from '../outbox/domain/outbox-event.domain';
import type { OutboxEventInput } from '../outbox/outbox.service';
import { IVcsRepository, VCS_REPOSITORY } from './domain/vcs.repository';
import type { OutboxDedupQuery } from './domain/vcs.repository';

interface SharedEnqueuedEvent {
  eventId: string;
  eventType: string;
  projectId: string;
  createdAt: number;
}

function createMockVcsRepository(sharedEnqueuedEvents?: SharedEnqueuedEvent[]): IVcsRepository {
  return {
    findProjectById: jest.fn().mockResolvedValue(null),
    findVcsConnectionByProjectId: jest.fn().mockResolvedValue(null),
    findVcsConnectionById: jest.fn().mockResolvedValue(null),
    findPollingConnections: jest.fn().mockResolvedValue([]),
    createVcsConnection: jest.fn(),
    updateVcsConnection: jest.fn(),
    updateVcsConnectionLastSynced: jest.fn(),
    deleteVcsConnection: jest.fn(),
    createVcsSyncLog: jest.fn(),
    findExistingTicketByExternalId: jest.fn().mockResolvedValue(null),
    createTicketFromIssue: jest.fn(),
    findTicketWithProject: jest.fn().mockResolvedValue(null),
    findActiveTicketLinksWithPrs: jest.fn().mockResolvedValue([]),
    findTicketLinkByPrNumber: jest.fn().mockResolvedValue(null),
    updateTicketLinkPrState: jest.fn(),
    updateTicketLinkWithPrState: jest.fn(),
    applyMergedPrTransition: jest.fn(),
    findPendingOutboxEvents: jest.fn().mockImplementation((query: OutboxDedupQuery) => {
      if (!sharedEnqueuedEvents) return Promise.resolve([]);
      const dedupWindowMs = 5 * 60 * 1000;
      const now = Date.now();
      const matches = sharedEnqueuedEvents.filter(
        (e) =>
          e.projectId === query.projectId &&
          e.eventType === query.eventType &&
          e.eventId === query.eventId &&
          now - e.createdAt < dedupWindowMs,
      );
      return Promise.resolve(matches.map((m) => ({ id: `existing-${m.eventId}` })));
    }),
  };
}

function createMockOutboxService(enqueueMock: jest.Mock) {
  return {
    enqueue: enqueueMock,
    getPendingEvents: jest.fn(),
    getEventsByStatus: jest.fn(),
    processPending: jest.fn(),
    processEvent: jest.fn(),
    retry: jest.fn(),
    markCompleted: jest.fn(),
    markFailed: jest.fn(),
    markDeadLetter: jest.fn(),
    retryEvent: jest.fn(),
  };
}

function createMockSyncService() {
  return {
    filterByAllowedAuthors: jest.fn().mockReturnValue([]),
  };
}

function createMockPrSyncService() {
  return {
    handleMergedPrAutoTransition: jest.fn(),
  };
}

function createMockConnection(): VcsConnectionWithProjectDomain {
  return {
    id: 'conn-1',
    projectId: 'project-1',
    provider: 'github',
    repoOwner: 'owner',
    repoName: 'repo',
    encryptedToken: 'enc-token',
    syncMode: 'webhook',
    allowedAuthors: '[]',
    pollingIntervalMs: 600000,
    webhookSecret: 'secret',
    lastSyncedAt: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    project: {
      id: 'project-1',
      key: 'TEST',
      slug: 'test-project',
    },
  };
}

function createPushPayload(overrides?: Partial<GitHubWebhookPayload>): GitHubWebhookPayload {
  return {
    action: '',
    repository: {
      id: 12345,
      full_name: 'owner/repo',
      name: 'repo',
      owner: { login: 'owner', id: 1 },
    },
    ref: 'refs/heads/main',
    commits: [
      {
        id: 'abc123def456',
        message: 'fix: resolve bug in component',
        timestamp: '2024-01-01T00:00:00Z',
        author: { name: 'Dev', email: 'dev@example.com', username: 'dev' },
        added: ['src/new.ts'],
        removed: [],
        modified: ['src/updated.ts'],
      },
    ],
    sender: { id: 1, login: 'dev', type: 'User' },
    ...overrides,
  };
}

function resolveOutboxEvent(overrides?: Partial<OutboxEventDomain>): OutboxEventDomain {
  return {
    id: 'outbox-evt-1',
    projectId: 'project-1',
    eventType: 'code_commit',
    eventId: 'abc123def456',
    payload: JSON.stringify({}),
    status: 'pending',
    attempts: 0,
    lastError: null,
    processedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildTestingModule(
  enqueueMock: jest.Mock,
  sharedEnqueuedEvents?: SharedEnqueuedEvent[],
) {
  return Test.createTestingModule({
    providers: [
      VcsWebhookService,
      { provide: VCS_REPOSITORY, useValue: createMockVcsRepository(sharedEnqueuedEvents) },
      { provide: VcsSyncService, useValue: createMockSyncService() },
      { provide: VcsPrSyncService, useValue: createMockPrSyncService() },
      { provide: OutboxService, useValue: createMockOutboxService(enqueueMock) },
      { provide: VCS_CFG, useValue: { encryptionKey: 'test-key', defaultPollingIntervalMs: 600000, githubApiUrl: 'https://api.github.com' } },
      { provide: VcsLinkExtractorService, useValue: { extractLinksFromPr: jest.fn() } },
    ],
  }).compile();
}

describe('VcsWebhookService', () => {
  describe('handlePush (via handleWebhook)', () => {
    let service: VcsWebhookService;
    let mockEnqueue: jest.Mock<Promise<OutboxEventDomain>, [OutboxEventInput]>;

    beforeEach(async () => {
      mockEnqueue = jest.fn().mockResolvedValue(resolveOutboxEvent());
      const module: TestingModule = await buildTestingModule(mockEnqueue);
      service = module.get<VcsWebhookService>(VcsWebhookService);
    });

    it('should enqueue a code_commit outbox event for each commit in the push payload', async () => {
      const connection = createMockConnection();
      const payload = createPushPayload({
        commits: [
          { id: 'commit-a', message: 'fix', timestamp: 't', author: { name: 'n', email: 'e' }, added: [], removed: [], modified: [] },
          { id: 'commit-b', message: 'feat', timestamp: 't', author: { name: 'n', email: 'e' }, added: [], removed: [], modified: [] },
        ],
      });

      await service.handleWebhook(connection, 'push', payload);

      expect(mockEnqueue).toHaveBeenCalledTimes(2);
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: connection.projectId,
          eventType: 'code_commit',
          eventId: 'commit-a',
          payload: expect.objectContaining({
            repoId: 'owner/repo',
            commitHash: 'commit-a',
            ref: 'refs/heads/main',
          }),
        }),
      );
      expect(mockEnqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: connection.projectId,
          eventType: 'code_commit',
          eventId: 'commit-b',
          payload: expect.objectContaining({
            repoId: 'owner/repo',
            commitHash: 'commit-b',
            ref: 'refs/heads/main',
          }),
        }),
      );
    });

    it('should skip commits within the 5-minute deduplication window', async () => {
      const connection = createMockConnection();
      const payload = createPushPayload({
        commits: [
          { id: 'commit-dup', message: 'm', timestamp: 't', author: { name: 'n', email: 'e' }, added: [], removed: [], modified: [] },
        ],
      });

      // First push — enqueues
      await service.handleWebhook(connection, 'push', payload);
      expect(mockEnqueue).toHaveBeenCalledTimes(1);

      // Second push within dedup window — should skip
      await service.handleWebhook(connection, 'push', payload);
      expect(mockEnqueue).toHaveBeenCalledTimes(1); // still 1
    });

    it('should NOT enqueue when DB dedup check throws — must not create duplicates when DB is unavailable', async () => {
      const connection = createMockConnection();
      const payload = createPushPayload({
        commits: [
          { id: 'commit-db-down', message: 'm', timestamp: 't', author: { name: 'n', email: 'e' }, added: [], removed: [], modified: [] },
        ],
      });

      // Simulate DB dedup check failure — findPendingOutboxEvents throws
      const repo = (service as unknown as { vcsRepo: { findPendingOutboxEvents: jest.Mock } }).vcsRepo;
      repo.findPendingOutboxEvents.mockRejectedValueOnce(new Error('DB connection timeout'));

      // SPEC: when DB dedup check fails, the handler must NOT fall through to enqueue.
      // If we cannot verify there is no duplicate, we must fail the request so the
      // provider retries later when the DB is available.
      let thrownError: unknown = null;
      try {
        await service.handleWebhook(connection, 'push', payload);
      } catch (e) {
        thrownError = e;
      }

      // The handler must NOT silently enqueue when the dedup check failed.
      // Either throw an error (so provider retries) or return failure.
      expect(mockEnqueue).not.toHaveBeenCalled();
      if (!thrownError) {
        // If no error was thrown, we expect the result to indicate failure
        // (non-2xx response so provider retries)
        fail('Expected HttpException or failure result when DB dedup check throws, but got neither');
      }
    });

    // Bug 1: recentCommitHashes is an unbounded in-memory Map that is never cleaned up.
    // Entries older than the 5-minute dedup window should be evicted so the Map
    // does not grow indefinitely on long-running server instances.
    it('should evict stale entries from the deduplication map after the 5-minute window expires', async () => {
      const connection = createMockConnection();

      const commit1 = { id: 'commit-1', message: 'm', timestamp: 't', author: { name: 'n', email: 'e' }, added: [], removed: [], modified: [] };
      const commit2 = { id: 'commit-2', message: 'm', timestamp: 't', author: { name: 'n', email: 'e' }, added: [], removed: [], modified: [] };
      const commit3 = { id: 'commit-3', message: 'm', timestamp: 't', author: { name: 'n', email: 'e' }, added: [], removed: [], modified: [] };

      let currentTime = 1700000000000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);

      // Enqueue two different commits at T0
      await service.handleWebhook(connection, 'push', createPushPayload({ commits: [commit1] }));
      await service.handleWebhook(connection, 'push', createPushPayload({ commits: [commit2] }));

      // Both entries should be stored in the dedup map
      const mapAfterInsert: Map<string, number> = (service as unknown as { recentCommitHashes: Map<string, number> }).recentCommitHashes;
      expect(mapAfterInsert.size).toBe(2);

      // Advance time beyond the 5-minute dedup window (T0 + 6 minutes)
      currentTime = 1700000000000 + 6 * 60 * 1000;

      // Enqueue a third commit at T0+6min — eviction of stale entries should occur
      await service.handleWebhook(connection, 'push', createPushPayload({ commits: [commit3] }));

      // Spec: entries older than the 5-minute window (commit-1, commit-2) must be evicted.
      // Only commit-3 (enqueued at T0+6min) should remain in the map.
      const mapAfterEviction: Map<string, number> = (service as unknown as { recentCommitHashes: Map<string, number> }).recentCommitHashes;
      expect(mapAfterEviction.size).toBeLessThan(3);

      nowSpy.mockRestore();
    });
  });
});

describe('VcsWebhookService — cross-instance deduplication', () => {
  const connection = createMockConnection();
  const sharedCommit = { id: 'cross-instance-commit', message: 'm', timestamp: 't', author: { name: 'n', email: 'e' }, added: [], removed: [], modified: [] };

  // Bug 2: recentCommitHashes is an in-memory Map local to a single VcsWebhookService instance.
  // In a multi-instance deployment, each pod has its own Map — deduplication is per-instance only.
  // A commit pushed to two different instances within the 5-min window will be enqueued twice.
  // Spec: deduplication must work across instances (backed by shared state, not local memory).
  it('should prevent duplicate outbox events when the same commit is processed by two separate service instances within the deduplication window', async () => {
    // Shared state simulating the outboxEvent DB table
    const sharedEvents: SharedEnqueuedEvent[] = [];

    // Instance 1 — simulates pod A
    const enqueue1 = jest.fn<Promise<OutboxEventDomain>, [OutboxEventInput]>().mockImplementation((event: OutboxEventInput) => {
      sharedEvents.push({
        eventId: event.eventId,
        eventType: event.eventType,
        projectId: event.projectId,
        createdAt: Date.now(),
      });
      return Promise.resolve(resolveOutboxEvent());
    });
    const module1 = await buildTestingModule(enqueue1, sharedEvents);
    const service1 = module1.get<VcsWebhookService>(VcsWebhookService);

    // Instance 2 — simulates pod B (fresh instance with its own in-memory Map)
    const enqueue2 = jest.fn<Promise<OutboxEventDomain>, [OutboxEventInput]>().mockResolvedValue(resolveOutboxEvent());
    const module2 = await buildTestingModule(enqueue2, sharedEvents);
    const service2 = module2.get<VcsWebhookService>(VcsWebhookService);

    const payload = createPushPayload({ commits: [sharedCommit] });

    // Instance 1 (pod A) processes the push
    const result1 = await service1.handleWebhook(connection, 'push', payload);
    expect(result1.success).toBe(true);
    expect(enqueue1).toHaveBeenCalledTimes(1);
    expect(enqueue1).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'code_commit',
        eventId: sharedCommit.id,
      }),
    );

    // Instance 2 (pod B) processes the same push independently.
    // It has its own Map and no access to instance 1's in-memory dedup state.
    const result2 = await service2.handleWebhook(connection, 'push', payload);

    // SPEC: Instance 2 must NOT enqueue because instance 1 already did within the same window.
    // The deduplication check relies on shared DB state (outboxEvent table), not local memory.
    expect(enqueue2).not.toHaveBeenCalled();
    expect(result2.ignored).toBe(true);
  });

  it('should not silently skip re-enqueue when previous event was consumed and a new push arrives within the dedup window', async () => {
    // Shared DB state simulating the outboxEvent table
    const sharedEvents: SharedEnqueuedEvent[] = [];

    const enqueueWithTracking = jest.fn<Promise<OutboxEventDomain>, [OutboxEventInput]>()
      .mockImplementation((event: OutboxEventInput) => {
        sharedEvents.push({
          eventId: event.eventId,
          eventType: event.eventType,
          projectId: event.projectId,
          createdAt: Date.now(),
        });
        return Promise.resolve(resolveOutboxEvent());
      });

    const module = await buildTestingModule(enqueueWithTracking, sharedEvents);
    const svc = module.get<VcsWebhookService>(VcsWebhookService);

    const connection = createMockConnection();
    const commitHash = 'commit-retry-after-consume';
    const payload = createPushPayload({
      commits: [
        { id: commitHash, message: 'm', timestamp: 't', author: { name: 'n', email: 'e' }, added: [], removed: [], modified: [] },
      ],
    });

    // First push — enqueues successfully, in-memory map gets the entry
    const result1 = await svc.handleWebhook(connection, 'push', payload);
    expect(result1.success).toBe(true);
    expect(enqueueWithTracking).toHaveBeenCalledTimes(1);
    expect(enqueueWithTracking).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'code_commit', eventId: commitHash }),
    );

    // Simulate: outbox processor consumes the event.
    // The DB row status changes to 'completed' — no longer 'pending' or 'processing'.
    // Clear sharedEvents so the DB dedup mock returns empty (no pending events in DB).
    sharedEvents.length = 0;

    // Second push of the SAME commitHash within 5-minute dedup window.
    // SPEC: Since the previous event was consumed (no longer pending/processing),
    // this should create a NEW outbox event. The DB dedup check would return
    // empty, so enqueue should proceed normally.
    const result2 = await svc.handleWebhook(connection, 'push', payload);

    expect(enqueueWithTracking).toHaveBeenCalledTimes(2);
    expect(result2.ignored).toBe(false);
  });

  it('should allow re-enqueue by a second instance after the first instance dedup window expires', async () => {
    // Verify the spec-correct flow: instance 1 enqueues, time passes > 5 min,
    // instance 2 is allowed to enqueue the same commitHash again.

    const enqueue1 = jest.fn<Promise<OutboxEventDomain>, [OutboxEventInput]>().mockResolvedValue(resolveOutboxEvent());
    const module1 = await buildTestingModule(enqueue1);
    const service1 = module1.get<VcsWebhookService>(VcsWebhookService);

    const enqueue2 = jest.fn<Promise<OutboxEventDomain>, [OutboxEventInput]>().mockResolvedValue(resolveOutboxEvent());
    const module2 = await buildTestingModule(enqueue2);
    const service2 = module2.get<VcsWebhookService>(VcsWebhookService);

    let currentTime = 1700000000000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);

    const payload = createPushPayload({ commits: [sharedCommit] });

    // Instance 1 enqueues at T0
    await service1.handleWebhook(connection, 'push', payload);
    expect(enqueue1).toHaveBeenCalledTimes(1);

    // Advance time beyond 5-minute window
    currentTime = 1700000000000 + 6 * 60 * 1000;

    // Instance 2 should be allowed to enqueue the same commit (not a duplicate — outside window)
    await service2.handleWebhook(connection, 'push', payload);
    expect(enqueue2).toHaveBeenCalledTimes(1);

    nowSpy.mockRestore();
  });
});
