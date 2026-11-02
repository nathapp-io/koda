import { canRunDbTests } from '../../helpers/test-environment';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { resetDb } from '../../helpers/reset-db';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';

/**
 * US-006: the classic VERIFIED auto-PR asks `hasPrLink` before calling a provider, so a ticket that
 * already carries a pull-request link — from any source, not only fleet — never gets a second PR.
 *
 * Run: cd apps/api && KODA_DB_TESTS=1 bun run test:scoped test/integration/tickets/ticket-pr-link.integration.spec.ts
 */
const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('PrismaTicketsRepository.hasPrLink', () => {
  let module: TestingModule;
  let prisma: PrismaService<PrismaClient>;
  let repository: PrismaTicketsRepository;

  beforeAll(async () => {
    await resetDb();
    module = await Test.createTestingModule({
      imports: [
        PrismaModule.forRoot({
          client: PrismaClient,
          transaction: true,
          clientOptions: { adapter: createPgAdapter(DATABASE_URL) },
        }),
      ],
      providers: [PrismaTicketsRepository],
    }).compile();
    prisma = module.get<PrismaService<PrismaClient>>(PrismaService);
    await prisma.onModuleInit();
    repository = module.get(PrismaTicketsRepository);
  });

  afterAll(async () => {
    await module?.close();
  });

  /** A ticket in its own project, so one case's links can never answer for another's. */
  async function ticket(): Promise<string> {
    const key = `P${crypto.randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`;
    const project = await prisma.client.project.create({
      data: { name: 'PR link', slug: `pr-link-${crypto.randomUUID()}`, key },
    });
    const created = await prisma.client.ticket.create({
      data: {
        projectId: project.id,
        number: 1,
        type: 'TASK',
        title: 'PR link test',
        status: 'VERIFIED',
        priority: 'MEDIUM',
      },
    });
    return created.id;
  }

  let url = 0;
  async function link(ticketId: string, linkType: string, source: string): Promise<void> {
    url += 1;
    await prisma.client.ticketLink.create({
      data: {
        ticketId,
        url: `https://example.test/${ticketId}/${url}`,
        provider: 'github',
        linkType,
        source,
      },
    });
  }

  it('AC-16: is true for a pr link whose source is not fleet', async () => {
    const ticketId = await ticket();
    await link(ticketId, 'pr', 'vcs');

    await expect(repository.hasPrLink(ticketId)).resolves.toBe(true);
  });

  it('AC-16: counts a fleet-sourced pr link too — any source answers', async () => {
    const ticketId = await ticket();
    await link(ticketId, 'pr', 'fleet');

    await expect(repository.hasPrLink(ticketId)).resolves.toBe(true);
  });

  it('AC-17: is false when the only link has a linkType other than pr', async () => {
    const ticketId = await ticket();
    await link(ticketId, 'url', 'vcs');
    await link(ticketId, 'commit', 'vcs');

    await expect(repository.hasPrLink(ticketId)).resolves.toBe(false);
  });

  it('is false for a ticket with no links at all', async () => {
    const ticketId = await ticket();

    await expect(repository.hasPrLink(ticketId)).resolves.toBe(false);
  });

  it('answers per ticket: another ticket’s pr link does not leak into this one', async () => {
    const withLink = await ticket();
    const withoutLink = await ticket();
    await link(withLink, 'pr', 'vcs');

    await expect(repository.hasPrLink(withoutLink)).resolves.toBe(false);
    await expect(repository.hasPrLink(withLink)).resolves.toBe(true);
  });
});
