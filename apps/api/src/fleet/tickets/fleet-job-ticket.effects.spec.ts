import type { Mock } from 'vitest';
import { FleetJobTicketEffects } from './fleet-job-ticket.effects';
import { currentAuditScope, currentBookkeepingReason, noteAuditWrite, runInAuditScope, UnauditedWriteError } from '../../action-context/audit-coverage';
import { mockAuditRecorder } from '../../common/test-helpers/global-stubs.module';
import { PrismaFleetTicketsRepository } from './prisma-fleet-tickets.repository';

const auditRecord = mockAuditRecorder.record as unknown as Mock;

describe('FleetJobTicketEffects.onRunDispatched (C9 §3.1, D452)', () => {
  const principal = { actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u@koda.test' } as never;
  const actor = { principal, projectSlug: 'web' };
  const t = (ref: string, status: string) => ({ id: ref, ref, title: ref, status });
  let transitions: { startForDispatch: Mock };
  let effects: FleetJobTicketEffects;

  beforeEach(() => {
    auditRecord.mockReset();
    auditRecord.mockImplementation(async () => undefined);
    transitions = { startForDispatch: vi.fn().mockResolvedValue({}) };
    effects = new FleetJobTicketEffects(transitions as never, {} as never, {} as never, {} as never, mockAuditRecorder);
  });

  it('starts CREATED and VERIFIED tickets only, as the requester, through the dispatch-only start', async () => {
    await effects.onRunDispatched(actor, [t('WEB-1', 'CREATED'), t('WEB-2', 'VERIFIED'), t('WEB-3', 'IN_PROGRESS'), t('WEB-4', 'VERIFY_FIX')]);
    expect(transitions.startForDispatch.mock.calls).toEqual([['web', 'WEB-1', principal], ['web', 'WEB-2', principal]]);
  });

  it('keeps going when one transition fails, and never throws', async () => {
    transitions.startForDispatch.mockRejectedValueOnce(new Error('Ticket state changed concurrently'));
    await expect(effects.onRunDispatched(actor, [t('WEB-1', 'CREATED'), t('WEB-2', 'CREATED')])).resolves.toBeUndefined();
    expect(transitions.startForDispatch).toHaveBeenCalledTimes(2);
  });
});

describe('FleetJobTicketEffects.onTerminal (C9 §3.2, D453)', () => {
  const effectJob = (state: string) => ({
    id: 'j1', projectId: 'p', projectSlug: 'web', command: 'RUN', state, leaseEpoch: 3,
    stateReason: 'boom', escalationReason: null, requestedById: 'u1',
  });
  const linked = (ticketId: string) => ({ ticketId, ref: ticketId, title: ticketId, status: 'IN_PROGRESS', notifiedEpoch: null });
  let repo: { findJobForEffects: Mock; findTicketsForJob: Mock; claimNotified: Mock; createSystemComment: Mock; findJobForPrLinks: Mock; upsertFleetPrLink: Mock };
  let events: { record: Mock };
  let effects: FleetJobTicketEffects;

  beforeEach(() => {
    auditRecord.mockReset();
    auditRecord.mockImplementation(async () => undefined);
    repo = {
      findJobForEffects: vi.fn(),
      findTicketsForJob: vi.fn().mockResolvedValue([linked('t1'), linked('t2')]),
      claimNotified: vi.fn().mockResolvedValue(true),
      createSystemComment: vi.fn().mockImplementation(async (ticketId: string) => ({ id: `c-${ticketId}` })),
      findJobForPrLinks: vi.fn().mockResolvedValue(null),
      upsertFleetPrLink: vi.fn().mockResolvedValue('l-t1'),
    };
    events = { record: vi.fn() };
    effects = new FleetJobTicketEffects({} as never, repo as never, events as never, { run: (fn: () => unknown) => fn() } as never, mockAuditRecorder);
  });

  it('AC-3: loads failed-job linked tickets inside the task scope', async () => {
    let observedSurface: string | undefined;
    repo.findJobForEffects.mockResolvedValue(effectJob('FAILED'));
    repo.findTicketsForJob.mockImplementation(async () => {
      observedSurface = currentAuditScope()?.surface;
      return [linked('t1')];
    });
    await effects.onTerminal(['j1']);
    expect(repo.findTicketsForJob).toHaveBeenCalledWith('j1');
    expect(observedSurface).toBe('task:FleetJobTicketEffects.onTerminal');
  });

  it('AC-4: detaches its task scope from a runner sync scope', async () => {
    let observedSurface: string | undefined;
    let observedParent: ReturnType<typeof currentAuditScope>;
    repo.findJobForEffects.mockResolvedValue(effectJob('FAILED'));
    repo.findTicketsForJob.mockImplementation(async () => {
      observedSurface = currentAuditScope()?.surface;
      observedParent = currentAuditScope()?.parent;
      return [linked('t1')];
    });
    await runInAuditScope('POST /fleet/runner/sync', () => effects.onTerminal(['j1']));
    expect(observedSurface).toBe('task:FleetJobTicketEffects.onTerminal');
    expect(observedParent).toBeUndefined();
  });

  it('AC-5: rejects an unaudited write attributed to the detached task scope', async () => {
    vi.stubEnv('ENV_NAME', 'test');
    repo.findJobForEffects.mockResolvedValue(effectJob('FAILED'));
    repo.findTicketsForJob.mockImplementation(async () => {
      noteAuditWrite('TicketLink.update');
      return [linked('t1')];
    });
    repo.claimNotified.mockResolvedValue(false);
    const rejection = await effects.onTerminal(['j1']).catch((error: unknown) => error);
    vi.unstubAllEnvs();
    expect(rejection).toBeInstanceOf(UnauditedWriteError);
    expect(rejection).toMatchObject({ surface: 'task:FleetJobTicketEffects.onTerminal' });
  });

  it('AC-6: claims failure comments under the ticket-comment bookkeeping reason', async () => {
    let observedReason: ReturnType<typeof currentBookkeepingReason>;
    repo.findJobForEffects.mockResolvedValue(effectJob('FAILED'));
    repo.findTicketsForJob.mockResolvedValue([linked('t1')]);
    repo.claimNotified.mockImplementation(async () => {
      observedReason = currentBookkeepingReason();
      return false;
    });
    await effects.onTerminal(['j1']);
    expect(repo.claimNotified).toHaveBeenCalledWith('j1', 't1', 3);
    expect(observedReason).toBe('fleet.ticket-comment-claim');
  });

  it.each(['FAILED', 'ESCALATED', 'CRASHED'])('comments on every linked ticket for %s and records COMMENT_ADDED', async (state) => {
    repo.findJobForEffects.mockResolvedValue(effectJob(state));
    await effects.onTerminal(['j1']);
    expect(repo.claimNotified.mock.calls).toEqual([['j1', 't1', 3], ['j1', 't2', 3]]);
    expect(repo.createSystemComment).toHaveBeenCalledWith('t1', expect.stringContaining(`ended ${state}: boom`));
    expect(events.record).toHaveBeenCalledWith({ projectId: 'p', ticketId: 't2', action: 'COMMENT_ADDED', actorId: 'u1', data: { commentId: 'c-t2' } });
  });

  it.each(['COMPLETED', 'CANCELLED', 'RUNNING'])('writes no failure comment for %s', async (state) => {
    repo.findJobForEffects.mockResolvedValue(effectJob(state));
    await effects.onTerminal(['j1']);
    expect(repo.createSystemComment).not.toHaveBeenCalled();
  });

  it('records comment.create for every new comment, under the job project and the ticket ref', async () => {
    repo.findJobForEffects.mockResolvedValue(effectJob('FAILED'));
    await effects.onTerminal(['j1']);
    expect(auditRecord.mock.calls).toEqual([
      [{ key: 'comment.create', resourceType: 'comment', resourceId: 'c-t1', projectId: 'p', summary: 'on t1' }],
      [{ key: 'comment.create', resourceType: 'comment', resourceId: 'c-t2', projectId: 'p', summary: 'on t2' }],
    ]);
  });

  it('records no comment entry for a ticket whose claim is lost', async () => {
    repo.findJobForEffects.mockResolvedValue(effectJob('FAILED'));
    repo.claimNotified.mockResolvedValueOnce(false);
    await effects.onTerminal(['j1']);
    expect(auditRecord.mock.calls).toEqual([
      [{ key: 'comment.create', resourceType: 'comment', resourceId: 'c-t2', projectId: 'p', summary: 'on t2' }],
    ]);
  });

  it('skips a ticket whose claim is lost (already commented this attempt)', async () => {
    repo.findJobForEffects.mockResolvedValue(effectJob('FAILED'));
    repo.claimNotified.mockResolvedValueOnce(false);
    await effects.onTerminal(['j1']);
    expect(repo.createSystemComment.mock.calls.map((c) => c[0])).toEqual(['t2']);
  });

  it('never throws: one ticket failing does not stop the next, one job failing does not stop the next', async () => {
    repo.findJobForEffects.mockRejectedValueOnce(new Error('db down')).mockResolvedValue(effectJob('FAILED'));
    repo.createSystemComment.mockRejectedValueOnce(new Error('fk'));
    await expect(effects.onTerminal(['jx', 'j1'])).resolves.toBeUndefined();
    expect(repo.createSystemComment.mock.calls.map((c) => c[0])).toEqual(['t1', 't2']);
  });

  it('deduplicates job ids and ignores a missing job', async () => {
    repo.findJobForEffects.mockResolvedValue(null);
    await effects.onTerminal(['j1', 'j1']);
    expect(repo.findJobForEffects).toHaveBeenCalledTimes(1);
  });
});

describe('FleetJobTicketEffects.upsertPrLinks (C9 §3.3, D455)', () => {
  const prJob = (resultPrUrl: string | null) => ({
    id: 'j1', projectId: 'p', requestedById: 'u1', resultPrUrl, repo: { provider: 'github' as const, owner: 'acme', name: 'app' },
  });
  const linked = (ticketId: string) => ({ ticketId, ref: ticketId, title: ticketId, status: 'IN_PROGRESS', notifiedEpoch: null });
  let repo: Record<string, Mock>;
  let events: { record: Mock };
  let effects: FleetJobTicketEffects;

  beforeEach(() => {
    auditRecord.mockReset();
    auditRecord.mockImplementation(async () => undefined);
    repo = {
      findJobForEffects: vi.fn().mockResolvedValue(null),
      findJobForPrLinks: vi.fn().mockResolvedValue(prJob('https://github.com/acme/app/pull/9')),
      findTicketsForJob: vi.fn().mockResolvedValue([linked('t1'), linked('t2')]),
      upsertFleetPrLink: vi.fn().mockResolvedValue('l-t1'),
    };
    events = { record: vi.fn() };
    effects = new FleetJobTicketEffects({} as never, repo as never, events as never, { run: (fn: () => unknown) => fn() } as never, mockAuditRecorder);
  });

  it('links the PR on every linked ticket and records TICKET_UPDATED for each created row', async () => {
    repo.upsertFleetPrLink.mockResolvedValueOnce('l-t1').mockResolvedValueOnce(null);
    await effects.upsertPrLinks('j1');
    expect(repo.upsertFleetPrLink).toHaveBeenCalledWith({
      ticketId: 't1', jobId: 'j1', url: 'https://github.com/acme/app/pull/9', provider: 'github', prNumber: 9, externalRef: 'acme/app#9', now: expect.any(Date),
    });
    expect(events.record.mock.calls).toEqual([[{
      projectId: 'p', ticketId: 't1', action: 'TICKET_UPDATED', actorId: 'u1', data: { fleetPrLinked: 'https://github.com/acme/app/pull/9', jobId: 'j1' },
    }]]);
  });

  it('records ticket.link.add for a created link, with the job project and the ticket ref', async () => {
    await effects.upsertPrLinks('j1');
    expect(auditRecord.mock.calls).toEqual([
      [{ key: 'ticket.link.add', resourceType: 'ticket-link', resourceId: 'l-t1', projectId: 'p', summary: 'on t1' }],
      [{ key: 'ticket.link.add', resourceType: 'ticket-link', resourceId: 'l-t1', projectId: 'p', summary: 'on t2' }],
    ]);
  });

  it('AC-18: records nothing when upsertFleetPrLink answered null', async () => {
    // Control first: a created link does record, so the silence below is the null branch and not a path
    // that never records at all.
    repo.upsertFleetPrLink.mockResolvedValueOnce('l-t1').mockResolvedValue(null);
    await effects.upsertPrLinks('j1');
    expect(auditRecord.mock.calls).toEqual([
      [{ key: 'ticket.link.add', resourceType: 'ticket-link', resourceId: 'l-t1', projectId: 'p', summary: 'on t1' }],
    ]);

    // AC-18: both links already existed, so neither upsert answers an id.
    auditRecord.mockClear();
    repo.upsertFleetPrLink.mockResolvedValue(null);
    await effects.upsertPrLinks('j1');
    expect(repo.upsertFleetPrLink).toHaveBeenCalledTimes(4);
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('does nothing without a resultPrUrl', async () => {
    repo.findJobForPrLinks.mockResolvedValue(prJob(null));
    await effects.upsertPrLinks('j1');
    expect(repo.upsertFleetPrLink).not.toHaveBeenCalled();
  });

  it("ignores a PR URL that does not name the job's repo", async () => {
    repo.findJobForPrLinks.mockResolvedValue(prJob('https://github.com/evil/fork/pull/9'));
    await effects.upsertPrLinks('j1');
    expect(repo.upsertFleetPrLink).not.toHaveBeenCalled();
  });

  it('keeps going when one ticket fails, and never throws', async () => {
    repo.upsertFleetPrLink.mockRejectedValueOnce(new Error('fk'));
    await expect(effects.upsertPrLinks('j1')).resolves.toBeUndefined();
    expect(repo.upsertFleetPrLink).toHaveBeenCalledTimes(2);
    repo.findJobForPrLinks.mockRejectedValueOnce(new Error('db down'));
    await expect(effects.upsertPrLinks('j1')).resolves.toBeUndefined();
  });

  it('AC-7/AC-8: marks an existing PR link refresh as bookkeeping and returns null', async () => {
    let observedReason: ReturnType<typeof currentBookkeepingReason>;
    const prisma = {
      client: {
        ticketLink: {
          createManyAndReturn: vi.fn().mockResolvedValue([]),
          updateMany: vi.fn().mockImplementation(async () => {
            observedReason = currentBookkeepingReason();
            return { count: 1 };
          }),
        },
      },
    };
    const persistence = new PrismaFleetTicketsRepository(prisma as never);
    repo.findJobForEffects.mockResolvedValue({ id: 'j1', projectId: 'p', projectSlug: 'web', command: 'RUN', state: 'COMPLETED', leaseEpoch: 1, stateReason: null, escalationReason: null, requestedById: 'u1' });
    repo.findJobForPrLinks.mockResolvedValue(prJob('https://github.com/acme/app/pull/9'));
    repo.findTicketsForJob.mockResolvedValue([linked('t1')]);
    repo.upsertFleetPrLink.mockImplementation((input) => persistence.upsertFleetPrLink(input as never));

    await effects.onTerminal(['j1']);
    expect(prisma.client.ticketLink.updateMany).toHaveBeenCalledWith({
      where: { ticketId: 't1', url: 'https://github.com/acme/app/pull/9' }, data: { jobId: 'j1' },
    });
    expect(observedReason).toBe('fleet.pr-link-job');
    expect(await persistence.upsertFleetPrLink({
      ticketId: 't1', jobId: 'j1', url: 'https://github.com/acme/app/pull/9', provider: 'github', prNumber: 9,
      externalRef: 'acme/app#9', now: new Date(),
    })).toBeNull();
  });

  it('runs from onTerminal for a COMPLETED job (no comment, PR linked)', async () => {
    repo.findJobForEffects.mockResolvedValue({ id: 'j1', projectId: 'p', projectSlug: 'web', command: 'RUN', state: 'COMPLETED', leaseEpoch: 1, stateReason: null, escalationReason: null, requestedById: 'u1' });
    await effects.onTerminal(['j1']);
    expect(repo.upsertFleetPrLink).toHaveBeenCalledTimes(2);
  });
});
