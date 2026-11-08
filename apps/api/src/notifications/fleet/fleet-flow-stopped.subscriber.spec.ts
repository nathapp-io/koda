import { FanOutPublisher } from '../../outbox/fan-out-publisher';
import { NotificationWriter } from '../notification-writer';
import { FleetNotificationReader } from './fleet-notification.reader';
import { FleetFlowStoppedSubscriber } from './fleet-flow-stopped.subscriber';
import { FLEET_FLOW_QUESTIONS, FLEET_FLOW_STOPPED, type FleetFlowQuestionsPayload, type FleetFlowStoppedPayload } from './fleet-notification-events';
import { flowQuestionsDraft, flowStoppedDraft, jobOutcomeDraft } from './fleet-notification-drafts';
import { BODY_MAX } from '../notification.types';

const questionsPayload = (overrides: Partial<FleetFlowQuestionsPayload> = {}): FleetFlowQuestionsPayload => ({
  flowId: 'f1', projectId: 'p1', feature: 'search', step: 'SPEC_REVIEW', jobId: 'j1',
  questions: [{ id: '2', question: 'Which API?' }, { id: '4', question: 'Which format?' }],
  approverId: 'u1', creatorType: 'USER', creatorId: 'u2', ...overrides,
});

const payload = (overrides: Partial<FleetFlowStoppedPayload> = {}): FleetFlowStoppedPayload => ({
  flowId: 'f1', projectId: 'p1', feature: 'search', stopReason: 'step_failed', detail: 'failure',
  approverId: 'u1', creatorType: 'USER', creatorId: 'u2', ...overrides,
});

describe('FleetFlowStoppedSubscriber', () => {
  const register = vi.fn();
  const deliver = vi.fn().mockResolvedValue(undefined);
  const projectSlug = vi.fn().mockResolvedValue('sandbox');
  let subscriber: FleetFlowStoppedSubscriber;
  let handler: (payload: unknown) => Promise<void>;
  let questionsHandler: (payload: unknown) => Promise<void>;

  beforeEach(() => {
    register.mockReset();
    deliver.mockReset().mockResolvedValue(undefined);
    projectSlug.mockReset().mockResolvedValue('sandbox');
    subscriber = new FleetFlowStoppedSubscriber({ register } as unknown as FanOutPublisher,
      { projectSlug } as unknown as FleetNotificationReader, { deliver } as unknown as NotificationWriter);
    subscriber.onModuleInit();
    handler = register.mock.calls[0][1];
    questionsHandler = register.mock.calls[1][1];
  });

  it('registers stopped then questions handlers', () => {
    expect(register.mock.calls.map(([event]) => event)).toEqual([FLEET_FLOW_STOPPED, FLEET_FLOW_QUESTIONS]);
    expect(register.mock.calls[0][1]).toEqual(expect.any(Function));
    expect(register.mock.calls[1][1]).toEqual(expect.any(Function));
  });
  it('builds the questions draft', () => {
    expect(flowQuestionsDraft(questionsPayload(), 'sandbox', 'u1')).toEqual({
      userId: 'u1', projectId: 'p1', category: 'FLEET_NEEDS_YOU', kind: 'flow_questions',
      title: 'Flow needs answers: search', body: '2. Which API? 4. Which format?',
      link: '/sandbox/flows/f1', params: { flowId: 'f1', feature: 'search', step: 'SPEC_REVIEW', count: 2 },
      sourceType: 'fleet_flow', sourceId: 'f1:j1', actorId: null,
    });
  });
  it('bounds the rendered questions body', () => {
    const draft = flowQuestionsDraft(questionsPayload({ questions: [{ id: '1', question: 'x'.repeat(400) }] }), 'sandbox', 'u1');
    expect(draft.body).toHaveLength(BODY_MAX);
    expect(draft.body?.endsWith('…')).toBe(true);
  });
  it('delivers despite a separate questions listener skipping unavailable ticket authors', async () => {
    const publisher = new FanOutPublisher({ recordLastError: vi.fn() } as never);
    const ticketListener = vi.fn(async () => {
      const ticketAuthorsAvailable = { approver: false, creator: false };
      if (!ticketAuthorsAvailable.approver && !ticketAuthorsAvailable.creator) return;
    });
    publisher.register(FLEET_FLOW_QUESTIONS, ticketListener);
    const independentSubscriber = new FleetFlowStoppedSubscriber(publisher,
      { projectSlug } as unknown as FleetNotificationReader, { deliver } as unknown as NotificationWriter);
    independentSubscriber.onModuleInit();

    await publisher.publish({
      id: 'event-1', type: FLEET_FLOW_QUESTIONS, payload: questionsPayload(),
    } as Parameters<FanOutPublisher['publish']>[0]);

    expect(ticketListener).toHaveBeenCalledWith(questionsPayload());
    expect(deliver).toHaveBeenCalledWith([
      flowQuestionsDraft(questionsPayload(), 'sandbox', 'u1'), flowQuestionsDraft(questionsPayload(), 'sandbox', 'u2'),
    ]);
  });
  it('delivers questions to approver and distinct human creator', async () => {
    await questionsHandler(questionsPayload());
    expect(deliver).toHaveBeenCalledWith([
      flowQuestionsDraft(questionsPayload(), 'sandbox', 'u1'), flowQuestionsDraft(questionsPayload(), 'sandbox', 'u2'),
    ]);
  });
  it('deduplicates approver who is also creator and excludes agent creator', async () => {
    const same = questionsPayload({ creatorId: 'u1' });
    await questionsHandler(same);
    expect(deliver).toHaveBeenCalledWith([flowQuestionsDraft(same, 'sandbox', 'u1')]);
    deliver.mockClear();
    const agent = questionsPayload({ creatorType: 'AGENT' });
    await questionsHandler(agent);
    expect(deliver).toHaveBeenCalledWith([flowQuestionsDraft(agent, 'sandbox', 'u1')]);
  });
  it('does not deliver questions when project is gone', async () => {
    projectSlug.mockResolvedValue(null);
    await questionsHandler(questionsPayload());
    expect(deliver).not.toHaveBeenCalled();
  });
  it('warns and skips malformed questions events', async () => {
    const warn = vi.spyOn(subscriber['logger'], 'warn');
    await questionsHandler({ bad: true });
    expect(deliver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed payload skipped'));
  });
  it('keeps stopped notifications intact for approver and human creator', async () => {
    await handler(payload());
    expect(deliver).toHaveBeenCalledWith([
      flowStoppedDraft(payload(), 'sandbox', 'u1'), flowStoppedDraft(payload(), 'sandbox', 'u2'),
    ]);
  });
  it('delivers to approver and distinct human creator', async () => {
    await handler(payload());
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].map((d) => d.userId)).toEqual(['u1', 'u2']);
  });
  it('deduplicates creator when creator is approver', async () => {
    await handler(payload({ creatorId: 'u1' }));
    expect(deliver.mock.calls[0][0].map((d) => d.userId)).toEqual(['u1']);
  });
  it('does not notify an agent creator', async () => {
    await handler(payload({ creatorType: 'AGENT' }));
    expect(deliver.mock.calls[0][0].map((d) => d.userId)).toEqual(['u1']);
  });
  it('does not deliver to an agent without an approver', async () => {
    await handler(payload({ creatorType: 'AGENT', approverId: null }));
    expect(deliver).not.toHaveBeenCalled();
  });
  it('builds the flow stopped notification draft', () => {
    expect(flowStoppedDraft(payload(), 'sandbox', 'u1')).toMatchObject({
      userId: 'u1', category: 'FLEET_NEEDS_YOU', kind: 'flow_stopped', title: 'Flow stopped: search',
      link: '/sandbox/flows/f1', sourceType: 'fleet_flow', sourceId: 'f1', body: 'failure',
      params: { flowId: 'f1', feature: 'search', stopReason: 'step_failed' },
    });
  });
  it('bounds detail body to 280 chars', () => {
    const body = flowStoppedDraft(payload({ detail: 'x'.repeat(400) }), 'sandbox', 'u1').body;
    expect(body).not.toBeNull();
    expect(body?.length).toBeLessThanOrEqual(280);
  });
  it('keeps fleet job drafts body-null', () => {
    const jobPayload = { jobId: 'j1', leaseEpoch: 1, projectId: 'p1', requestedById: 'u1', outcome: 'failed' as const,
      repo: 'owner/repo', feature: 'search', resultPrUrl: null };
    expect(jobOutcomeDraft(jobPayload, 'sandbox').body).toBeNull();
  });
  it('does not deliver when project is gone', async () => {
    projectSlug.mockResolvedValue(null);
    await handler(payload());
    expect(deliver).not.toHaveBeenCalled();
  });
  it('skips malformed events and warns', async () => {
    const warn = vi.spyOn(subscriber['logger'], 'warn');
    await handler({ bad: true });
    expect(deliver).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('malformed payload skipped'));
  });
});
