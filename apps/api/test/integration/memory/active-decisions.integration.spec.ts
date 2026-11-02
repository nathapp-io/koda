import type { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaCanonicalStateRepository } from '../../../src/memory/prisma-canonical-state.repository';
import { bootHttpApp } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('active canonical decisions (PostgreSQL)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let repository: PrismaCanonicalStateRepository;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    repository = new PrismaCanonicalStateRepository(app.get(PrismaService));
  });

  afterAll(async () => { await app?.close(); });

  async function createProject() {
    return db.project.create({ data: { name: 'Decisions', slug: `decisions-${crypto.randomUUID()}`, key: `D${crypto.randomUUID().slice(0, 8)}` } });
  }

  it('AC-4: includes manual and null-source decisions but excludes review_event rows', async () => {
    const project = await createProject();
    const common = { projectId: project.id, kind: 'DECISION', status: 'active', subject: 'context', predicate: 'choice' };
    await db.memoryItem.createMany({ data: [
      { ...common, sourceType: 'review_event', sourceId: 'review', predicate: 'review decision' },
      { ...common, sourceType: 'manual', sourceId: 'manual', predicate: 'manual decision' },
      { ...common, sourceType: null, sourceId: null, predicate: 'null-source decision' },
    ] });

    const decisions = await repository.findActiveDecisions(project.id);

    expect(decisions.map(({ topic }) => topic).sort()).toEqual(['manual decision', 'null-source decision']);
  });

  it('AC-5: returns the 100 most recently updated decisions newest first', async () => {
    const project = await createProject();
    const start = Date.UTC(2026, 0, 1);
    await db.memoryItem.createMany({ data: Array.from({ length: 105 }, (_, index) => ({
      projectId: project.id,
      kind: 'DECISION',
      status: 'active',
      subject: `decision-${index}`,
      predicate: `decision-${index}`,
      sourceType: 'manual',
      updatedAt: new Date(start + index * 1000),
    })) });

    const decisions = await repository.findActiveDecisions(project.id);

    expect(decisions).toHaveLength(100);
    expect(decisions.map(({ topic }) => topic)).toEqual(Array.from({ length: 100 }, (_, index) => `decision-${104 - index}`));
  });
});
