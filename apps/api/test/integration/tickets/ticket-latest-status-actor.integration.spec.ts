import { canRunDbTests } from '../../helpers/test-environment';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule, PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { resetDb } from '../../helpers/reset-db';
import { createPgAdapter } from '../../../src/prisma/pg-adapter';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('PrismaTicketsRepository.findLatestStatusChangeActor', () => {
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

  async function ticket(): Promise<string> {
    const key = `L${crypto.randomUUID().replaceAll('-', '').slice(0, 7).toUpperCase()}`;
    const project = await prisma.client.project.create({
      data: { name: 'Latest actor', slug: `latest-${crypto.randomUUID()}`, key },
    });
    const created = await prisma.client.ticket.create({
      data: {
        projectId: project.id,
        number: 1,
        type: 'TASK',
        title: 'Latest actor test',
        status: 'VERIFY_FIX',
        priority: 'MEDIUM',
      },
    });
    return created.id;
  }

  async function activity(
    ticketId: string,
    toStatus: string,
    actor: { actorUserId?: string; actorAgentId?: string },
    createdAt: Date,
  ): Promise<void> {
    await prisma.client.ticketActivity.create({
      data: { ticketId, action: 'STATUS_CHANGE', toStatus, ...actor, createdAt },
    });
  }

  it('returns the newest VERIFY_FIX actor, an agent after an earlier user', async () => {
    const ticketId = await ticket();
    const base = new Date('2026-01-01T00:00:00.000Z');
    await activity(ticketId, 'VERIFY_FIX', { actorUserId: 'user-u' }, base);
    await activity(ticketId, 'VERIFY_FIX', { actorAgentId: 'agent-a' }, new Date(base.getTime() + 1));

    await expect(repository.findLatestStatusChangeActor(ticketId, 'VERIFY_FIX')).resolves.toEqual({
      type: 'AGENT', id: 'agent-a',
    });
  });

  it('ignores a later status change to a different status', async () => {
    const ticketId = await ticket();
    const base = new Date('2026-01-01T00:00:00.000Z');
    await activity(ticketId, 'VERIFY_FIX', { actorUserId: 'user-u' }, base);
    await activity(ticketId, 'VERIFY_FIX', { actorAgentId: 'agent-a' }, new Date(base.getTime() + 1));
    await activity(ticketId, 'CLOSED', { actorUserId: 'user-u2' }, new Date(base.getTime() + 2));

    await expect(repository.findLatestStatusChangeActor(ticketId, 'VERIFY_FIX')).resolves.toEqual({
      type: 'AGENT', id: 'agent-a',
    });
  });

  it('returns null when no matching status-change activity exists', async () => {
    const ticketId = await ticket();
    await activity(ticketId, 'CLOSED', { actorUserId: 'user-u' }, new Date());

    await expect(repository.findLatestStatusChangeActor(ticketId, 'VERIFY_FIX')).resolves.toBeNull();
  });
});
