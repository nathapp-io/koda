import { AUDIT_STORAGE, type IAuditStorage } from '@nathapp/nestjs-audit';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { NathApplication } from '@nathapp/nestjs-app';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ContextlessWriteError } from '../../../src/action-context/contextless-write';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('AuditRecorder rollback (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let actorId: string;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    const base = await seedFleetBase(db);
    actorId = base.adminId;
    projectId = base.projectId;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('AC-10: rolls back an audit row when the enclosing transaction throws', async () => {
    const tx = app.get<ITransactionManager>(TRANSACTION_MANAGER, { strict: false });
    const recorder = app.get(AuditRecorder);
    await expect(withTestActor({ type: 'USER', id: actorId }, () => tx.run(async () => {
      await recorder.record({ key: 'ticket.create', resourceType: 'ticket', resourceId: 'rb-1', projectId });
      throw new Error('force rollback');
    }))).rejects.toThrow('force rollback');
    expect(await db.auditEntry.findMany({ where: { resourceId: 'rb-1' } })).toHaveLength(0);
  });

  it('AC-11: rolls back a domain label when the recorder refuses an unknown key', async () => {
    const tx = app.get<ITransactionManager>(TRANSACTION_MANAGER, { strict: false });
    const recorder = app.get(AuditRecorder);
    const name = 'audit-unknown-key-rb-1';
    await expect(withTestActor({ type: 'USER', id: actorId }, () => tx.run(async () => {
      await db.label.create({ data: { projectId, name, color: null } });
      await recorder.record({ key: 'no.such.key', resourceType: 'label', resourceId: name });
    }))).rejects.toThrow('unknown audit key: no.such.key');
    expect(await db.label.findFirst({ where: { projectId, name } })).toBeNull();
  });

  it('AC-12: context guard refuses a context-less audit insert in throw mode', async () => {
    const tx = app.get<ITransactionManager>(TRANSACTION_MANAGER, { strict: false });
    const recorder = app.get(AuditRecorder);
    await expect(tx.run(() => recorder.record({
      key: 'ticket.create', resourceType: 'ticket', resourceId: 'contextless-rb-1', projectId,
    }))).rejects.toBeInstanceOf(ContextlessWriteError);
  });

  it('AC-13: rolls back the domain label when storage rejects', async () => {
    const tx = app.get<ITransactionManager>(TRANSACTION_MANAGER, { strict: false });
    const recorder = app.get(AuditRecorder);
    const storage = app.get<IAuditStorage>(AUDIT_STORAGE, { strict: false });
    const failure = new Error('audit storage failure');
    const storageSpy = vi.spyOn(storage, 'record').mockRejectedValue(failure);
    const name = 'audit-storage-rb-1';
    try {
      await expect(withTestActor({ type: 'USER', id: actorId }, () => tx.run(async () => {
        await db.label.create({ data: { projectId, name, color: null } });
        await recorder.record({ key: 'ticket.create', resourceType: 'label', resourceId: name, projectId });
      }))).rejects.toBe(failure);
      expect(await db.label.findFirst({ where: { projectId, name } })).toBeNull();
    } finally {
      storageSpy.mockRestore();
    }
  });
});
