import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { bootHttpApp } from '../../helpers/http-app';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { withTestActor } from '../../helpers/action-context';
import { PrismaAuditEntryRepository } from '../../../src/audit/prisma-audit-entry.repository';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('AuditEntry repository (PG)', () => {
  const prisma = createTestPrismaClient();
  let app: NathApplication;
  let repo: PrismaAuditEntryRepository;
  const row = (overrides: Record<string, unknown> = {}) => ({
    key: 'ticket.create', resourceType: 'ticket', resourceId: 't1', projectId: 'p1', actorType: 'USER' as const,
    actorId: 'a1', onBehalfOfType: null, onBehalfOfId: null, origin: 'rest' as const,
    requiredMode: 'none' as const, satisfiedBy: 'none' as const, approverType: null, approverId: null,
    approvalRequestId: null, correlationId: 'c1', summary: null, createdAt: new Date('2026-01-01T00:00:00Z'), ...overrides,
  });
  beforeAll(async () => { await resetDb(); app = await bootHttpApp({ registrationEnabled: false }); repo = new PrismaAuditEntryRepository(app.get(TRANSACTION_MANAGER), app.get(PrismaService)); });
  afterAll(async () => { await app?.close(); await prisma.$disconnect(); });
  beforeEach(async () => { await withTestActor({ type: 'USER', id: 'u1' }, () => prisma.auditEntry.deleteMany()); });
  const create = (input = row()) => withTestActor({ type: 'USER', id: 'u1' }, () => repo.create(input));
  const cutoff = new Date('2026-01-02T00:00:00.000Z');
  const earlier = () => row({ createdAt: new Date('2026-01-01T00:00:00.000Z') });
  const later = () => row({ createdAt: new Date('2026-01-03T00:00:00.000Z') });
  /** The purge's own actor: `AuditRetentionProcessor` runs as `SYSTEM/audit`. */
  const purge = (before = cutoff) =>
    withTestActor({ type: 'SYSTEM', id: 'audit' }, () => repo.deleteCreatedBefore(before));
  const stillThere = async (id: string | undefined): Promise<boolean> => {
    if (id === undefined) throw new Error('the created entry has no id');
    return (await withTestActor({ type: 'USER', id: 'u1' }, () => repo.findById(id))) !== null;
  };
  it('round trips create and rejects updates', async () => {
    const created = await create();
    const createdId = created.id;
    expect(createdId).toEqual(expect.any(String));
    if (createdId === undefined) throw new Error('created audit entry has no id');
    await expect(withTestActor({ type: 'USER', id: 'u1' }, () => repo.findById(createdId))).resolves.toEqual(created);
    await expect(withTestActor({ type: 'USER', id: 'u1' }, () => repo.update(createdId, { summary: 'x' }))).rejects.toThrow('audit entries are append-only');
  });
  it.each([
    [{ key: 'ticket.create' }, [row(), row({ key: 'comment.create' })]],
    [{ actorType: 'AGENT', actorId: 'a1' }, [row({ actorType: 'AGENT' }), row(), row({ actorType: 'AGENT', actorId: 'a2' })]],
    [{ approverId: 'u2' }, [row({ approverId: 'u2' }), row({ approverId: 'u3' }), row()]],
    [{ projectId: 'p1' }, [row(), row({ projectId: 'p2' }), row({ projectId: null })]],
    [{ resourceType: 'ticket', resourceId: 't1' }, [row(), row({ resourceId: 't2' }), row({ resourceType: 'comment' })]],
  ])('filters using %o', async (filters, inputs) => {
    const made = await Promise.all(inputs.map((input) => create(input)));
    const result = await withTestActor({ type: 'USER', id: 'u1' }, () => repo.findPage(filters, { current: 1, size: 20 }));
    expect(result.records.map((item) => item.id)).toEqual([made[0].id]);
  });
  it('filters inclusive date bounds and sorts createdAt then id descending', async () => {
    const d1 = new Date('2026-01-02T00:00:00Z'); const d2 = new Date('2026-01-03T00:00:00Z');
    const midday = new Date('2026-01-02T12:00:00Z');
    const inputs = [row({ createdAt: new Date(d1.getTime() - 1) }), row({ createdAt: d1 }), row({ createdAt: midday }), row({ createdAt: d2 }), row({ createdAt: d2 }), row({ createdAt: new Date(d2.getTime() + 1) })];
    const created = await Promise.all(inputs.map((input) => create(input)));
    const page = await withTestActor({ type: 'USER', id: 'u1' }, () => repo.findPage({ from: d1, to: d2 }, { current: 1, size: 20 }));
    expect(page.records).toHaveLength(4);
    expect(page.records.map((x) => x.createdAt.getTime())).toEqual([d2.getTime(), d2.getTime(), midday.getTime(), d1.getTime()]);
    const equalTimeIds = created.filter((item) => item.createdAt.getTime() === d2.getTime()).map((item) => item.id).filter((id): id is string => id !== undefined).sort().reverse();
    expect(page.records.slice(0, 2).map((item) => item.id)).toEqual(equalTimeIds);
  });

  it('AC-3: deletes the entry created before the cutoff', async () => {
    await create(later());
    const old = await create(earlier());

    await purge();

    expect(await stillThere(old.id)).toBe(false);
  });

  it('AC-4: returns 1 when exactly one entry was created before the cutoff', async () => {
    await create(earlier());

    await expect(purge()).resolves.toBe(1);
  });

  it('AC-5: keeps the entry created after the cutoff in that same run', async () => {
    await create(earlier());
    const recent = await create(later());

    const deleted = await purge();

    expect(deleted).toBe(1);
    expect(await stillThere(recent.id)).toBe(true);
  });
});
