import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { NathApplication } from '@nathapp/nestjs-app';
import type { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { fixtureDb } from '../../helpers/action-context';
import { bootHttpApp, data, TEST_PASSWORD } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';
import { canRunDbTests } from '../../helpers/test-environment';

const describeIntegration = canRunDbTests() ? describe : describe.skip;

describeIntegration('logout audit transaction (PG)', () => {
  let app: NathApplication;
  let db: PrismaClient;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let recorder: AuditRecorder;
  let userId: string;
  let accessToken: string;

  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: true });
    db = fixtureDb(app);
    server = app.getHttpServer();
    recorder = app.get(AuditRecorder);
    const registered = await request(server).post('/api/auth/register').send({
      email: 'logout-audit@koda.test', name: 'Logout Audit', password: TEST_PASSWORD,
    }).expect(201);
    accessToken = data<{ accessToken: string }>(registered).accessToken;
    userId = (await db.user.findUniqueOrThrow({ where: { email: 'logout-audit@koda.test' } })).id;
  });

  afterAll(async () => { await app?.close(); });

  it('writes one USER session.logout entry for the caller', async () => {
    await request(server).post('/api/auth/logout').set('Authorization', `Bearer ${accessToken}`).expect(200);
    const entries = await db.auditEntry.findMany({ where: { key: 'session.logout', resourceId: userId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'session.logout', resourceType: 'user', resourceId: userId,
      actorType: 'USER', actorId: userId, summary: 'logged out',
    });
  });

  it('rolls back tokenVersion when audit recording rejects', async () => {
    const token = (await request(server).post('/api/auth/login').send({
      email: 'logout-audit@koda.test', password: TEST_PASSWORD,
    }).expect(200));
    accessToken = data<{ accessToken: string }>(token).accessToken;
    const before = await db.user.findUniqueOrThrow({ where: { id: userId } });
    const record = vi.spyOn(recorder, 'record').mockRejectedValueOnce(new Error('audit storage unavailable'));

    await request(server).post('/api/auth/logout').set('Authorization', `Bearer ${accessToken}`).expect(500);
    expect((await db.user.findUniqueOrThrow({ where: { id: userId } })).tokenVersion).toBe(before.tokenVersion);
    expect(record).toHaveBeenCalledOnce();
    record.mockRestore();
  });
});
