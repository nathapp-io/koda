import { canRunDbTests } from '../../helpers/test-environment';
import { NathApplication } from '@nathapp/nestjs-app';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { seedFleetBase } from '../../helpers/fleet-fixtures';
import { fixtureDb, withTestActor } from '../../helpers/action-context';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('AuditRecorder (PG)', () => {
  let app: NathApplication;
  let prisma: PrismaClient;
  let actorId: string;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    prisma = fixtureDb(app);
    const base = await seedFleetBase(prisma);
    actorId = base.adminId;
    projectId = base.projectId;
  });

  afterAll(async () => {
    await app.close();
  });

  it('AC-15: persists the current actor in the enclosing transaction', async () => {
    const txManager = app.get<ITransactionManager>(TRANSACTION_MANAGER, { strict: false });
    const recorder = app.get(AuditRecorder);
    await withTestActor({ type: 'USER', id: actorId }, () => txManager.run(() => recorder.record({
      key: 'ticket.create', resourceType: 'ticket', resourceId: 't1', projectId,
    })));

    const entries = await prisma.auditEntry.findMany({ where: { resourceId: 't1', projectId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actorType: 'USER', actorId });
  });
});
