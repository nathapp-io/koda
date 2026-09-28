/**
 * Track 3 Slice 4 (M12): the conditional prState write on real Postgres.
 * `merged` never changes; NULL and non-terminal states still update.
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/vcs/pr-state-merged-terminal.integration.spec.ts
 */
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaVcsRepository } from '../../../src/vcs/prisma-vcs.repository';
import { resetDb } from '../../helpers/reset-db';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaVcsRepository.updateTicketLinkWithPrState (M12)', () => {
  jest.setTimeout(20000);
  let prismaService: PrismaService<PrismaClient>;
  let prisma: PrismaClient;
  let repo: PrismaVcsRepository;
  let ticketId: string;
  let counter = 0;

  const makeLink = async (prState: string | null) =>
    prisma.ticketLink.create({
      data: {
        ticketId,
        url: `https://github.com/acme/widgets/pull/${++counter}`,
        provider: 'github',
        linkType: 'pr',
        prNumber: counter,
        prState,
        prUpdatedAt: new Date('2026-01-01T00:00:00Z'),
      },
    });

  beforeAll(async () => {
    if (!DATABASE_URL) return;
    await resetDb(DATABASE_URL);
    prismaService = new PrismaService({
      client: PrismaClient,
      clientOptions: { datasources: { db: { url: DATABASE_URL } } },
    });
    await prismaService.onModuleInit();
    prisma = prismaService.client;
    const txManager: ITransactionManager = {
      run: <T>(fn: () => Promise<T>): Promise<T> => fn(),
      getClient: <C = unknown>(): C => prisma as unknown as C,
      isInTransaction: () => false,
    };
    repo = new PrismaVcsRepository(txManager, prismaService);

    const project = await prisma.project.create({ data: { name: 'Merged', slug: 'merged', key: 'MRG' } });
    const ticket = await prisma.ticket.create({
      data: { projectId: project.id, number: 1, type: 'TASK', title: 'T' },
    });
    ticketId = ticket.id;
  });

  afterAll(async () => {
    if (prismaService) await prismaService.onModuleDestroy();
  });

  it.each(['open', 'draft', 'closed'])('refuses to move a merged link to %s', async (next) => {
    const merged = await makeLink('merged');

    await expect(repo.updateTicketLinkWithPrState(merged.id, next)).resolves.toBe('already-merged');

    const row = await prisma.ticketLink.findUniqueOrThrow({ where: { id: merged.id } });
    expect(row.prState).toBe('merged');
    expect(row.prUpdatedAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('writes a link whose prState is NULL', async () => {
    const bare = await makeLink(null);

    await expect(repo.updateTicketLinkWithPrState(bare.id, 'open')).resolves.toBe('updated');

    expect((await prisma.ticketLink.findUniqueOrThrow({ where: { id: bare.id } })).prState).toBe('open');
  });

  it('moves open to merged, then refuses to move it back', async () => {
    const open = await makeLink('open');

    await expect(repo.updateTicketLinkWithPrState(open.id, 'merged')).resolves.toBe('updated');
    await expect(repo.updateTicketLinkWithPrState(open.id, 'open')).resolves.toBe('already-merged');

    expect((await prisma.ticketLink.findUniqueOrThrow({ where: { id: open.id } })).prState).toBe('merged');
  });

  it('a closed link can be reopened (closed is not terminal for webhooks)', async () => {
    const closed = await makeLink('closed');

    await expect(repo.updateTicketLinkWithPrState(closed.id, 'open')).resolves.toBe('updated');
  });

  it('reports a missing link as not-found, never as already merged', async () => {
    await expect(repo.updateTicketLinkWithPrState('does-not-exist', 'open')).resolves.toBe('not-found');
  });
});
