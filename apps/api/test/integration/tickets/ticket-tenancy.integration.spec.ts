/**
 * H5 — Ticket tenancy integration tests
 *
 * Tickets resolved by ref (CUID or KEY-N) must be strictly project-scoped,
 * and transitions must reject soft-deleted tickets:
 *   AC-1: cross-project CUID ref → 404 on GET
 *   AC-2: cross-project CUID ref → 404 on transition (close)
 *   AC-3: soft-deleted ticket → 404 on transition (close)
 *   AC-4: foreign KEY prefix (OTHER-5) → 404 even when the project has #5
 *
 * Run: cd apps/api && bunx jest test/integration/tickets/ticket-tenancy.integration.spec.ts
 *
 * Bootstraps a Nest testing module with the REAL PrismaClient against
 * DATABASE_URL (see test/global-setup.ts / test/helpers/reset-db.ts) and
 * exercises the service layer (TicketsService.findByRef,
 * TicketTransitionsService.close) exactly as the controller would.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { NotFoundAppException } from '@nathapp/nestjs-common';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { TicketTransitionsService } from '../../../src/tickets/state-machine/ticket-transitions.service';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { TICKET_REPOSITORY } from '../../../src/tickets/domain/ticket.domain';
import { TicketLinksService } from '../../../src/ticket-links/ticket-links.service';
import { PrismaTicketLinkRepository } from '../../../src/ticket-links/prisma-ticket-link.repository';
import { TicketEventService } from '../../../src/events/ticket-event.service';
import { OutboxService } from '@nathapp/nestjs-outbox';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('H5 ticket tenancy', () => {
  let module: TestingModule;
  let ticketsService: TicketsService;
  let transitionsService: TicketTransitionsService;
  let ticketLinksService: TicketLinksService;
  let prisma: PrismaService<PrismaClient>;

  const principal = {
    id: 'user-tenancy-1',
    sub: 'user-tenancy-1',
    actorType: 'user' as const,
    role: 'MEMBER' as const,
    email: 'tenancy@example.com',
    blacklisted: false,
    revoked: false,
    authorities: [] as string[],
    name: 'Tenancy Tester',
  } as KodaPrincipal;

  let projectAId: string;
  let projectBId: string;
  let ticketA5Id: string; // project A #5 (for the OTHER-5 test)
  let ticketBId: string; // project B ticket, IN_PROGRESS (transitionable)
  let deletedTicketBId: string; // project B ticket, soft-deleted, IN_PROGRESS

  beforeAll(async () => {
    await resetDb();

    module = await Test.createTestingModule({
      providers: [
        TicketsService,
        TicketTransitionsService,
        PrismaTicketsRepository,
        { provide: TICKET_REPOSITORY, useExisting: PrismaTicketsRepository },
        TicketLinksService,
        PrismaTicketLinkRepository,
        {
          provide: PrismaService,
          useFactory: () =>
            new PrismaService({
              client: PrismaClient,
              clientOptions: { datasources: { db: { url: DATABASE_URL } } },
            }),
        },
        {
          // Real repositories against the real DB; transactions run inline.
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: jest.fn((fn: () => Promise<unknown>) => fn()),
            getClient: jest.fn(),
            isInTransaction: jest.fn(() => false),
          },
        },
        { provide: TicketEventService, useValue: { create: jest.fn().mockResolvedValue({ id: 'evt-1' }) } },
        { provide: OutboxService, useValue: { record: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    ticketsService = module.get<TicketsService>(TicketsService);
    transitionsService = module.get<TicketTransitionsService>(TicketTransitionsService);
    ticketLinksService = module.get<TicketLinksService>(TicketLinksService);
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.onModuleInit();

    // Seed: project A (key=KDA), project B (key=KDB).
    const projectA = await prisma.client.project.create({
      data: { name: 'Project A', slug: 'proj-a', key: 'KDA' },
    });
    const projectB = await prisma.client.project.create({
      data: { name: 'Project B', slug: 'proj-b', key: 'KDB' },
    });
    projectAId = projectA.id;
    projectBId = projectB.id;

    // Project A has its own ticket #5 (transitionable target of OTHER-5).
    const ticketA5 = await prisma.client.ticket.create({
      data: {
        projectId: projectAId,
        number: 5,
        type: 'BUG',
        title: 'A ticket five',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
      },
    });
    ticketA5Id = ticketA5.id;

    // Project B ticket reachable only from B; IN_PROGRESS so an unscoped
    // close() would succeed — making the 404 assertions meaningful.
    const ticketB = await prisma.client.ticket.create({
      data: {
        projectId: projectBId,
        number: 1,
        type: 'BUG',
        title: 'B ticket one',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
      },
    });
    ticketBId = ticketB.id;

    const deletedTicketB = await prisma.client.ticket.create({
      data: {
        projectId: projectBId,
        number: 2,
        type: 'BUG',
        title: 'B ticket deleted',
        status: 'IN_PROGRESS',
        priority: 'MEDIUM',
        deletedAt: new Date(),
      },
    });
    deletedTicketBId = deletedTicketB.id;
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  it('AC-1: cross-project CUID ref → 404 on GET, while it resolves inside its own project', async () => {
    // The same CUID against its own project resolves (positive control).
    const own = await ticketsService.findByRef('proj-b', ticketBId);
    expect(own.id).toBe(ticketBId);

    // Against project A it must be a uniform 404.
    await expect(ticketsService.findByRef('proj-a', ticketBId)).rejects.toThrow(
      NotFoundAppException,
    );
  });

  it('AC-2: cross-project CUID transition → 404 on A, while it succeeds inside B', async () => {
    // Cross-project close must be a 404, not a silent success on B's ticket
    // (ticketB is IN_PROGRESS, so an unscoped close would succeed here).
    await expect(
      transitionsService.close('proj-a', ticketBId, principal),
    ).rejects.toThrow(NotFoundAppException);

    // Positive control: the ticket is transitionable in its own project.
    await transitionsService.close('proj-b', ticketBId, principal);
    const closed = await prisma.client.ticket.findUnique({ where: { id: ticketBId } });
    expect(closed?.status).toBe('CLOSED');
  });

  it('AC-3: soft-deleted ticket transition → 404', async () => {
    // deletedTicketBId is IN_PROGRESS but soft-deleted: an unscoped
    // findUnique would resolve it and close() would succeed.
    await expect(
      transitionsService.close('proj-b', deletedTicketBId, principal),
    ).rejects.toThrow(NotFoundAppException);
  });

  it('AC-4: foreign KEY prefix (OTHER-5) → 404 even when A has #5', async () => {
    // Project A owns KDA-5 (positive control).
    const own = await ticketsService.findByRef('proj-a', 'KDA-5');
    expect(own.id).toBe(ticketA5Id);

    // A foreign prefix must not fall through to "project A's ticket #5".
    await expect(ticketsService.findByRef('proj-a', 'OTHER-5')).rejects.toThrow(
      NotFoundAppException,
    );
  });

  it('AC-5: foreign KEY prefix on ticket-links endpoints → 404 even when A has #5', async () => {
    // Positive control: links endpoints resolve KDA-5 normally.
    await expect(ticketLinksService.findByTicket('proj-a', 'KDA-5')).resolves.toEqual([]);

    // The same foreign prefix must 404 on links endpoints too — an unscoped
    // number lookup would have resolved project A's own #5.
    await expect(
      ticketLinksService.findByTicket('proj-a', 'OTHER-5'),
    ).rejects.toThrow(NotFoundAppException);
    await expect(
      ticketLinksService.create('proj-a', 'OTHER-5', {
        url: 'https://github.com/owner/repo/pull/1',
      }),
    ).rejects.toThrow(NotFoundAppException);
    await expect(
      ticketLinksService.remove('proj-a', 'OTHER-5', 'link-xyz'),
    ).rejects.toThrow(NotFoundAppException);
  });

  it('smoke: seeded state is consistent (A does not own B tickets)', () => {
    expect(ticketA5Id).not.toBe(ticketBId);
    expect(projectAId).not.toBe(projectBId);
  });
});
