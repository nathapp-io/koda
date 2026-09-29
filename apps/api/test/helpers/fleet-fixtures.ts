import { PrismaClient } from '@prisma/client';
import type { RunnerCapabilities } from '../../src/fleet/common/protocol';

export const FLEET_CAPS: RunnerCapabilities = {
  nax: { version: '0.83.0', protocols: ['native'] },
  sandbox: { available: true, probedAt: '2026-10-01T00:00:00.000Z' },
  profiles: { fast: { protocol: 'native', providers: ['deepseek'], sandbox: false } },
  credentials: [{ providerId: 'deepseek', kind: 'api-key' }],
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
