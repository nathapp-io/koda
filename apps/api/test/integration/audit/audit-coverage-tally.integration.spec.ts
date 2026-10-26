import type { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openAuditScope } from '../../../src/action-context/audit-coverage';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { fixtureDb, withTestActor } from '../../helpers/action-context';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('Audit coverage transaction tally (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let client: PrismaClient;
  let txManager: ITransactionManager;
  let actorId: string;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    client = app.get<PrismaService<PrismaClient>>(PrismaService, { strict: false }).client;
    txManager = app.get<ITransactionManager>(TRANSACTION_MANAGER, { strict: false });
    const base = await seedFleetBase(db);
    actorId = base.adminId;
    projectId = base.projectId;
  });

  afterAll(async () => { await app?.close(); });

  it('AC-7: drops a rolled-back label write through the booted txManager', async () => {
    const failure = new Error('force rollback');
    const name = 'coverage-label-rollback';
    await openAuditScope('POST /x', async (scope) => {
      await expect(withTestActor({ type: 'USER', id: actorId }, () => txManager.run(async () => {
        const label = await client.label.create({ data: { projectId, name } });
        expect(label.id).toEqual(expect.any(String));
        throw failure;
      }))).rejects.toBe(failure);
      expect(scope.writes).toEqual([]);
      expect(scope.entries).toBe(0);
    });
    expect(await db.label.findUnique({ where: { projectId_name: { projectId, name } } })).toBeNull();
  });

  it('commits counts exactly once through nested txManager runs and the real recorder', async () => {
    const recorder = app.get(AuditRecorder);
    await openAuditScope('POST /x', async (scope) => {
      await withTestActor({ type: 'USER', id: actorId }, () => txManager.run(async () => {
        const label = await client.label.create({ data: { projectId, name: 'coverage-label-commit' } });
        await txManager.run(() => recorder.record({
          key: 'label.create', resourceType: 'label', resourceId: label.id, projectId,
        }));
        expect(scope.writes).toEqual([]);
        expect(scope.entries).toBe(0);
      }));
      expect(scope.writes).toEqual(['Label.create']);
      expect(scope.entries).toBe(1);
    });
  });
});
