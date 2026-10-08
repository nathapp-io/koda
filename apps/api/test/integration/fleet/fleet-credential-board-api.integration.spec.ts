/**
 * Fleet S3 §4.4 — credential board route (PG): global admin only, derived from stored capabilities.
 * Run: cd apps/api && bun run test:scoped test/integration/fleet/fleet-credential-board-api.integration.spec.ts
 */
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '../../../src/generated/prisma/client';
import type { RunnerCapabilities } from '../../../src/fleet/common/protocol';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data } from '../../helpers/http-app';
import { FLEET_CAPS, FleetHttpWorld, insertRunner, seedFleetHttpWorld } from '../../helpers/fleet-fixtures';

const describeIntegration = process.env.KODA_DB_TESTS === '1' ? describe : describe.skip;

interface Board {
  warnDays: number;
  runners: Array<{ id: string; name: string; readable: boolean; online: boolean }>;
  providers: Array<{ providerId: string; cells: Record<string, { state: string; kind: string }> }>;
  profiles: Array<{ name: string; runners: Record<string, { present: boolean; misfit?: string }> }>;
}

describeIntegration('fleet credential board API (PG)', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let prisma: PrismaClient;
  let world: FleetHttpWorld;
  const ids: Record<string, string> = {};
  const auth = (who: keyof FleetHttpWorld['tokens']) => ({ Authorization: `Bearer ${world.tokens[who]}` });

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
    server = app.getHttpServer();
    prisma = app.get<PrismaService<PrismaClient>>(PrismaService).client;
    world = await seedFleetHttpWorld(server, prisma);
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();
    ids.mac = (await insertRunner(prisma, {
      name: 'wk-mac',
      capabilities: { ...FLEET_CAPS, credentials: [{ providerId: 'claude', available: true, stored: { kind: 'oauth', expires: soon, expired: false }, ambient: false }] },
    })).id;
    // A stored blob that no longer parses (spec §1.4 of the dashboard): the board lists it unreadable.
    ids.broken = (await insertRunner(prisma, { name: 'broken', capabilities: { not: 'caps' } as unknown as RunnerCapabilities })).id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('refuses project members and outsiders', async () => {
    for (const who of ['dev', 'viewer', 'outsider'] as const) {
      await request(server).get('/api/fleet/credential-board').set(auth(who)).expect(403);
    }
  });

  it('returns the grid and the profile inventory for a global admin', async () => {
    const board = data<Board>(await request(server).get('/api/fleet/credential-board').set(auth('root')).expect(200));
    expect(board.warnDays).toBe(7);
    expect(board.runners.find((r) => r.id === ids.broken)).toMatchObject({ readable: false });
    const claude = board.providers.find((p) => p.providerId === 'claude');
    expect(claude?.cells[ids.mac]).toEqual({ state: 'expiring', kind: 'oauth', expires: expect.any(String) });
    expect(claude?.cells[ids.broken]).toBeUndefined();
    expect(board.profiles.length).toBeGreaterThan(0);
    expect(board.profiles.every((p) => p.runners[ids.mac] !== undefined)).toBe(true);
  });

  it('raises the expiring condition on the admin dashboard', async () => {
    const snap = data<{ attention: Array<{ subjectId: string; conditions?: Array<Record<string, unknown>> }> }>(
      await request(server).get('/api/fleet/dashboard').set(auth('root')).expect(200));
    const item = snap.attention.find((a) => a.subjectId === ids.mac);
    expect(item?.conditions).toEqual(expect.arrayContaining([{ type: 'credential', providerId: 'claude', why: 'expiring' }]));
  });
});
