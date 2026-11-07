import { Logger } from '@nestjs/common';
import { currentContext } from '../../action-context/action-context';
import { currentBookkeepingReason } from '../../action-context/audit-coverage';
import { ActorUnavailableError } from '../../auth/principal/actor-principal.loader';
import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { FLEET_FLOW_STOPPED, type FleetFlowStoppedPayload } from '../../notifications/fleet/fleet-notification-events';
// Load lazily so each criterion reports its own failure while the subscriber is not yet implemented.
let FleetFlowStopTicketSubscriber: typeof import('./fleet-flow-stop-ticket.subscriber').FleetFlowStopTicketSubscriber;
beforeEach(async () => { ({ FleetFlowStopTicketSubscriber } = await import('./fleet-flow-stop-ticket.subscriber')); });

const payload: FleetFlowStoppedPayload = {
  flowId: 'f1', projectId: 'p1', feature: 'checkout', stopReason: 'review_ambiguous',
  detail: 'Which currency?', approverId: 'u2', creatorType: 'AGENT', creatorId: 'a1',
};
const creator = { actorType: 'agent', id: 'a1' };
const approver = { actorType: 'user', id: 'u2' };

function fixture() {
  let inTransaction = false;
  const order: string[] = [];
  const flow = { id: 'f1', branch: 'feat/checkout', ticketId: null as string | null };
  const locked = () => { expect(inTransaction).toBe(true); };
  const flows = { lockById: vi.fn(async () => { locked(); order.push('lock'); return flow; }) };
  const steps = {
    projectSlug: vi.fn(async () => { locked(); return 'shop'; }),
    setTicket: vi.fn(async (_id: string, ticketId: string) => {
      locked(); order.push('link');
      expect(currentBookkeepingReason()).toBe('fleet.flow-bookkeeping');
      flow.ticketId = ticketId;
      return true;
    }),
  };
  const actors = { load: vi.fn().mockResolvedValue(creator) };
  const tickets = { create: vi.fn(async () => { locked(); order.push('create'); return { id: 't1' }; }) };
  const effects = { commentOnFlowTicket: vi.fn(async () => { locked(); order.push('comment'); }) };
  const tx = { run: vi.fn(async (fn: () => Promise<void>) => {
    expect(currentContext()).toMatchObject({ actor: { type: 'SYSTEM', id: 'flow' }, onBehalfOf: { type: 'AGENT', id: 'a1' }, origin: 'system' });
    inTransaction = true;
    try { await fn(); } finally { inTransaction = false; order.push('commit'); }
  }) };
  const registry = new FanOutPublisher({ recordLastError: vi.fn() });
  const register = vi.spyOn(registry, 'register');
  const subscriber = new FleetFlowStopTicketSubscriber(registry, flows as never, steps as never, actors as never, tickets as never, effects as never, tx as never);
  subscriber.onModuleInit();
  const handle = (p: unknown = payload) => registry.getHandlers(FLEET_FLOW_STOPPED)[0](p);
  return { flows, flow, steps, actors, tickets, effects, tx, registry, register, subscriber, handle, order };
}

describe('FleetFlowStopTicketSubscriber', () => {
  it('AC-1: registers the fleet_flow_stopped handler in onModuleInit', () => {
    const f = fixture();
    expect(f.register).toHaveBeenCalledWith('fleet_flow_stopped', expect.any(Function));
    expect(f.registry.getHandlers(FLEET_FLOW_STOPPED)).toHaveLength(1);
  });

  it('AC-2: loads the creator and creates the TASK with the project slug and flow branch', async () => {
    const f = fixture();
    await f.handle();
    expect(f.flows.lockById).toHaveBeenCalledWith('f1');
    expect(f.steps.projectSlug).toHaveBeenCalledWith('p1');
    expect(f.actors.load).toHaveBeenCalledExactlyOnceWith({ type: 'AGENT', id: 'a1' });
    expect(f.tickets.create).toHaveBeenCalledExactlyOnceWith('shop', {
      type: 'TASK', title: 'Fleet flow: checkout', description: 'Flow f1 on feat/checkout',
    }, creator);
  });

  it('AC-3: links the new ticket under bookkeeping before commenting and committing', async () => {
    const f = fixture();
    await f.handle();
    expect(f.steps.setTicket).toHaveBeenCalledExactlyOnceWith('f1', 't1');
    expect(f.order).toEqual(['lock', 'create', 'link', 'comment', 'commit']);
  });

  it('AC-4: comments on the created flow ticket with the stop reason and detail', async () => {
    const f = fixture();
    await f.handle();
    expect(f.effects.commentOnFlowTicket).toHaveBeenCalledExactlyOnceWith('t1', 'p1', 'Flow stopped (review_ambiguous): Which currency?');
  });

  it('AC-5: runs the registered handler as system flow on the payload creator’s behalf', async () => {
    const f = fixture();
    f.actors.load.mockImplementation(async () => {
      expect(currentContext()).toMatchObject({ actor: { type: 'SYSTEM', id: 'flow' }, onBehalfOf: { type: 'AGENT', id: 'a1' } });
      return creator;
    });
    await f.handle();
    expect(f.tx.run).toHaveBeenCalledTimes(1);
    expect(currentContext()).toBeUndefined();
  });

  it('AC-6: reuses the existing ticket even if no author is available', async () => {
    const f = fixture();
    f.flow.ticketId = 'existing';
    f.actors.load.mockRejectedValue(new ActorUnavailableError(null));
    await f.handle();
    expect(f.actors.load).not.toHaveBeenCalled();
    expect(f.tickets.create).not.toHaveBeenCalled();
    expect(f.steps.setTicket).not.toHaveBeenCalled();
    expect(f.effects.commentOnFlowTicket).toHaveBeenCalledExactlyOnceWith('existing', 'p1', 'Flow stopped (review_ambiguous): Which currency?');
  });

  it('AC-7: falls back to the approver only when the creator is unavailable', async () => {
    const f = fixture();
    f.actors.load.mockRejectedValueOnce(new ActorUnavailableError({ type: 'AGENT', id: 'a1' })).mockResolvedValueOnce(approver);
    await f.handle();
    expect(f.actors.load.mock.calls).toEqual([[{ type: 'AGENT', id: 'a1' }], [{ type: 'USER', id: 'u2' }]]);
    expect(f.tickets.create).toHaveBeenCalledWith('shop', expect.any(Object), approver);
  });

  it('AC-8: unavailable authors skip ticket writes but do not suppress independent notification fan-out', async () => {
    const f = fixture();
    f.actors.load.mockRejectedValue(new ActorUnavailableError(null));
    const notification = vi.fn();
    f.registry.register(FLEET_FLOW_STOPPED, notification);
    await f.registry.publish({ id: 'e1', type: FLEET_FLOW_STOPPED, payload } as never);
    expect(notification).toHaveBeenCalledExactlyOnceWith(payload);
    expect(f.tickets.create).not.toHaveBeenCalled();
    expect(f.effects.commentOnFlowTicket).not.toHaveBeenCalled();
  });

  it('AC-9: a missing flow creates and comments on nothing', async () => {
    const f = fixture();
    f.flows.lockById.mockResolvedValue(null as never);
    await f.handle();
    expect(f.steps.projectSlug).not.toHaveBeenCalled();
    expect(f.tickets.create).not.toHaveBeenCalled();
    expect(f.effects.commentOnFlowTicket).not.toHaveBeenCalled();
  });

  it('AC-10: a missing or deleted project creates no ticket or comment', async () => {
    const f = fixture();
    f.steps.projectSlug.mockResolvedValue(null as never);
    await f.handle();
    expect(f.actors.load).not.toHaveBeenCalled();
    expect(f.tickets.create).not.toHaveBeenCalled();
    expect(f.effects.commentOnFlowTicket).not.toHaveBeenCalled();
  });

  it('AC-11: malformed payloads never enter the transaction or create tickets', async () => {
    const f = fixture();
    for (const bad of [null, {}, { ...payload, creatorType: 'RUNNER' }, { ...payload, flowId: '' }]) await f.handle(bad);
    expect(f.tx.run).not.toHaveBeenCalled();
    expect(f.tickets.create).not.toHaveBeenCalled();
    expect(f.effects.commentOnFlowTicket).not.toHaveBeenCalled();
  });

  it('AC-14: logs a warning for a malformed fleet_flow_stopped payload', async () => {
    const f = fixture();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockClear();
    await f.handle({});
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/fleet_flow_stopped.*malformed/));
  });

  it('AC-15: logs before returning when neither author is available', async () => {
    const f = fixture();
    f.actors.load.mockRejectedValue(new ActorUnavailableError(null));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockClear();
    await f.handle();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/f1.*(author|unavailable)/));
    expect(f.tickets.create).not.toHaveBeenCalled();
    expect(f.effects.commentOnFlowTicket).not.toHaveBeenCalled();
  });

  it('skips without an approver after creator unavailability', async () => {
    const f = fixture();
    f.actors.load.mockRejectedValue(new ActorUnavailableError(null));
    await f.handle({ ...payload, approverId: null });
    expect(f.actors.load).toHaveBeenCalledTimes(1);
    expect(f.tickets.create).not.toHaveBeenCalled();
    expect(f.effects.commentOnFlowTicket).not.toHaveBeenCalled();
  });

  it.each(['creator', 'approver', 'create', 'link', 'comment'])('propagates %s database failures for outbox retry', async (stage) => {
    const f = fixture();
    const error = new Error('database unavailable');
    if (stage === 'creator') f.actors.load.mockRejectedValue(error);
    if (stage === 'approver') f.actors.load.mockRejectedValueOnce(new ActorUnavailableError(null)).mockRejectedValueOnce(error);
    if (stage === 'create') f.tickets.create.mockRejectedValue(error);
    if (stage === 'link') f.steps.setTicket.mockRejectedValue(error);
    if (stage === 'comment') f.effects.commentOnFlowTicket.mockRejectedValue(error);
    await expect(f.handle()).rejects.toBe(error);
    if (stage === 'creator' || stage === 'approver') expect(f.tickets.create).not.toHaveBeenCalled();
  });

  it('replays under the same lock, reuses the ticket, and never creates a second one', async () => {
    const f = fixture();
    await f.handle();
    await f.handle();
    expect(f.flows.lockById).toHaveBeenCalledTimes(2);
    expect(f.tickets.create).toHaveBeenCalledTimes(1);
    expect(f.steps.setTicket).toHaveBeenCalledTimes(1);
    expect(f.effects.commentOnFlowTicket).toHaveBeenCalledTimes(2);
  });
});
