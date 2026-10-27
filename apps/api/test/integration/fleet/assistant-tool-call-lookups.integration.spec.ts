import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaAssistantToolCallRepository } from '../../../src/fleet/assistant/prisma-assistant-tool-call.repository';
import { grantBaseline } from '../../../src/permissions/test-helpers/permission-fixtures';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

(canRunDbTests() ? describe : describe.skip)('Assistant command lookups (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let repository: PrismaAssistantToolCallRepository;
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    db = fixtureDb(app);
    repository = app.get(PrismaAssistantToolCallRepository, { strict: false });
  });
  afterAll(async () => { await app?.close(); });
  it('AC-14: reads agent identity and status, or null when absent', async () => {
    const agent = await db.agent.create({ data: { name: 'command-agent', slug: 'command-agent', apiKeyHash: 'command-agent-hash', status: 'PAUSED' } });
    await grantBaseline(db, { type: 'AGENT', id: agent.id });
    expect(await repository.findAgentActor(agent.id)).toEqual({ type: 'AGENT', id: agent.id, slug: agent.slug, status: 'PAUSED' });
    expect(await repository.findAgentActor('absent')).toBeNull();
  });
  it('AC-15: reads project slug, excluding absent and soft-deleted projects', async () => {
    const project = await db.project.create({ data: { slug: 'command-project', name: 'Command', key: 'CMD' } });
    expect(await repository.findProjectSlug(project.id)).toBe(project.slug);
    expect(await repository.findProjectSlug('absent')).toBeNull();
    await db.project.update({ where: { id: project.id }, data: { deletedAt: new Date() } });
    expect(await repository.findProjectSlug(project.id)).toBeNull();
  });
});
