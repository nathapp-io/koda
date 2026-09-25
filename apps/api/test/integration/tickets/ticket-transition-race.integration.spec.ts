/**
 * M3 — Transition check-then-act race integration test
 *
 * Concurrent verify and reject on the same ticket must not both commit.
 * The status validation happens outside the transaction, so the write must
 * be conditional (updateTicketStatusIf keyed on the pre-read status) and the
 * loser must fail with 409 — not double-commit.
 *
 * Run: cd apps/api && bunx jest test/integration/tickets/ticket-transition-race.integration.spec.ts
 *
 * Bootstraps a Nest testing module with the REAL PrismaClient against
 * DATABASE_URL (see test/global-setup.ts / test/helpers/reset-db.ts) and the
 * REAL PrismaTransactionManager (PrismaModule transaction: true), so the
 * loser's transaction (comment + activity writes) actually rolls back.
 *
 * Note on seeding: verify is CREATED→VERIFIED and reject is CREATED|VERIFIED→
 * REJECTED, so the only status where BOTH are valid is CREATED — that is what
 * we seed. On SQLite writes serialize, so the race cannot always manifest
 * naturally; a barrier on updateTicketStatusIf forces both writers to arrive
 * at the write phase with stale reads, pinning the conditional-update
 * contract deterministically: the loser gets 409, never a double commit.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { TicketTransitionsService } from '../../../src/tickets/state-machine/ticket-transitions.service';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { TICKET_REPOSITORY } from '../../../src/tickets/domain/ticket.domain';
import type { KodaPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('M3 ticket transition race (verify vs reject)', () => {
  let module: TestingModule;
  let transitionsService: TicketTransitionsService;
  let repo: PrismaTicketsRepository;
  let prisma: PrismaService<PrismaClient>;

  let principal: KodaPrincipal;
  let ticketId: string;
  let ticketRef: string;

  beforeAll(async () => {
    await resetDb();

    module = await Test.createTestingModule({
      imports: [
        // Real module wiring: patched client proxy + shared ALS + real
        // PrismaTransactionManager, exactly as app.module.ts configures it.
        PrismaModule.forRoot({
          client: PrismaClient,
          transaction: true,
          clientOptions: { datasources: { db: { url: DATABASE_URL } } },
        }),
      ],
      providers: [
        TicketTransitionsService,
        PrismaTicketsRepository,
        { provide: TICKET_REPOSITORY, useExisting: PrismaTicketsRepository },
      ],
    }).compile();

    transitionsService = module.get<TicketTransitionsService>(TicketTransitionsService);
    repo = module.get<PrismaTicketsRepository>(PrismaTicketsRepository);
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.onModuleInit();

    // Comment.authorUserId has an FK to User — seed the actor.
    const user = await prisma.client.user.create({
      data: {
        id: 'user-race-1',
        email: 'race@example.com',
        passwordHash: 'hash',
      },
    });
    principal = {
      id: user.id,
      sub: user.id,
      actorType: 'user' as const,
      role: 'MEMBER' as const,
      email: 'race@example.com',
      blacklisted: false,
      revoked: false,
      authorities: [] as string[],
      name: 'Race Tester',
    } as KodaPrincipal;

    const project = await prisma.client.project.create({
      data: { name: 'Race Project', slug: 'proj-race', key: 'KDA' },
    });

    // CREATED is the only status where both verify and reject are valid.
    const ticket = await prisma.client.ticket.create({
      data: {
        projectId: project.id,
        number: 1,
        type: 'BUG',
        title: 'Race ticket one',
        status: 'CREATED',
        priority: 'MEDIUM',
      },
    });
    ticketId = ticket.id;
    ticketRef = 'KDA-1';
  });

  afterAll(async () => {
    await prisma?.onModuleDestroy();
  });

  it('concurrent verify + reject: exactly one 2xx, one 409, no double commit', async () => {    // Barrier on the READ phase: hold both callers until both reads have
    // COMPLETED, guaranteeing both transitions act on the same stale status
    // even though SQLite serializes writes. (Gating the write phase instead
    // deadlocks: the loser's open transaction holds SQLite's write lock while
    // the winner waits for a connection.) Both writes then race on the
    // conditional update: first commits, second matches 0 rows → 409.
    const original = repo.findTicketByRefRaw.bind(repo);
    let completed = 0;
    jest.spyOn(repo, 'findTicketByRefRaw').mockImplementation(async (...args) => {
      const result = await original(...args);
      completed++;
      while (completed < 2) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return result;
    });

    const [verifyResult, rejectResult] = await Promise.allSettled([
      transitionsService.verify('proj-race', ticketRef, 'looks fine', principal),
      transitionsService.reject('proj-race', ticketRef, 'not valid', principal),
    ]);

    // Restore before assertions so later tests are unaffected.
    jest.restoreAllMocks();

    const settled: PromiseSettledResult<unknown>[] = [verifyResult, rejectResult];
    const fulfilled = settled.filter(
      (r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled',
    );
    const rejected = settled.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    // Exactly one winner and one loser.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser is a 409 conflict — not a validation error, not a crash.
    const reason = rejected[0].reason;
    expect(reason).toBeInstanceOf(HttpException);
    expect((reason as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
    expect((reason as HttpException).message).toBe('Ticket state changed concurrently');

    // Final status matches the winner's target (VERIFIED or REJECTED), and
    // only one transition committed.
    const finalTicket = await prisma.client.ticket.findUnique({ where: { id: ticketId } });
    const winner = fulfilled[0].value as { ticket: { status: string } };
    expect(winner.ticket.status).toBe(finalTicket?.status);
    expect(['VERIFIED', 'REJECTED']).toContain(finalTicket?.status);

    // The loser's transaction rolled back: exactly one activity, one comment.
    const activities = await prisma.client.ticketActivity.findMany({ where: { ticketId } });
    expect(activities).toHaveLength(1);
    expect(activities[0].toStatus).toBe(finalTicket?.status);
    const comments = await prisma.client.comment.findMany({ where: { ticketId } });
    expect(comments).toHaveLength(1);
  });

  it('sequential transitions from a stale status also 409 (contract pin)', async () => {
    // A second transition attempt against the already-transitioned ticket:
    // the loser path exercised deterministically without concurrency —
    // start() from a status that no longer matches would be a 400 (state
    // machine), but a raw conditional update against a moved row is null.
    const result = await repo.updateTicketStatusIf(ticketId, 'CREATED', 'REJECTED');
    expect(result).toBeNull();
  });
});
