import { FleetJobTicketEffects } from './fleet-job-ticket.effects';

describe('FleetJobTicketEffects.onRunDispatched (C9 §3.1, D452)', () => {
  const principal = { actorType: 'user', id: 'u1', role: 'MEMBER', email: 'u@koda.test' } as never;
  const actor = { principal, projectSlug: 'web' };
  const t = (ref: string, status: string) => ({ id: ref, ref, title: ref, status });
  let transitions: { start: jest.Mock };
  let effects: FleetJobTicketEffects;

  beforeEach(() => {
    transitions = { start: jest.fn().mockResolvedValue({}) };
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
