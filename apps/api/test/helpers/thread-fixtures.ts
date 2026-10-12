import { createHash } from 'crypto';
import { PrismaClient, Prisma } from '../../src/generated/prisma/client';
import request from 'supertest';
import { enrollRunner, FleetHttpWorld } from './fleet-fixtures';

export interface ThreadJobSeed {
  threadId: string;
  jobId: string;
  runnerId: string;
  runnerKey: string;
  feature: string;
}

export interface SeedThreadOptions {
  /** Pending user messages to queue on the thread, in seq order. */
  pending?: string[];
  /** Thread feature, default `add-auth`. */
  feature?: string;
  /** Whether the fixture represents a resumed thread turn. */
  resume?: boolean;
}

export interface ThreadFixtureRunner { runnerId: string; apiKey: string }

/**
 * A THREAD job for the web project's thread: a thread created by dev, a RUNNING THREAD job held by an
 * enrolled runner at lease epoch 1 (firstStartedAt set), its FleetThreadTurn, and optional pending user messages.
 */
export async function seedThreadJob(
  server: Parameters<typeof request>[0],
  prisma: PrismaClient,
  world: FleetHttpWorld,
  options: SeedThreadOptions = {},
): Promise<ThreadJobSeed> {
  const runner = await enrollRunner(server, world.tokens.root, `thread-runner-${Math.random().toString(36).slice(2, 8)}`);
  return seedThreadJobFor(prisma, world, runner, options);
}

/** Seed a THREAD attempt using a runner already enrolled by the suite. */
export async function seedThreadJobFor(
  prisma: PrismaClient,
  world: FleetHttpWorld,
  runner: ThreadFixtureRunner,
  options: SeedThreadOptions = {},
): Promise<ThreadJobSeed> {
  const feature = options.feature ?? 'add-auth';
  const thread = await prisma.chatThread.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, baseRef: 'trunk', feature, title: 'Thread fixture',
      createdById: world.ids.dev, runnerId: runner.runnerId, backend: { kind: 'native', model: 'm1' }, skills: [],
      specPath: `.nax/features/${feature}/spec.md`,
    },
  });
  const job = await prisma.fleetJob.create({
    data: {
      projectId: world.projectId, repoId: world.repoId, ref: 'trunk', command: 'THREAD', feature: `thread-${thread.id}`,
      profiles: [], selectorLabels: [], maxCostUsd: new Prisma.Decimal(5), requestedById: world.ids.dev,
      state: 'RUNNING', runnerId: runner.runnerId, leaseEpoch: 1, firstStartedAt: new Date(), threadId: thread.id,
    },
  });
  await prisma.fleetThreadTurn.create({
    data: {
      jobId: job.id, threadId: thread.id, action: 'SESSION', instructions: 'go', backend: { kind: 'native', model: 'm1' },
      skills: [], resume: options.resume ?? false,
    },
  });
  for (const [i, text] of (options.pending ?? []).entries()) {
    await prisma.chatMessage.create({
      data: { threadId: thread.id, seq: i + 1, role: 'user', authorUserId: world.ids.dev, content: text, status: 'pending' },
    });
  }
  if (options.pending?.length) {
    await prisma.chatThread.update({ where: { id: thread.id }, data: { nextSeq: options.pending.length + 1 } });
  }
  return { threadId: thread.id, jobId: job.id, runnerId: runner.runnerId, runnerKey: runner.apiKey, feature };
}

/**
 * PUTs JSONL lines to the runner `thread` stream of a THREAD job at `offset` (default 0), with the SHA-256 header.
 * Returns the server's `size` after the upload.
 */
export async function putThreadLines(
  server: Parameters<typeof request>[0],
  runnerKey: string,
  job: { id: string; leaseEpoch?: number },
  lines: string[],
  offset = 0,
): Promise<number> {
  const body = Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8');
  const sha = createHash('sha256').update(body).digest('hex');
  const res = await request(server)
    .put(`/api/fleet/runner/jobs/${job.id}/logs/thread?leaseEpoch=${job.leaseEpoch ?? 1}&offset=${offset}`)
    .set({ Authorization: `Bearer ${runnerKey}`, 'content-type': 'application/octet-stream', 'x-content-sha256': sha })
    .send(body)
    .expect(200);
  return (res.body.data as { size: number }).size;
}
