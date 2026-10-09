/**
 * S4c US-001 (AC15) — the AgentProject roster reads of PrismaAgentRepository
 * against a real Postgres.
 *
 * `findRosterProjects` carries two load-bearing clauses that a mocked
 * repository cannot pin: the roster row is filtered by `project.deletedAt:
 * null` (a soft-deleted project disappears even while its AgentProject row
 * survives), and the result is ordered by project slug — not by row insertion
 * order. The HTTP form of the same criteria is asserted in
 * test/e2e/agents.e2e.spec.ts (GET /agents/me).
 *
 * Run: cd apps/api && bun run test:db:up && bun run test:scoped test/integration/agents/agent-roster-repository.integration.spec.ts
 */
import { PrismaClient } from '../../../src/generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { resetDb } from '../../helpers/reset-db';
import { createTestPrismaClient } from '../../helpers/test-prisma';
import { PrismaAgentRepository } from '../../../src/agents/prisma-agent.repository';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('PrismaAgentRepository roster reads (PG)', () => {
  const prisma = createTestPrismaClient();
  const repository = new PrismaAgentRepository({ client: prisma } as unknown as PrismaService<PrismaClient>);

  let agentId: string;
  let otherAgentId: string;
  let alphaProjectId: string;
  let deletedProjectId: string;
  let otherAgentProjectId: string;

  beforeAll(async () => {
    await resetDb();

    const agent = await prisma.agent.create({
      data: { name: 'Roster Bot', slug: 'roster-bot', apiKeyHash: 'roster-bot-api-key-hash' },
    });
    const otherAgent = await prisma.agent.create({
      data: { name: 'Other Bot', slug: 'roster-other-bot', apiKeyHash: 'roster-other-bot-api-key-hash' },
    });
    agentId = agent.id;
    otherAgentId = otherAgent.id;

    const project = (name: string, slug: string, key: string) =>
      prisma.project.create({ data: { name, slug, key } });

    // Created in an order that is NOT slug order, so a pass cannot come from
    // insertion order alone.
    const zulu = await project('Zulu', 'roster-zulu', 'RZL');
    const alpha = await project('Alpha', 'roster-alpha', 'RAL');
    const mike = await project('Mike', 'roster-mike', 'RMK');
    const otherAgentsProject = await project('Other Agent Project', 'roster-other', 'ROT');
    // Exists, but no agent holds a roster row for it.
    await project('Unrostered', 'roster-none', 'RNN');

    alphaProjectId = alpha.id;
    deletedProjectId = mike.id;
    otherAgentProjectId = otherAgentsProject.id;

    await prisma.agentProject.createMany({
      data: [
        { projectId: zulu.id, agentId },
        { projectId: alpha.id, agentId },
        { projectId: mike.id, agentId },
        { projectId: otherAgentsProject.id, agentId: otherAgentId },
      ],
    });

    // Soft-deleted AFTER the roster row exists, so the row is still there and
    // only the `deletedAt: null` filter can keep the project out of the list.
    await prisma.project.update({ where: { id: mike.id }, data: { deletedAt: new Date() } });
  }, 30_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('AC15: lists only the agent’s non-deleted roster projects, ordered by slug', async () => {
    await expect(repository.findRosterProjects(agentId)).resolves.toEqual([
      { slug: 'roster-alpha', name: 'Alpha' },
      { slug: 'roster-zulu', name: 'Zulu' },
    ]);
  });

  it('AC15 boundary: a soft-deleted project is dropped while its roster row survives', async () => {
    const survivingRow = await prisma.agentProject.count({
      where: { agentId, projectId: deletedProjectId },
    });

    expect(survivingRow).toBe(1);
    expect((await repository.findRosterProjects(agentId)).map((p) => p.slug)).not.toContain('roster-mike');
  });

  it('AC15 boundary: another agent’s roster rows never leak in', async () => {
    expect((await repository.findRosterProjects(agentId)).map((p) => p.slug)).not.toContain('roster-other');

    await expect(repository.findRosterProjects(otherAgentId)).resolves.toEqual([
      { slug: 'roster-other', name: 'Other Agent Project' },
    ]);
  });

  it('AC15 boundary: an agent with no roster rows gets an empty list', async () => {
    const stranger = await prisma.agent.create({
      data: { name: 'Stranger', slug: 'roster-stranger', apiKeyHash: 'roster-stranger-api-key-hash' },
    });

    await expect(repository.findRosterProjects(stranger.id)).resolves.toEqual([]);
  });

  it('isOnProjectRoster answers per (agent, project) row (pickup gate)', async () => {
    await expect(repository.isOnProjectRoster(agentId, alphaProjectId)).resolves.toBe(true);
    await expect(repository.isOnProjectRoster(otherAgentId, alphaProjectId)).resolves.toBe(false);
    await expect(repository.isOnProjectRoster(otherAgentId, otherAgentProjectId)).resolves.toBe(true);
  });
});
