import { AUDIT_STORAGE, type IAuditStorage } from '@nathapp/nestjs-audit';
import type { NathApplication } from '@nathapp/nestjs-app';
import { ReviewDecisionWriter, type ReviewDecisionInput } from '../../../src/memory/review-decision.writer';
import { runAsSystem, runWithApproval } from '../../../src/action-context/action-context';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('ReviewDecisionWriter (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let writer: ReviewDecisionWriter;
  let input: ReviewDecisionInput;
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    writer = app.get(ReviewDecisionWriter);
  });
  beforeEach(async () => {
    const p = await db.project.create({ data: { name: 'Review', slug: `review-${crypto.randomUUID()}`, key: `R${crypto.randomUUID().slice(0, 8)}` } });
    input = { projectId: p.id, repoId: 'R1', prNumber: 42, jobId: `j-${p.id}`, threadId: 't1', findingKey: 'f-ab12', finding: 'missing null check', reason: 'guarded upstream' };
  });
  afterAll(async () => { await app?.close(); });
  const mint = (value = input) => runAsSystem('review', () => runWithApproval({ requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: 'github:alice' }, () => writer.mint(value)));
  const seedRetired = (projectId = input.projectId) => db.memoryItem.create({ data: { projectId, kind: 'DECISION', subject: 'repo:R1', predicate: 'review-finding:f-ab12', sourceType: 'review_event', sourceId: `retired-${projectId}`, status: 'rejected' } });

  it('AC-4/5/6: writes the system decision with one forge-approved custom audit', async () => {
    const result = await mint({ ...input, jobId: 'j1' });
    expect(result.status).toBe('minted');
    if (result.status !== 'minted') throw new Error('expected mint');
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: result.memoryItemId } })).toMatchObject({ projectId: input.projectId, kind: 'DECISION', subject: 'repo:R1', predicate: 'review-finding:f-ab12', sourceType: 'review_event', sourceId: 'j1:t1', status: 'active', confidence: 1, ownerId: null, ownerType: null });
    const entries = await db.auditEntry.findMany({ where: { resourceId: result.memoryItemId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'system.review.decision', resourceType: 'memory-item', actorType: 'SYSTEM', actorId: 'review', approverType: 'FORGE_USER', approverId: 'github:alice', summary: "review decision from job j1, PR #42, approver github:alice (one of the thread's commenters)" });
  });
  it('AC-7: duplicate in any status wins over retirement', async () => {
    const result = await mint();
    if (result.status !== 'minted') throw new Error('expected mint');
    expect(await mint()).toEqual({ status: 'skipped', reason: 'duplicate' });
    expect(await db.auditEntry.count({ where: { resourceId: result.memoryItemId } })).toBe(1);
    await db.memoryItem.update({ where: { id: result.memoryItemId }, data: { status: 'rejected', activeKey: null, deletedAt: new Date() } });
    expect(await writer.guard(input)).toEqual({ status: 'skipped', reason: 'duplicate' });
    expect(await mint()).toEqual({ status: 'skipped', reason: 'duplicate' });
  });
  it('AC-8: retirement blocks both preflight and mint', async () => {
    expect(await writer.guard(input)).toBeNull();
    await seedRetired();
    expect(await writer.guard(input)).toEqual({ status: 'skipped', reason: 'retired' });
    expect(await mint()).toEqual({ status: 'skipped', reason: 'retired' });
  });
  it('AC-9: another project retirement does not block mint', async () => {
    const q = await db.project.create({ data: { name: 'Q', slug: `q-${crypto.randomUUID()}`, key: `Q${crypto.randomUUID().slice(0, 8)}` } });
    await seedRetired(q.id);
    expect(await mint()).toMatchObject({ status: 'minted' });
  });
  it('AC-10: a newer withdrawal supersedes the old decision', async () => {
    const old = await mint();
    if (old.status !== 'minted') throw new Error('expected mint');
    expect(await mint({ ...input, jobId: 'j2', threadId: 't9' })).toMatchObject({ status: 'minted' });
    expect(await db.memoryItem.findUniqueOrThrow({ where: { id: old.memoryItemId } })).toMatchObject({ status: 'superseded', activeKey: null });
  });
  it('AC-11: clear guard returns null', async () => {
    expect(await writer.guard(input)).toBeNull();
  });
  it('audit failure rolls back insertion and supersession atomically', async () => {
    const old = await mint();
    if (old.status !== 'minted') throw new Error('expected mint');
    const spy = vi.spyOn(app.get<IAuditStorage>(AUDIT_STORAGE), 'record').mockRejectedValue(new Error('audit refused'));
    try {
      await expect(mint({ ...input, jobId: 'rollback' })).rejects.toThrow('audit refused');
      expect(await db.memoryItem.findMany({ where: { projectId: input.projectId } })).toMatchObject([{ id: old.memoryItemId, status: 'active' }]);
    } finally { spy.mockRestore(); }
  });
});
