import { AUDIT_STORAGE, type IAuditStorage } from '@nathapp/nestjs-audit';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { NathApplication } from '@nathapp/nestjs-app';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('AuditRecorder.audited (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let tx: ITransactionManager;
  let recorder: AuditRecorder;
  let actorId: string;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    tx = app.get<ITransactionManager>(TRANSACTION_MANAGER, { strict: false });
    recorder = app.get(AuditRecorder);
    const base = await seedFleetBase(db);
    actorId = base.adminId;
    projectId = base.projectId;
  });
  afterAll(async () => { await app?.close(); });

  it('AC-9/10: commits a label and its audit entry together using the created id', async () => {
    const name = 'audited-label-created';
    const label = await withTestActor({ type: 'USER', id: actorId }, () => recorder.audited(
      () => db.label.create({ data: { projectId, name, color: null } }),
      (created) => ({ key: 'label.create', resourceType: 'label', resourceId: created.id, projectId }),
    ));
    expect(await db.label.findUnique({ where: { id: label.id } })).not.toBeNull();
    const entries = await db.auditEntry.findMany({ where: { key: 'label.create', resourceId: label.id } });
    expect(entries).toHaveLength(1);
  });

  it('AC-11/12: rejects an unknown key and rolls back the domain row', async () => {
    const name = 'audited-label-unknown-key';
    await expect(withTestActor({ type: 'USER', id: actorId }, () => recorder.audited(
      () => db.label.create({ data: { projectId, name, color: null } }),
      (created) => ({ key: 'not.a.catalog.key', resourceType: 'label', resourceId: created.id, projectId }),
    ))).rejects.toThrow('unknown audit key: not.a.catalog.key');
    expect(await db.label.findFirst({ where: { projectId, name } })).toBeNull();
  });

  it('AC-13: joins an open transaction and rolls back both records when it fails', async () => {
    const name = 'audited-label-outer-rollback';
    let createdId: string | undefined;
    await expect(withTestActor({ type: 'USER', id: actorId }, () => tx.run(async () => {
      await recorder.audited(
        async () => {
          const created = await db.label.create({ data: { projectId, name, color: null } });
          createdId = created.id;
          return created;
        },
        (created) => ({ key: 'label.create', resourceType: 'label', resourceId: created.id, projectId }),
      );
      throw new Error('outer transaction failed');
    }))).rejects.toThrow('outer transaction failed');
    expect(await db.label.findFirst({ where: { projectId, name } })).toBeNull();
    expect(createdId).toBeDefined();
    expect(await db.auditEntry.findMany({ where: { key: 'label.create', resourceId: createdId } })).toHaveLength(0);
  });

  it('AC-22: rolls back the domain row when audit storage fails', async () => {
    const name = 'audited-label-storage-failure';
    const storage = app.get<IAuditStorage>(AUDIT_STORAGE, { strict: false });
    const failure = new Error('audit storage failure');
    const storageSpy = vi.spyOn(storage, 'record').mockRejectedValue(failure);
    try {
      await expect(withTestActor({ type: 'USER', id: actorId }, () => recorder.audited(
        () => db.label.create({ data: { projectId, name, color: null } }),
        (created) => ({ key: 'label.create', resourceType: 'label', resourceId: created.id, projectId }),
      ))).rejects.toBe(failure);
      expect(await db.label.findFirst({ where: { projectId, name } })).toBeNull();
    } finally {
      storageSpy.mockRestore();
    }
  });
});
