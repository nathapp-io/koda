import { createMock } from '@golevelup/ts-vitest';
import { createMockPrismaService } from '@nathapp/nestjs-prisma';
import type { ITransactionManager } from '@nathapp/nestjs-data';
import type { OutboxService } from '@nathapp/nestjs-outbox';
import { NotFoundAppException, ForbiddenAppException } from '@nathapp/nestjs-common';
import { Prisma } from '../generated/prisma/client';
import { runWithActionContext } from '../action-context/action-context';
import type { KodaPrincipal } from '../auth/principal/koda-principal.types';
import type { PermissionService } from '../permissions/permission.service';
import type { ProjectAccessService } from '../projects/project-access.service';
import type { AuditRecorder } from '../audit/audit-recorder.service';
import type { TicketEventService } from '../events/ticket-event.service';
import type { ApprovalGate } from '../approvals/approval-gate.service';
import type { ApprovalExecutionService } from '../approvals/approval-execution.service';
import { ApprovalRouteGate } from '../approvals/route/approval-route-gate';
import { ConflictAppException } from '../common/exceptions/conflict-app.exception';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { PrismaCommentRepository } from './prisma-comment.repository';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness() {
  const row = {
    id: 'comment', ticketId: 'ticket', body: 'original', type: 'GENERAL',
    authorUserId: 'user', authorAgentId: null, deletedAt: null as Date | null,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const prisma = createMockPrismaService({ fn: vi.fn });
  prisma.client.comment = {
    findUnique: vi.fn(async () => ({ ...row, ticket: {
      id: 'ticket', deletedAt: null,
      project: { id: 'project', slug: 'project', key: 'P', deletedAt: null },
    } })),
    update: vi.fn(async ({ where, data }: { where: Prisma.CommentWhereUniqueInput; data: { body?: string } }) => {
      if (where.deletedAt === null && row.deletedAt !== null) {
        throw new Prisma.PrismaClientKnownRequestError('missing', { code: 'P2025', clientVersion: 'test' });
      }
      Object.assign(row, data);
      return { ...row };
    }),
    updateMany: vi.fn(async () => { row.deletedAt = new Date(); return { count: 1 }; }),
  };
  const tx = createMock<ITransactionManager>({
    run: vi.fn((fn) => fn()), getClient: vi.fn(() => prisma.client),
    isInTransaction: vi.fn(() => false),
  });
  const repo = new PrismaCommentRepository(tx, prisma as never);
  const permissions = createMock<PermissionService>();
  permissions.can.mockResolvedValue({ allowed: true, reason: 'granted' });
  const access = createMock<ProjectAccessService>();
  access.resolveMembership.mockResolvedValue(null);
  const audit = createMock<AuditRecorder>();
  audit.audited.mockImplementation(async (fn, describe) => {
    const result = await fn();
    const entries = describe(result);
    for (const entry of Array.isArray(entries) ? entries : [entries]) await audit.record(entry);
    return result;
  });
  const service = new CommentsService(repo, permissions, tx, createMock<TicketEventService>(), createMock<OutboxService>(), access, audit);
  const gate = createMock<ApprovalGate>();
  gate.gate.mockResolvedValue({ status: 'pending', request: { id: 'approval' } } as never);
  const routeGate = new ApprovalRouteGate(gate, permissions, createMock<ApprovalExecutionService>());
  const controller = new CommentsController(service, routeGate);
  const principal = { actorType: 'user', id: 'user' } as KodaPrincipal;
  return { row, service, controller, permissions, access, gate, audit, principal };
}

describe('comment mutation race and approval regressions', () => {
  it.each(['keyless member', 'wait-policy agent'] as const)('rejects a workflow edit before the approval gate for a %s', async (scenario) => {
    const h = harness();
    h.row.type = 'FIX_REPORT';
    h.permissions.canHoldKey.mockResolvedValue(scenario !== 'keyless member');
    const actorType = scenario === 'keyless member' ? 'USER' : 'AGENT';
    const principal = { actorType: actorType === 'USER' ? 'user' : 'agent', id: 'user' } as KodaPrincipal;
    const error = await runWithActionContext({ actor: { type: actorType, id: 'user' }, origin: 'rest' },
      () => h.controller.updateFromHttp('comment', { body: 'changed' }, principal)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictAppException);
    expect((error as ConflictAppException).httpStatus).toBe(409);
    expect(h.permissions.canHoldKey).not.toHaveBeenCalled();
    expect(h.gate.gate).not.toHaveBeenCalled();
    expect(h.row.body).toBe('original');
  });

  it('conceals workflow comments from outsiders before checking immutability', async () => {
    const h = harness();
    h.row.type = 'FIX_REPORT';
    h.access.resolveMembership.mockRejectedValue(new ForbiddenAppException({}, 'projects'));
    await expect(h.controller.updateFromHttp('comment', { body: 'changed' }, h.principal)).rejects.toBeInstanceOf(NotFoundAppException);
    expect(h.gate.gate).not.toHaveBeenCalled();
  });

  it('does not overwrite a tombstone when DELETE wins during PATCH authorization', async () => {
    const h = harness();
    const authorizing = deferred();
    const resume = deferred();
    h.permissions.can.mockImplementation(async (_principal, key) => {
      if (key === 'comment.update') {
        authorizing.resolve();
        await resume.promise;
      }
      return { allowed: true, reason: 'granted' };
    });
    const patch = h.service.update('comment', { body: 'changed' }, h.principal).catch((caught: unknown) => caught);
    await authorizing.promise;
    try {
      await h.service.delete('comment', h.principal);
    } finally {
      resume.resolve();
    }
    const error = await patch;
    expect(error).toBeInstanceOf(NotFoundAppException);
    expect((error as NotFoundAppException).prefix).toBe('comments');
    expect((error as NotFoundAppException).httpStatus).toBe(404);
    expect(h.row.deletedAt).toBeInstanceOf(Date);
    expect(h.row.body).toBe('original');
    expect(h.audit.record).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'comment.update' }));
  });
});
