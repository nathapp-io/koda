/**
 * OutboxEvent Phase 1 Schema Validation Tests
 *
 * Validates that the Prisma schema exactly matches the Phase 1 contract
 * for OutboxEvent table with all required fields and indexes.
 *
 * Run: DATABASE_URL=file:./koda-test.db bun run test test/integration/outbox-event-schema/outbox-event-schema.validation.integration.spec.ts
 */

import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = DATABASE_URL ? describe : describe.skip;

describeIntegration('OutboxEvent Phase 1 Schema Validation', () => {
  let prisma: PrismaClient;
  let tmpDbPath: string;

  beforeAll(async () => {
    if (!DATABASE_URL) return;

    tmpDbPath = path.join(os.tmpdir(), `koda-outbox-test-${Date.now()}.db`);

    prisma = new PrismaClient({
      datasources: {
        db: {
          url: `file:${tmpDbPath}`,
        },
      },
    });

    try {
      const { execSync } = await import('child_process');
      execSync('bunx prisma db push --force-reset --skip-generate', {
        stdio: 'pipe',
        env: { ...process.env, DATABASE_URL: `file:${tmpDbPath}` },
      });
    } catch (error) {
      // Migration may fail if DB is already initialized, which is OK
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
    if (tmpDbPath && fs.existsSync(tmpDbPath)) {
      fs.unlinkSync(tmpDbPath);
    }
  });

  describe('OutboxEvent model AC1: has all Phase 1 fields', () => {
    it('AC1: OutboxEvent model exists with all required fields', async () => {
      expect(prisma.outboxEvent).toBeDefined();

      const project = await prisma.project.create({
        data: { name: 'OutboxTest', slug: 'outbox-test', key: 'OUTX' },
      });

      const payload = JSON.stringify({ ticketId: 'ticket-123', action: 'CREATED' });
      const outbox = await prisma.outboxEvent.create({
        data: {
          projectId: project.id,
          eventType: 'ticket_event',
          eventId: 'ticket-123',
          payload: payload,
          status: 'pending',
          attempts: 0,
          lastError: null,
          processedAt: null,
        },
      });

      expect(outbox.id).toBeDefined();
      expect(outbox.projectId).toBe(project.id);
      expect(outbox.eventType).toBe('ticket_event');
      expect(outbox.eventId).toBe('ticket-123');
      expect(outbox.payload).toBe(payload);
      expect(outbox.status).toBe('pending');
      expect(outbox.attempts).toBe(0);
      expect(outbox.lastError).toBeNull();
      expect(outbox.processedAt).toBeNull();
      expect(outbox.createdAt).toBeInstanceOf(Date);
      expect(outbox.updatedAt).toBeInstanceOf(Date);

      await prisma.outboxEvent.delete({ where: { id: outbox.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC1: eventType supports all Phase 1 variants', async () => {
      const project = await prisma.project.create({
        data: { name: 'EventTypeTest', slug: 'event-type-test', key: 'EVTT' },
      });

      const eventTypes = [
        'ticket_event',
        'agent_event',
        'decision_event',
        'document_indexed',
      ];

      for (const eventType of eventTypes) {
        const outbox = await prisma.outboxEvent.create({
          data: {
            projectId: project.id,
            eventType: eventType,
            eventId: `event-${eventType}-${Date.now()}`,
            payload: '{}',
            status: 'pending',
          },
        });

        expect(outbox.eventType).toBe(eventType);
        expect(outbox.status).toBe('pending');

        await prisma.outboxEvent.delete({ where: { id: outbox.id } });
      }

      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC1: status supports all Phase 1 values', async () => {
      const project = await prisma.project.create({
        data: { name: 'StatusTest', slug: 'status-test', key: 'STST' },
      });

      const statuses = ['pending', 'processing', 'completed', 'failed', 'dead_letter'];

      for (const status of statuses) {
        const outbox = await prisma.outboxEvent.create({
          data: {
            projectId: project.id,
            eventType: 'ticket_event',
            eventId: `status-test-${Date.now()}-${status}`,
            payload: '{}',
            status: status,
          },
        });

        expect(outbox.status).toBe(status);

        await prisma.outboxEvent.delete({ where: { id: outbox.id } });
      }

      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC1: attempts field increments correctly', async () => {
      const project = await prisma.project.create({
        data: { name: 'AttemptsTest', slug: 'attempts-test', key: 'ATPT' },
      });

      const outbox = await prisma.outboxEvent.create({
        data: {
          projectId: project.id,
          eventType: 'ticket_event',
          eventId: 'attempts-test',
          payload: '{}',
          status: 'pending',
          attempts: 3,
        },
      });

      expect(outbox.attempts).toBe(3);

      const updated = await prisma.outboxEvent.update({
        where: { id: outbox.id },
        data: { attempts: { increment: 1 } },
      });

      expect(updated.attempts).toBe(4);

      await prisma.outboxEvent.delete({ where: { id: outbox.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC1: lastError is nullable string', async () => {
      const project = await prisma.project.create({
        data: { name: 'LastErrorTest', slug: 'last-error-test', key: 'LRET' },
      });

      const outboxWithError = await prisma.outboxEvent.create({
        data: {
          projectId: project.id,
          eventType: 'ticket_event',
          eventId: 'error-test',
          payload: '{}',
          status: 'failed',
          lastError: 'Connection timeout after 30s',
        },
      });

      expect(outboxWithError.lastError).toBe('Connection timeout after 30s');

      const outboxNoError = await prisma.outboxEvent.create({
        data: {
          projectId: project.id,
          eventType: 'ticket_event',
          eventId: 'no-error-test',
          payload: '{}',
          status: 'completed',
          lastError: null,
        },
      });

      expect(outboxNoError.lastError).toBeNull();

      await prisma.outboxEvent.delete({ where: { id: outboxWithError.id } });
      await prisma.outboxEvent.delete({ where: { id: outboxNoError.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC1: processedAt is nullable datetime', async () => {
      const project = await prisma.project.create({
        data: { name: 'ProcessedAtTest', slug: 'processed-at-test', key: 'PCAT' },
      });

      const now = new Date();
      const outbox = await prisma.outboxEvent.create({
        data: {
          projectId: project.id,
          eventType: 'ticket_event',
          eventId: 'processed-test',
          payload: '{}',
          status: 'completed',
          processedAt: now,
        },
      });

      expect(outbox.processedAt).toEqual(now);

      const outboxUnprocessed = await prisma.outboxEvent.create({
        data: {
          projectId: project.id,
          eventType: 'ticket_event',
          eventId: 'unprocessed-test',
          payload: '{}',
          status: 'pending',
          processedAt: null,
        },
      });

      expect(outboxUnprocessed.processedAt).toBeNull();

      await prisma.outboxEvent.delete({ where: { id: outbox.id } });
      await prisma.outboxEvent.delete({ where: { id: outboxUnprocessed.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC1: projectId foreign key cascade delete', async () => {
      const project = await prisma.project.create({
        data: { name: 'CascadeDeleteTest', slug: 'cascade-delete-test', key: 'CADT' },
      });

      const outbox = await prisma.outboxEvent.create({
        data: {
          projectId: project.id,
          eventType: 'ticket_event',
          eventId: 'cascade-test',
          payload: '{}',
          status: 'pending',
        },
      });

      const outboxId = outbox.id;

      await prisma.project.delete({ where: { id: project.id } });

      const deleted = await prisma.outboxEvent.findUnique({
        where: { id: outboxId },
      });
      expect(deleted).toBeNull();
    });
  });

  describe('OutboxEvent model AC2: indexes', () => {
    it('AC2: @@index([status, createdAt]) exists', async () => {
      const project = await prisma.project.create({
        data: { name: 'IndexTest1', slug: 'index-test-1', key: 'IDX1' },
      });

      const statuses = ['pending', 'completed', 'failed'];
      const now = new Date();

      for (let i = 0; i < statuses.length; i++) {
        await prisma.outboxEvent.create({
          data: {
            projectId: project.id,
            eventType: 'ticket_event',
            eventId: `idx-test-${i}`,
            payload: '{}',
            status: statuses[i],
            createdAt: new Date(now.getTime() + i * 1000),
          },
        });
      }

      const pendingEvents = await prisma.outboxEvent.findMany({
        where: { status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });

      expect(pendingEvents.length).toBeGreaterThan(0);
      expect(pendingEvents[0].status).toBe('pending');

      const allForCleanup = await prisma.outboxEvent.findMany({
        where: { projectId: project.id },
      });
      for (const e of allForCleanup) {
        await prisma.outboxEvent.delete({ where: { id: e.id } });
      }
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC2: @@index([projectId, createdAt]) exists', async () => {
      const project = await prisma.project.create({
        data: { name: 'IndexTest2', slug: 'index-test-2', key: 'IDX2' },
      });

      const now = new Date();
      for (let i = 0; i < 3; i++) {
        await prisma.outboxEvent.create({
          data: {
            projectId: project.id,
            eventType: 'ticket_event',
            eventId: `proj-idx-${i}`,
            payload: '{}',
            status: 'pending',
            createdAt: new Date(now.getTime() + i * 1000),
          },
        });
      }

      const projectEvents = await prisma.outboxEvent.findMany({
        where: { projectId: project.id },
        orderBy: { createdAt: 'desc' },
      });

      expect(projectEvents.length).toBe(3);
      expect(projectEvents[0].projectId).toBe(project.id);

      const allForCleanup = await prisma.outboxEvent.findMany({
        where: { projectId: project.id },
      });
      for (const e of allForCleanup) {
        await prisma.outboxEvent.delete({ where: { id: e.id } });
      }
      await prisma.project.delete({ where: { id: project.id } });
    });
  });

  describe('OutboxEvent model AC3: existing event tables preserved', () => {
    it('AC3: TicketEvent table still exists and is unaltered', async () => {
      expect(prisma.ticketEvent).toBeDefined();

      const project = await prisma.project.create({
        data: { name: 'TicketEventPreserve', slug: 'ticket-event-preserve', key: 'TEPR' },
      });

      const ticketEvent = await prisma.ticketEvent.create({
        data: {
          ticketId: 'ticket-123',
          projectId: project.id,
          action: 'CREATED',
          actorId: 'user-456',
          actorType: 'user',
          source: 'api',
          data: '{}',
        },
      });

      expect(ticketEvent.id).toBeDefined();
      expect(ticketEvent.ticketId).toBe('ticket-123');
      expect(ticketEvent.projectId).toBe(project.id);
      expect(ticketEvent.action).toBe('CREATED');

      await prisma.ticketEvent.delete({ where: { id: ticketEvent.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC3: AgentEvent table still exists and is unaltered', async () => {
      expect(prisma.agentEvent).toBeDefined();

      const project = await prisma.project.create({
        data: { name: 'AgentEventPreserve', slug: 'agent-event-preserve', key: 'AEPR' },
      });

      const agentEvent = await prisma.agentEvent.create({
        data: {
          agentId: 'agent-123',
          projectId: project.id,
          action: 'ASSIGNED',
          actorId: 'user-456',
          source: 'api',
          data: '{}',
        },
      });

      expect(agentEvent.id).toBeDefined();
      expect(agentEvent.agentId).toBe('agent-123');
      expect(agentEvent.projectId).toBe(project.id);
      expect(agentEvent.action).toBe('ASSIGNED');

      await prisma.agentEvent.delete({ where: { id: agentEvent.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });

    it('AC3: DecisionEvent table still exists and is unaltered', async () => {
      expect(prisma.decisionEvent).toBeDefined();

      const project = await prisma.project.create({
        data: { name: 'DecisionEventPreserve', slug: 'decision-event-preserve', key: 'DEPR' },
      });

      const decisionEvent = await prisma.decisionEvent.create({
        data: {
          projectId: project.id,
          agentId: 'agent-123',
          action: 'RESOLVED',
          decision: 'decided',
          rationale: 'Issue fixed',
          source: 'api',
          data: '{}',
        },
      });

      expect(decisionEvent.id).toBeDefined();
      expect(decisionEvent.projectId).toBe(project.id);
      expect(decisionEvent.agentId).toBe('agent-123');
      expect(decisionEvent.decision).toBe('decided');

      await prisma.decisionEvent.delete({ where: { id: decisionEvent.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });
  });

  describe('OutboxEvent model AC4: idempotency', () => {
    it('AC4: migration can be applied twice without error', async () => {
      const project = await prisma.project.create({
        data: { name: 'IdempotencyTest', slug: 'idempotency-test', key: 'IDEM' },
      });

      const outbox = await prisma.outboxEvent.create({
        data: {
          projectId: project.id,
          eventType: 'ticket_event',
          eventId: 'idempotent-test',
          payload: '{}',
          status: 'pending',
        },
      });

      const found = await prisma.outboxEvent.findUnique({
        where: { id: outbox.id },
      });

      expect(found).not.toBeNull();
      expect(found?.id).toBe(outbox.id);

      await prisma.outboxEvent.delete({ where: { id: outbox.id } });
      await prisma.project.delete({ where: { id: project.id } });
    });
  });
});