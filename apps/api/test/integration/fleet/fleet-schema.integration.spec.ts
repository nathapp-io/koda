/**
 * Fleet S1 slice 1 — the four fleet tables exist with their constraints (PG).
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-schema.integration.spec.ts
 */
import { resetDb } from '../../helpers/reset-db';
import { createTestPrismaClient } from '../../helpers/test-prisma';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

describeIntegration('fleet schema (PG)', () => {
  const prisma = createTestPrismaClient();

  beforeAll(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  const runnerData = (name: string, apiKeyHash: string) => ({
    name,
    apiKeyHash,
    os: 'linux',
    arch: 'x64',
    labels: ['linux', 'gpu'],
    capabilities: { nax: { version: '0.83.0', protocols: ['native'] } },
    daemonVersion: '0.1.0',
    protocolVersion: 1,
    bootId: 'boot-1',
    lastSeenAt: new Date(),
    createdById: 'user-1',
  });

  it('stores labels as an array and capabilities as JSON', async () => {
    const r = await prisma.runner.create({ data: runnerData('r1', 'h1') });
    expect(r.labels).toEqual(['linux', 'gpu']);
    expect(r.capabilities).toEqual({ nax: { version: '0.83.0', protocols: ['native'] } });
    expect(r.capacity).toBe(1);
    expect(r.enabled).toBe(true);
  });

  it('rejects a duplicate runner name and a duplicate key hash', async () => {
    await expect(prisma.runner.create({ data: runnerData('r1', 'h2') })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.runner.create({ data: runnerData('r2', 'h1') })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('keeps a BigInt installation id and cascades repos with their project', async () => {
    const project = await prisma.project.create({ data: { name: 'P', slug: 'p', key: 'P' } });
    const repo = await prisma.fleetRepo.create({
      data: {
        projectId: project.id, provider: 'github', owner: 'acme', name: 'app',
        defaultBranch: 'main', githubInstallationId: BigInt('9007199254740993'), createdById: 'user-1',
      },
    });
    expect(repo.githubInstallationId).toBe(BigInt('9007199254740993'));
    await expect(
      prisma.fleetRepo.create({
        data: { projectId: project.id, provider: 'github', owner: 'acme', name: 'app', defaultBranch: 'main', createdById: 'u' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await prisma.project.delete({ where: { id: project.id } });
    expect(await prisma.fleetRepo.count()).toBe(0);
  });
});
