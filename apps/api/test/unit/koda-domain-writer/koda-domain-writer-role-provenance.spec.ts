import type { Mock } from 'vitest';
/**
 * US-003: KodaDomainWriter authorizes an event's actor by its effective `project.read` key in the
 * event's project — never by a `role`-like field in the payload, and never by a legacy actor-role
 * allow-list.
 *
 * These cases drive the writer through the REAL `PrismaKodaDomainWriterRepository` (which resolves
 * the project row) and a `PermissionService.effectiveKeys` double, so the decision under test is the
 * one `PermissionService` would make for the actor it is handed.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { ForbiddenAppException } from '@nathapp/nestjs-common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { OutboxService as NathappOutboxService } from '@nathapp/nestjs-outbox';
import { KodaDomainWriter } from '../../../src/koda-domain-writer/koda-domain-writer.service';
import { PrismaKodaDomainWriterRepository } from '../../../src/koda-domain-writer/prisma-koda-domain-writer.repository';
import { RagService } from '../../../src/rag/rag.service';
import { PermissionService } from '../../../src/permissions/permission.service';
import { TicketEventService } from '../../../src/events/ticket-event.service';
import { AgentEventService } from '../../../src/events/agent-event.service';
import { DecisionEventService } from '../../../src/events/decision-event.service';
import type { WriteTicketEventInput } from '../../../src/koda-domain-writer/write-result.dto';

const PROJECT_ID = 'proj-123';
const USER_ID = 'user-1';
const AGENT_ID = 'agent-1';

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

describe('US-003: KodaDomainWriter decides the actor with project.read', () => {
  let writer: KodaDomainWriter;
  let moduleRef: TestingModule;

  const prismaMock = {
    client: {
      project: { findUnique: vi.fn() },
    },
  };

  const permissionsMock = { effectiveKeys: vi.fn() };
  const ticketEventService = { create: vi.fn() };
  const outbox = { record: vi.fn() };

  /** Wire the mocked Prisma client for one live project. */
  function givenProject(): void {
    prismaMock.client.project.findUnique.mockResolvedValue({ id: PROJECT_ID, deletedAt: null });
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        KodaDomainWriter,
        PrismaKodaDomainWriterRepository,
        { provide: PrismaService, useValue: prismaMock },
        {
          provide: RagService,
          useValue: { indexDocument: vi.fn(), importGraphify: vi.fn() },
        },
        { provide: NathappOutboxService, useValue: outbox },
        {
          provide: TRANSACTION_MANAGER,
          useValue: {
            run: vi.fn((fn: () => Promise<unknown>) => fn()),
            getClient: vi.fn(),
            isInTransaction: vi.fn(() => false),
          },
        },
        { provide: PermissionService, useValue: permissionsMock },
        { provide: TicketEventService, useValue: ticketEventService },
        { provide: AgentEventService, useValue: { create: vi.fn() } },
        { provide: DecisionEventService, useValue: { create: vi.fn() } },
      ],
    }).compile();

    writer = moduleRef.get<KodaDomainWriter>(KodaDomainWriter);
  });

  afterAll(async () => {
    await moduleRef?.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    givenProject();
    permissionsMock.effectiveKeys.mockResolvedValue(new Set(['project.read']));
    ticketEventService.create.mockResolvedValue({
      id: 'event-1',
      action: 'TICKET_CREATED',
      timestamp: new Date('2026-01-01T00:00:00.000Z'),
    });
    outbox.record.mockResolvedValue(undefined);
  });

  it('refuses a payload actorRole of ADMIN when the actor holds no key in the project', async () => {
    permissionsMock.effectiveKeys.mockResolvedValue(new Set(['ticket.read']));

    const error = await rejectionOf(
      writer.writeTicketEvent(
        ticketEvent({ actorId: USER_ID, actorType: 'user', data: { actorRole: 'ADMIN' } }),
      ),
    );

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect((error as ForbiddenAppException).prefix).toBe('koda-domain-writer');
  });

  it('writes no event and no outbox row for a refused actor', async () => {
    permissionsMock.effectiveKeys.mockResolvedValue(new Set(['ticket.read']));

    await rejectionOf(
      writer.writeTicketEvent(
        ticketEvent({ actorId: USER_ID, actorType: 'user', data: { actorRole: 'ADMIN' } }),
      ),
    );

    expect(ticketEventService.create).not.toHaveBeenCalled();
    expect(outbox.record).not.toHaveBeenCalled();
  });

  it('ignores a payload role field when the actor holds no key in the project', async () => {
    permissionsMock.effectiveKeys.mockResolvedValue(new Set(['ticket.read']));

    const error = await rejectionOf(
      writer.writeTicketEvent(
        ticketEvent({ actorId: USER_ID, actorType: 'user', data: { role: 'DEVELOPER' } }),
      ),
    );

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect(ticketEventService.create).not.toHaveBeenCalled();
  });

  it('writes the event for a user actor holding project.read, with no payload role at all', async () => {
    await expect(
      writer.writeTicketEvent(ticketEvent({ actorId: USER_ID, actorType: 'user', data: {} })),
    ).resolves.toMatchObject({ canonicalId: 'event-1' });
    expect(ticketEventService.create).toHaveBeenCalledTimes(1);
  });

  it('asks for the agent actor’s keys as an AGENT principal in the event’s project', async () => {
    await expect(
      writer.writeTicketEvent(ticketEvent({ actorId: AGENT_ID, actorType: 'agent', data: {} })),
    ).resolves.toMatchObject({ canonicalId: 'event-1' });

    expect(permissionsMock.effectiveKeys).toHaveBeenCalledWith(
      { type: 'AGENT', id: AGENT_ID },
      { projectId: PROJECT_ID },
    );
  });

  it('refuses a project id that names no project before reading any key', async () => {
    prismaMock.client.project.findUnique.mockResolvedValue(null);

    const error = await rejectionOf(
      writer.writeTicketEvent(ticketEvent({ actorId: USER_ID, actorType: 'user', data: {} })),
    );

    expect(error).toBeInstanceOf(ForbiddenAppException);
    expect((error as ForbiddenAppException).prefix).toBe('koda-domain-writer');
    expect(permissionsMock.effectiveKeys).not.toHaveBeenCalled();
    expect(ticketEventService.create as Mock).not.toHaveBeenCalled();
  });
});
