import { Logger } from '@nestjs/common';
import request from 'supertest';
import { NathApplication } from '@nathapp/nestjs-app';
import { PrismaClient } from '../../../src/generated/prisma/client';
import { AuditRecorder } from '../../../src/audit/audit-recorder.service';
import { runAsSystem } from '../../../src/action-context/action-context';
import { FleetJobTicketEffects } from '../../../src/fleet/tickets/fleet-job-ticket.effects';
import { PrismaTicketsRepository } from '../../../src/tickets/prisma-tickets.repository';
import { TicketsService } from '../../../src/tickets/tickets.service';
import { TicketStatus } from '../../../src/common/enums';
import type { UserPrincipal } from '../../../src/auth/principal/koda-principal.types';
import { canRunDbTests } from '../../helpers/test-environment';
import { resetDb } from '../../helpers/reset-db';
import { bootHttpApp, data, resetThrottle, TEST_PASSWORD } from '../../helpers/http-app';
import { fixtureDb } from '../../helpers/action-context';

const describeDb = canRunDbTests() ? describe : describe.skip;
describeDb('audited ticket transitions', () => {
  let app: NathApplication;
  let server: ReturnType<NathApplication['getHttpServer']>;
  let db: PrismaClient;
  let token: string;
  let projectId: string;
  let principal: UserPrincipal;
  const slug = 'audit-transitions';
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const url = (ref: string) => `/api/projects/${slug}/tickets/${ref}`;
  beforeAll(async () => {
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false, ownerEmail: null });
    server = app.getHttpServer();
    db = fixtureDb(app);
    const res = await request(server).post('/api/auth/register').send({ email: 'transition-root@koda.test', name: 'Root', password: TEST_PASSWORD }).expect(201);
    token = data<{ accessToken: string }>(res).accessToken;
    const user = await db.user.findUniqueOrThrow({ where: { email: 'transition-root@koda.test' } });
    principal = { actorType: 'user', id: user.id, email: user.email, name: user.name, role: 'MEMBER', authorities: [], blacklisted: false, revoked: false, extra: {} };
    const project = await request(server).post('/api/projects').set(auth()).send({ name: 'Audit', slug, key: 'ATR' }).expect(201);
    projectId = data<{ id: string }>(project).id;
  }, 60_000);
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { resetThrottle(app); });
  afterEach(() => { vi.restoreAllMocks(); });
  const rows = (id: string) => db.auditEntry.findMany({ where: { resourceId: id }, take: 100 });
  const fixture = async (status: string) => {
    const res = await request(server).post(`/api/projects/${slug}/tickets`).set(auth()).send({ type: 'BUG', title: 'private fixture' }).expect(201);
    const target = data<{ id: string; ref: string }>(res);
    // Seed state directly so each assertion observes only this operation's audit entries.
    await db.ticket.update({ where: { id: target.id }, data: { status } });
    await db.auditEntry.deleteMany({ where: { resourceId: target.id } });
    return target;
  };

  it.each([
    ['AC-1,2', 'CREATED', 'verify', 'VERIFIED', 'verify'],
    ['AC-3', 'VERIFIED', 'start', 'IN_PROGRESS', 'start'],
    ['AC-4', 'IN_PROGRESS', 'fix', 'VERIFY_FIX', 'fix'],
    ['AC-5', 'VERIFY_FIX', 'verify-fix?approve=true', 'CLOSED', 'verify-fix.approve'],
    ['AC-6', 'VERIFY_FIX', 'verify-fix', 'IN_PROGRESS', 'verify-fix.return'],
    ['AC-7', 'VERIFY_FIX', 'verify', 'CLOSED', 'verify-fix.approve'],
    ['AC-8', 'CREATED', 'reject', 'REJECTED', 'reject'],
    ['AC-9', 'VERIFIED', 'close', 'CLOSED', 'close'],
  ])('%s: %s via %s records the exact edge', async (_ac, from, route, to, key) => {
    const target = await fixture(from);
    await request(server).post(`${url(target.ref)}/${route}`).set(auth()).send({ body: 'private comment', reason: 'private reason' }).expect(200);
    const entries = await rows(target.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: `ticket.transition.${key}`, summary: `status: ${from} -> ${to}`, resourceType: 'ticket', resourceId: target.id, projectId });
  });

  it('AC-10..12: mixed PATCH commits exactly two entries', async () => {
    const target = await fixture('VERIFIED');
    await request(server).patch(url(target.ref)).set(auth()).send({ status: 'IN_PROGRESS', priority: 'LOW' }).expect(200);
    const entries = await rows(target.id);
    expect(entries).toHaveLength(2);
    expect(entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'ticket.transition.start', summary: 'status: VERIFIED -> IN_PROGRESS' }),
      expect.objectContaining({ key: 'ticket.update', summary: 'fields: priority' }),
    ]));
  });
  it('status-only PATCH records no field entry', async () => {
    const target = await fixture('VERIFIED');
    await request(server).patch(url(target.ref)).set(auth()).send({ status: 'IN_PROGRESS' }).expect(200);
    expect(await rows(target.id)).toEqual([expect.objectContaining({ key: 'ticket.transition.start' })]);
  });
  it('status with only dropped fields records no field entry', async () => {
    const target = await fixture('VERIFIED');
    // Exercise the service seam before HTTP DTO whitelisting drops unknown keys.
    const patch = { status: TicketStatus.IN_PROGRESS, dropped: 'not writable' };
    await runAsSystem('schedule', () => app.get(TicketsService).update(slug, target.ref, patch, principal));
    expect(await rows(target.id)).toEqual([expect.objectContaining({ key: 'ticket.transition.start' })]);
  });
  it('empty PATCH records no update entry', async () => {
    const target = await fixture('VERIFIED');
    await request(server).patch(url(target.ref)).set(auth()).send({}).expect(200);
    expect(await rows(target.id)).toHaveLength(0);
  });
  it('mixed PATCH audit failure rolls back fields, status, activities and the first entry', async () => {
    const target = await fixture('VERIFIED');
    const before = await db.ticket.findUniqueOrThrow({ where: { id: target.id } });
    const recorder = app.get(AuditRecorder);
    const record = recorder.record.bind(recorder);
    vi.spyOn(recorder, 'record').mockImplementation(async (entry) => {
      await record(entry);
      if (entry.key === 'ticket.transition.start') throw new Error('audit unavailable');
    });
    await request(server).patch(url(target.ref)).set(auth()).send({ status: 'IN_PROGRESS', priority: 'LOW' }).expect(500);
    expect(await db.ticket.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ status: before.status, priority: before.priority });
    expect(await db.ticketActivity.count({ where: { ticketId: target.id, action: 'STATUS_CHANGE' } })).toBe(0);
    expect(await rows(target.id)).toHaveLength(0);
  });
  it('AC-13..15: lost race rolls back comments and audit', async () => {
    const target = await fixture('CREATED');
    vi.spyOn(PrismaTicketsRepository.prototype, 'updateTicketStatusIf').mockResolvedValueOnce(null);
    await request(server).post(`${url(target.ref)}/verify`).set(auth()).send({ body: 'private comment' }).expect(409);
    expect(await rows(target.id)).toHaveLength(0);
    expect(await db.comment.count({ where: { ticketId: target.id } })).toBe(0);
  });
  it('AC-16: invalid transition records nothing', async () => {
    const target = await fixture('CREATED');
    await request(server).post(`${url(target.ref)}/fix`).set(auth()).send({ body: 'private comment' }).expect(400);
    expect(await rows(target.id)).toHaveLength(0);
  });
  const dispatch = (target: { id: string; ref: string }) => runAsSystem('schedule', () => app.get(FleetJobTicketEffects).onRunDispatched(
    { projectSlug: slug, principal }, [{ ...target, status: 'VERIFIED' }],
  ));
  it('AC-17: dispatch inherits the schedule action context', async () => {
    const target = await fixture('VERIFIED');
    await dispatch(target);
    expect(await rows(target.id)).toEqual([expect.objectContaining({ key: 'ticket.transition.start', actorType: 'SYSTEM', actorId: 'schedule' })]);
  });
  it('AC-18..21: dispatch audit failure rolls back, warns and resolves', async () => {
    const target = await fixture('VERIFIED');
    vi.spyOn(app.get(AuditRecorder), 'record').mockRejectedValueOnce(new Error('audit unavailable'));
    const warn = vi.spyOn(Logger.prototype, 'warn');
    warn.mockClear();
    await expect(dispatch(target)).resolves.toBeUndefined();
    expect((await db.ticket.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('VERIFIED');
    expect(await rows(target.id)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(`Fleet ticket ${target.ref}: start failed: audit unavailable`);
  });
});
