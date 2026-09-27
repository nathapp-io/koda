/**
 * US-004: KodaDomainWriter derives a user actor's project roles from membership.
 *
 * Acceptance Criteria:
 * 12. writeTicketEvent throws ForbiddenAppException for a non-ADMIN user actor
 *     with no ProjectMember row even when payload actorRole is 'ADMIN'.
 * 13. writeTicketEvent succeeds for a user actor with ProjectMember.role
 *     DEVELOPER and no payload role.
 * 14. writeTicketEvent succeeds for a global ADMIN user actor with no membership row.
 *
 * The first block drives the writer through the REAL
 * `PrismaKodaDomainWriterRepository` (the new
 * `findUserProjectRoles(projectId, userId)` data source) against a mocked
 * Prisma client, so the roles really are read from `User.role` /
 * `ProjectMember.role`. The second block pins that data source's contract at
 * the writer boundary.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { KodaDomainWriter } from '../../../src/koda-domain-writer/koda-domain-writer.service';
import { PrismaKodaDomainWriterRepository } from '../../../src/koda-domain-writer/prisma-koda-domain-writer.repository';
import { RagService } from '../../../src/rag/rag.service';
import { AgentAuthProvider } from '../../../src/auth/agent-auth.provider';
import { TicketEventService } from '../../../src/events/ticket-event.service';
import { AgentEventService } from '../../../src/events/agent-event.service';
import { DecisionEventService } from '../../../src/events/decision-event.service';
import type { WriteTicketEventInput } from '../../../src/koda-domain-writer/write-result.dto';

const PROJECT_ID = 'proj-123';
const USER_ID = 'user-1';

/** The rejection of `promise`, or undefined when it resolved. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

function ticketEvent(
  data: Partial<WriteTicketEventInput> & Pick<WriteTicketEventInput, 'actorId' | 'actorType'>,
): WriteTicketEventInput {
  return {
    ticketId: 'ticket-1',
    projectId: PROJECT_ID,
    action: 'TICKET_CREATED',
    source: 'api',
    data: {},
    ...data,
  };
}

describe('US-004: KodaDomainWriter role provenance', () => {
  // ── AC 12/13/14 through the real repository ────────────────────────────────

  describe('roles read from the database', () => {
    let writer: KodaDomainWriter;
    let moduleRef: TestingModule;

    const prismaMock = {
      client: {
        project: { findUnique: jest.fn() },
        user: { findUnique: jest.fn(), findFirst: jest.fn() },
        projectMember: { findUnique: jest.fn(), findFirst: jest.fn() },
      },
    };

    const ticketEventService = { create: jest.fn() };
    const outbox = { record: jest.fn() };

    /** Wire the mocked Prisma client for one global role + one membership role. */
    function givenUser(globalRole: string, membershipRole: string | null): void {
      const membership =
        membershipRole === null
          ? null
          : { id: 'membership-1', projectId: PROJECT_ID, userId: USER_ID, role: membershipRole };

      prismaMock.client.project.findUnique.mockResolvedValue({ id: PROJECT_ID, deletedAt: null });
      prismaMock.client.user.findUnique.mockResolvedValue({
        id: USER_ID,
        role: globalRole,
        memberships: membership ? [membership] : [],
      });
      prismaMock.client.user.findFirst.mockResolvedValue({
        id: USER_ID,
        role: globalRole,
        memberships: membership ? [membership] : [],
      });
      prismaMock.client.projectMember.findFirst.mockResolvedValue(membership);
      prismaMock.client.projectMember.findUnique.mockResolvedValue(membership);
    }

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        providers: [
          KodaDomainWriter,
          PrismaKodaDomainWriterRepository,
          { provide: PrismaService, useValue: prismaMock },
          {
            provide: RagService,
            useValue: { indexDocument: jest.fn(), importGraphify: jest.fn() },
          },
          { provide: NathappOutboxService, useValue: outbox },
          {
            provide: TRANSACTION_MANAGER,
            useValue: {
              run: jest.fn((fn: () => Promise<unknown>) => fn()),
              getClient: jest.fn(),
              isInTransaction: jest.fn(() => false),
            },
          },
          {
            provide: AgentAuthProvider,
            useValue: { loadAgentRoles: jest.fn().mockResolvedValue(['AGENT']) },
          },
          { provide: TicketEventService, useValue: ticketEventService },
          { provide: AgentEventService, useValue: { create: jest.fn() } },
          { provide: DecisionEventService, useValue: { create: jest.fn() } },
        ],
      }).compile();

      writer = moduleRef.get<KodaDomainWriter>(KodaDomainWriter);
    });

    afterAll(async () => {
      await moduleRef?.close();
    });

    beforeEach(() => {
      jest.clearAllMocks();
      ticketEventService.create.mockResolvedValue({
        id: 'event-1',
        action: 'TICKET_CREATED',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      });
      outbox.record.mockResolvedValue(undefined);
    });

    it('AC12: throws ForbiddenAppException for a non-ADMIN user actor with no ProjectMember row, even when payload actorRole is ADMIN', async () => {
      givenUser('MEMBER', null);

      const error = await rejectionOf(
        writer.writeTicketEvent(
          ticketEvent({ actorId: USER_ID, actorType: 'user', data: { actorRole: 'ADMIN' } }),
        ),
      );

      expect(error).toBeInstanceOf(ForbiddenAppException);
    });

    it('AC12: writes no event for a non-ADMIN user actor with no ProjectMember row', async () => {
      givenUser('MEMBER', null);

      await rejectionOf(
        writer.writeTicketEvent(
          ticketEvent({ actorId: USER_ID, actorType: 'user', data: { actorRole: 'ADMIN' } }),
        ),
      );

      expect(ticketEventService.create).not.toHaveBeenCalled();
      expect(outbox.record).not.toHaveBeenCalled();
    });

    it('AC12: ignores a payload role field for a non-ADMIN user actor with no ProjectMember row', async () => {
      givenUser('MEMBER', null);

      const error = await rejectionOf(
        writer.writeTicketEvent(
          ticketEvent({ actorId: USER_ID, actorType: 'user', data: { role: 'DEVELOPER' } }),
        ),
      );

      expect(error).toBeInstanceOf(ForbiddenAppException);
    });

    it('AC13: succeeds for a user actor with ProjectMember.role DEVELOPER and no payload role', async () => {
      givenUser('MEMBER', 'DEVELOPER');

      await expect(
        writer.writeTicketEvent(ticketEvent({ actorId: USER_ID, actorType: 'user', data: {} })),
      ).resolves.toMatchObject({ canonicalId: 'event-1' });
      expect(ticketEventService.create).toHaveBeenCalled();
    });

    it('AC14: succeeds for a global ADMIN user actor with no membership row', async () => {
      givenUser('ADMIN', null);

      await expect(
        writer.writeTicketEvent(ticketEvent({ actorId: USER_ID, actorType: 'user', data: {} })),
      ).resolves.toMatchObject({ canonicalId: 'event-1' });
      expect(ticketEventService.create).toHaveBeenCalled();
    });

    it('still loads agent roles through AgentAuthProvider for agent actors', async () => {
      const agentAuthProvider = moduleRef.get<{ loadAgentRoles: jest.Mock }>(AgentAuthProvider);
      prismaMock.client.project.findUnique.mockResolvedValue({ id: PROJECT_ID, deletedAt: null });

      await expect(
        writer.writeTicketEvent(ticketEvent({ actorId: 'agent-1', actorType: 'agent', data: {} })),
      ).resolves.toMatchObject({ canonicalId: 'event-1' });

      expect(agentAuthProvider.loadAgentRoles).toHaveBeenCalledWith('agent-1');
      expect(prismaMock.client.projectMember.findFirst).not.toHaveBeenCalled();
      expect(prismaMock.client.projectMember.findUnique).not.toHaveBeenCalled();
    });
  });

  // ── The repository contract the ACs name ──────────────────────────────────

  describe('PrismaKodaDomainWriterRepository.findUserProjectRoles contract', () => {
    let writer: KodaDomainWriter;
    let moduleRef: TestingModule;

    const writerRepo = {
      findProjectById: jest.fn(),
      findUserProjectRoles: jest.fn(),
    };

    const ticketEventService = { create: jest.fn() };
    const outbox = { record: jest.fn() };

    beforeAll(async () => {
      moduleRef = await Test.createTestingModule({
        providers: [
          KodaDomainWriter,
          { provide: PrismaKodaDomainWriterRepository, useValue: writerRepo },
          {
            provide: RagService,
            useValue: { indexDocument: jest.fn(), importGraphify: jest.fn() },
          },
          { provide: NathappOutboxService, useValue: outbox },
          {
            provide: TRANSACTION_MANAGER,
            useValue: {
              run: jest.fn((fn: () => Promise<unknown>) => fn()),
              getClient: jest.fn(),
              isInTransaction: jest.fn(() => false),
            },
          },
          {
            provide: AgentAuthProvider,
            useValue: { loadAgentRoles: jest.fn().mockResolvedValue(['AGENT']) },
          },
          { provide: TicketEventService, useValue: ticketEventService },
          { provide: AgentEventService, useValue: { create: jest.fn() } },
          { provide: DecisionEventService, useValue: { create: jest.fn() } },
        ],
      }).compile();

      writer = moduleRef.get<KodaDomainWriter>(KodaDomainWriter);
    });

    afterAll(async () => {
      await moduleRef?.close();
    });

    beforeEach(() => {
      jest.clearAllMocks();
      writerRepo.findProjectById.mockResolvedValue({ id: PROJECT_ID });
      ticketEventService.create.mockResolvedValue({
        id: 'event-1',
        action: 'TICKET_CREATED',
        timestamp: new Date('2026-01-01T00:00:00.000Z'),
      });
      outbox.record.mockResolvedValue(undefined);
    });

    it('AC13: asks the repository for the actor’s roles in the event’s project', async () => {
      writerRepo.findUserProjectRoles.mockResolvedValue(['DEVELOPER']);

      await expect(
        writer.writeTicketEvent(ticketEvent({ actorId: USER_ID, actorType: 'user', data: {} })),
      ).resolves.toMatchObject({ canonicalId: 'event-1' });

      expect(writerRepo.findUserProjectRoles).toHaveBeenCalledWith(PROJECT_ID, USER_ID);
    });

    it('AC13: a repository result of [] forbids the user actor', async () => {
      writerRepo.findUserProjectRoles.mockResolvedValue([]);

      const error = await rejectionOf(
        writer.writeTicketEvent(ticketEvent({ actorId: USER_ID, actorType: 'user', data: {} })),
      );

      expect(error).toBeInstanceOf(ForbiddenAppException);
    });

    it('AC14: a repository result containing ADMIN allows the user actor', async () => {
      writerRepo.findUserProjectRoles.mockResolvedValue(['ADMIN']);

      await expect(
        writer.writeTicketEvent(ticketEvent({ actorId: USER_ID, actorType: 'user', data: {} })),
      ).resolves.toMatchObject({ canonicalId: 'event-1' });
    });
  });
});
