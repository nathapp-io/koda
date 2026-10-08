import { PrismaClient } from '../../src/generated/prisma/client';
import request from 'supertest';
import type { RunnerCapabilities, SyncRequest } from '../../src/fleet/common/protocol';
import { AGENT_ROLES } from '../../src/common/enums';
import { data, loginToken, TEST_PASSWORD } from './http-app';

export const FLEET_CAPS: RunnerCapabilities = {
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', available: true, stored: { kind: 'api-key', expired: false }, ambient: false }],
  tools: { git: true, gh: true, glab: true },
  executors: ['host'],
};

let seq = 0;

/** An admin, a project `web` and a GitHub fleet repo acme/app, straight into PG. */
export async function seedFleetBase(prisma: PrismaClient): Promise<{ adminId: string; projectId: string; projectSlug: string; repoId: string }> {
  const admin = await prisma.user.create({ data: { email: `admin${++seq}@koda.test`, passwordHash: 'x', role: 'ADMIN' } });
  const slug = `web${seq}`;
  const project = await prisma.project.create({ data: { name: slug, slug, key: `W${seq}` } });
  const repo = await prisma.fleetRepo.create({
    data: { projectId: project.id, provider: 'github', owner: 'acme', name: `app${seq}`, defaultBranch: 'main', githubInstallationId: BigInt(77), createdById: admin.id },
  });
  return { adminId: admin.id, projectId: project.id, projectSlug: slug, repoId: repo.id };
}

/** A runner row without a usable key (for placement-level tests; HTTP tests enroll instead). */
export async function insertRunner(prisma: PrismaClient, over: Partial<{ name: string; labels: string[]; capacity: number; enabled: boolean; lastSeenAt: Date; capabilities: RunnerCapabilities; bootId: string; createdById: string }> = {}): Promise<{ id: string }> {
  const n = ++seq;
  return prisma.runner.create({
    data: {
      name: over.name ?? `runner-${n}`, apiKeyHash: `hash-${n}`, os: 'linux', arch: 'x64', labels: over.labels ?? ['linux'],
      capacity: over.capacity ?? 1, capabilities: (over.capabilities ?? FLEET_CAPS) as object, daemonVersion: '0.1.0',
      protocolVersion: 1, bootId: over.bootId ?? 'boot-1', enabled: over.enabled ?? true,
      lastSeenAt: over.lastSeenAt ?? new Date(), createdById: over.createdById ?? 'seed',
    },
    select: { id: true },
  });
}

type Who = 'root' | 'dev' | 'viewer' | 'outsider';

export interface FleetHttpWorld {
  tokens: Record<Who, string>;
  ids: Record<Who, string>;
  projectId: string;
  opsProjectId: string;
  repoId: string;
  foreignRepoId: string;
}

/**
 * Root admin (registered), projects `web` and `ops`, users dev (DEVELOPER on web), viewer
 * (VIEWER on web) and outsider (no membership), GitHub fleet repos acme/app on web (default
 * branch `trunk`) and acme/ops on ops, inserted directly (registration is covered by slice 1).
 * Logs in four times: within the 5/min login throttle.
 */
export async function seedFleetHttpWorld(server: Parameters<typeof request>[0], prisma: PrismaClient): Promise<FleetHttpWorld> {
  const tokens = {} as Record<Who, string>;
  const ids = {} as Record<Who, string>;
  tokens.root = data<{ accessToken: string }>(
    await request(server).post('/api/auth/register').send({ email: 'root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201),
  ).accessToken;
  const asRoot = { Authorization: `Bearer ${tokens.root}` };
  for (const slug of ['web', 'ops']) {
    await request(server).post('/api/projects').set(asRoot).send({ name: slug, slug, key: slug.toUpperCase() }).expect(201);
  }
  for (const [who, role] of [['dev', 'DEVELOPER'], ['viewer', 'VIEWER'], ['outsider', null]] as const) {
    await request(server).post('/api/admin/users').set(asRoot).send({ email: `${who}@koda.test`, name: who, password: TEST_PASSWORD, role: 'MEMBER' }).expect(201);
    tokens[who] = await loginToken(server, `${who}@koda.test`);
    if (role) await request(server).post('/api/projects/web/members').set(asRoot).send({ email: `${who}@koda.test`, role }).expect(201);
  }
  for (const who of ['root', 'dev', 'viewer', 'outsider'] as const) {
    ids[who] = (await prisma.user.findUniqueOrThrow({ where: { email: `${who}@koda.test` } })).id;
  }
  const web = await prisma.project.findUniqueOrThrow({ where: { slug: 'web' } });
  const ops = await prisma.project.findUniqueOrThrow({ where: { slug: 'ops' } });
  const repo = (projectId: string, name: string, defaultBranch: string) => prisma.fleetRepo.create({
    data: { projectId, provider: 'github', owner: 'acme', name, defaultBranch, githubInstallationId: BigInt(77), createdById: ids.root },
  });
  return {
    tokens, ids, projectId: web.id, opsProjectId: ops.id,
    repoId: (await repo(web.id, 'app', 'trunk')).id,
    foreignRepoId: (await repo(ops.id, 'ops', 'main')).id,
  };
}

/** Creates an active agent with all permitted roles and a real API key, without changing the user-only world seed. */
export async function seedFleetHttpAgent(
  server: Parameters<typeof request>[0],
  adminToken: string,
): Promise<{ id: string; slug: string; apiKey: string }> {
  const slug = `fleet-agent-${++seq}`;
  const created = data<{ apiKey: string; agent: { id: string; slug: string } }>(
    await request(server).post('/api/agents').set({ Authorization: `Bearer ${adminToken}` })
      .send({ name: slug, slug, roles: [...AGENT_ROLES], capabilities: ['typescript', 'nestjs'] }).expect(201),
  );
  return { id: created.agent.id, slug: created.agent.slug, apiKey: created.apiKey };
}

/** Issues an enrollment token as admin and enrolls a runner over HTTP (enroll is throttled 10/min). */
export async function enrollRunner(
  server: Parameters<typeof request>[0],
  adminToken: string,
  name: string,
  over: { labels?: string[]; capabilities?: RunnerCapabilities; bootId?: string } = {},
): Promise<{ runnerId: string; apiKey: string }> {
  const { token } = data<{ token: string }>(
    await request(server).post('/api/fleet/enrollments').set({ Authorization: `Bearer ${adminToken}` }).send({ labels: over.labels ?? ['linux'] }).expect(201),
  );
  return data(
    await request(server).post('/api/fleet/runner/enroll').send({
      enrollmentToken: token, name, os: 'linux', arch: 'x64', daemonVersion: '0.1.0', protocolVersion: 1,
      bootId: over.bootId ?? 'boot-1', labels: [], capabilities: over.capabilities ?? FLEET_CAPS,
    }).expect(201),
  );
}

export const syncBody = (over: Partial<SyncRequest> = {}): SyncRequest => ({
  protocolVersion: 1, bootId: 'boot-1', daemonVersion: '0.1.0', freeSlots: 0, jobs: [], commandAcks: [], tokenRequests: [], ...over,
});
