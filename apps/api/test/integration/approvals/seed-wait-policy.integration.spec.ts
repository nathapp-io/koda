import type { NathApplication } from '@nathapp/nestjs-app';
import { seedWaitPolicy } from '../../../src/approvals/test-helpers/approval-fixtures';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('seedWaitPolicy (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let projectId: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    const project = await db.project.create({
      data: { id: 'approval-fixture-project', slug: 'approval-fixture-project', key: 'AFP', name: 'Approval fixture' },
      select: { id: true },
    });
    projectId = project.id;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await db.approvalDecision.deleteMany();
    await db.approvalRequest.deleteMany();
    await db.approvalPolicy.deleteMany();
  });

  it('AC-5: seeds a project-scoped agent wait policy', async () => {
    await seedWaitPolicy(db, 'label.create', projectId);

    const policies = await db.approvalPolicy.findMany({ where: { selector: `${projectId}|label.create|type:AGENT` }, take: 2 });
    expect(policies).toHaveLength(1);
    expect(policies[0]).toMatchObject({
      selector: `${projectId}|label.create|type:AGENT`,
      principalType: 'AGENT',
      mode: 'agent',
    });
  });

  it('AC-6: upserts one row for repeated project policy seeds', async () => {
    await seedWaitPolicy(db, 'label.create', projectId);
    await seedWaitPolicy(db, 'label.create', projectId);

    expect(await db.approvalPolicy.count({ where: { selector: `${projectId}|label.create|type:AGENT` } })).toBe(1);
  });

  it('AC-7: seeds a global agent wait policy', async () => {
    await seedWaitPolicy(db, 'project.create', null);

    const policy = await db.approvalPolicy.findFirst({ where: { selector: '*|project.create|type:AGENT' } });
    expect(policy).toMatchObject({ selector: '*|project.create|type:AGENT', projectId: null });
  });
});
