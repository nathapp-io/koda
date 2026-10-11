import type { Mock } from 'vitest';
import { FleetJobTicketEffects } from './fleet-job-ticket.effects';

describe('FleetJobTicketEffects.onRunDispatched (C9 §3.1, D452)', () => {
  const principal = { actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u@koda.test' } as never;
  const actor = { principal, projectSlug: 'web' };
  const t = (ref: string, status: string) => ({ id: ref, ref, title: ref, status });
  let transitions: { start: Mock };
  let effects: FleetJobTicketEffects;

  beforeEach(() => {
    transitions = { start: vi.fn().mockResolvedValue({}) };
    effects = new FleetJobTicketEffects(transitions as never, {} as never, {} as never, {} as never);
  });

  it('starts CREATED and VERIFIED tickets only, as the requester', async () => {
    await effects.onRunDispatched(actor, [t('WEB-1', 'CREATED'), t('WEB-2', 'VERIFIED'), t('WEB-3', 'IN_PROGRESS'), t('WEB-4', 'VERIFY_FIX')]);
    expect(transitions.start.mock.calls).toEqual([['web', 'WEB-1', principal], ['web', 'WEB-2', principal]]);
  });

  it('keeps going when one transition fails, and never throws', async () => {
    transitions.start.mockRejectedValueOnce(new Error('Ticket state changed concurrently'));
    await expect(effects.onRunDispatched(actor, [t('WEB-1', 'CREATED'), t('WEB-2', 'CREATED')])).resolves.toBeUndefined();
    expect(transitions.start).toHaveBeenCalledTimes(2);
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
    repo = {
      findJobForEffects: vi.fn(),
      findTicketsForJob: vi.fn().mockResolvedValue([linked('t1'), linked('t2')]),
      claimNotified: vi.fn().mockResolvedValue(true),
      createSystemComment: vi.fn().mockImplementation(async (ticketId: string) => ({ id: `c-${ticketId}` })),
      findJobForPrLinks: vi.fn().mockResolvedValue(null),
      upsertFleetPrLink: vi.fn().mockResolvedValue(true),
    };
    events = { record: vi.fn() };
    effects = new FleetJobTicketEffects({} as never, repo as never, events as never, { run: (fn: () => unknown) => fn() } as never);
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
    repo = {
      findJobForEffects: vi.fn().mockResolvedValue(null),
      findJobForPrLinks: vi.fn().mockResolvedValue(prJob('https://github.com/acme/app/pull/9')),
      findTicketsForJob: vi.fn().mockResolvedValue([linked('t1'), linked('t2')]),
      upsertFleetPrLink: vi.fn().mockResolvedValue(true),
    };
    events = { record: vi.fn() };
    effects = new FleetJobTicketEffects({} as never, repo as never, events as never, { run: (fn: () => unknown) => fn() } as never);
  });

  it('links the PR on every linked ticket and records TICKET_UPDATED for each created row', async () => {
    repo.upsertFleetPrLink.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await effects.upsertPrLinks('j1');
    expect(repo.upsertFleetPrLink).toHaveBeenCalledWith({
      ticketId: 't1', jobId: 'j1', url: 'https://github.com/acme/app/pull/9', provider: 'github', prNumber: 9, externalRef: 'acme/app#9', now: expect.any(Date),
    });
    expect(events.record.mock.calls).toEqual([[{
      projectId: 'p', ticketId: 't1', action: 'TICKET_UPDATED', actorId: 'u1', data: { fleetPrLinked: 'https://github.com/acme/app/pull/9', jobId: 'j1' },
    }]]);
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

  it('runs from onTerminal for a COMPLETED job (no comment, PR linked)', async () => {
    repo.findJobForEffects.mockResolvedValue({ id: 'j1', projectId: 'p', projectSlug: 'web', command: 'RUN', state: 'COMPLETED', leaseEpoch: 1, stateReason: null, escalationReason: null, requestedById: 'u1' });
    await effects.onTerminal(['j1']);
    expect(repo.upsertFleetPrLink).toHaveBeenCalledTimes(2);
  });
});
