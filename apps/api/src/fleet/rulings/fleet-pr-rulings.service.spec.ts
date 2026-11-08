import { FleetPrRulingsService, NAX_ITEM_INDEX_MARKER, type FlowRulingInput } from './fleet-pr-rulings.service';
import type { FleetPrRuling, IFleetPrRulingRepository, NewFleetPrRuling } from './fleet-pr-ruling.domain';
import type { AgentPrincipal, UserPrincipal } from '../../auth/principal/koda-principal.types';
import { ActorUnavailableError } from '../../auth/principal/actor-principal.loader';
import type { AuditRecorder } from '../../audit/audit-recorder.service';
import { currentActor, currentContext, runWithActor } from '../../action-context/action-context';

const targetRepo = { provider: 'github', owner: 'acme', name: 'app', githubInstallationId: 77n };

describe('FleetPrRulingsService', () => {
  const agent: AgentPrincipal = { actorType: 'agent', id: 'agent', slug: 'ruler', status: 'ACTIVE', capabilities: [] };
  const setup = () => {
    const order: string[] = [];
    const repo: IFleetPrRulingRepository = {
      findTarget: vi.fn(async () => { order.push('validate'); return { projectId: 'project', repoId: 'repo', command: 'RUN', outcome: 'draft', prNumber: 42, openItems: [{ id: 'D-1', kind: 'review' }], repo: targetRepo }; }),
      pendingForFix: vi.fn(async () => []), replaceOlderRuns: vi.fn(async () => undefined),
      latestRunForPr: vi.fn(async () => 'run'), latestRuling: vi.fn(async () => null), list: vi.fn(),
      lockTarget: vi.fn(async () => { order.push('lock'); return { projectId: 'project', repoId: 'repo', prNumber: 42, openItems: [{ id: 'D-1', kind: 'review' }], repo: targetRepo }; }),
      replacePending: vi.fn(async () => { order.push('replace'); }),
      insert: vi.fn(async (data: NewFleetPrRuling) => { order.push('insert'); return { ...data, id: 'ruling', createdAt: new Date(), updatedAt: new Date() }; }),
    };
    const tx = { run: vi.fn(async <T>(fn: () => Promise<T>) => { order.push('tx'); return fn(); }), getClient: vi.fn(), isInTransaction: () => true };
    const audit = { record: vi.fn(async () => { order.push('audit'); expect(currentActor()).toEqual({ type: 'AGENT', id: agent.id }); }) };
    return { repo, tx, audit, order, service: new FleetPrRulingsService(repo, tx, audit as unknown as AuditRecorder, { ensureFinishTicket: vi.fn(async () => 'ticket'), createRulingComment: vi.fn(async () => ({ id: 'comment' })) } as never, {} as never, {} as never) };
  };
  it('AC-10/11/12/13: normalizes, attributes, replaces and audits within the transaction', async () => {
    const { service, repo, audit, order } = setup();
    const row = await service.create(agent, 'slug', 'run', { itemId: 'D-1', text: '\n\nconfirm: ok\nmore evidence' });
    expect(row).toMatchObject({ text: 'confirm: ok\nmore evidence', disposition: 'confirmed', state: 'pending', actorType: 'AGENT', actorId: 'agent', repoId: 'repo', prNumber: 42 });
    expect(repo.replacePending).toHaveBeenCalledExactlyOnceWith('run', 'D-1');
    expect(order).toEqual(['tx', 'lock', 'validate', 'replace', 'insert', 'audit']);
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({ key: 'fleet.job.rule', resourceType: 'fleet_job', resourceId: 'run', projectId: 'project', summary: 'ruled D-1: confirmed' });
  });
  it('preserves enclosing approval context', async () => {
    const { service } = setup();
    await runWithActor({ type: 'AGENT', id: agent.id }, async () => {
      const before = currentContext();
      await service.create(agent, 'slug', 'run', { itemId: 'D-1', text: 'verified' });
      expect(currentContext()).toBe(before);
    });
  });
  it.each(['confirm', 'looks fine', `confirm: ${'😀'.repeat(1100)}`, `confirm: ${'x'.repeat(1992)}`])('rejects invalid text without writes: %s', async (text) => {
    const { service, repo } = setup();
    await expect(service.create(agent, 'slug', 'run', { itemId: 'D-1', text })).rejects.toThrow();
    expect(repo.insert).not.toHaveBeenCalled();
    expect(repo.replacePending).not.toHaveBeenCalled();
  });
  it('rejects unknown items without writes', async () => {
    const { service, repo } = setup();
    await expect(service.create(agent, 'slug', 'run', { itemId: 'missing', text: 'verified' })).rejects.toThrow();
    expect(repo.insert).not.toHaveBeenCalled();
  });
  it('attributes user rulings and keeps the approval request', async () => {
    const { service, repo, audit } = setup();
    audit.record.mockImplementation(async () => undefined);
    const { runWithActionContext } = await import('../../action-context/action-context');
    const row = await runWithActionContext({ actor: { type: 'USER', id: 'user' }, origin: 'rest', approval: { requiredMode: 'human', satisfiedBy: 'human', requestId: 'approval' } }, () =>
      service.create({ actorType: 'user', id: 'user', role: 'MEMBER', email: 'u@test.local' }, 'slug', 'run', { itemId: 'D-1', text: 'verified' }));
    expect(row).toMatchObject({ actorType: 'USER', actorId: 'user', approvalRequestId: 'approval' });
    expect(repo.insert).toHaveBeenCalledOnce();
  });
  it('refuses runners before beginning a transaction', async () => {
    const { service, tx } = setup();
    await expect(service.create({ actorType: 'runner', id: 'runner', runnerName: 'runner', labels: [], enabled: true, capacity: 1 }, 'slug', 'run', { itemId: 'D-1', text: 'verified' })).rejects.toThrow('runner principals cannot author domain records');
    expect(tx.run).not.toHaveBeenCalled();
  });
  it('refuses a RUN without a PR without replacing anything', async () => {
    const { service, repo } = setup();
    vi.mocked(repo.lockTarget).mockResolvedValue({ projectId: 'project', repoId: 'repo', prNumber: null, openItems: [{ id: 'D-1', kind: 'review' }], repo: targetRepo });
    await expect(service.create(agent, 'slug', 'run', { itemId: 'D-1', text: 'verified' })).rejects.toThrow();
    expect(repo.replacePending).not.toHaveBeenCalled();
  });
  it('rejects missing jobs without writes', async () => {
    const { service, repo } = setup();
    vi.mocked(repo.lockTarget).mockResolvedValue(null);
    await expect(service.create(agent, 'slug', 'run', { itemId: 'D-1', text: 'verified' })).rejects.toThrow();
    expect(repo.insert).not.toHaveBeenCalled();
  });
});

describe('FleetPrRulingsService flow rulings', () => {
  const creatorPrincipal = { actorType: 'user', id: 'creator', role: 'MEMBER', email: 'creator@test.local' } as unknown as UserPrincipal;
  const flowInput = (over: Partial<FlowRulingInput> = {}): FlowRulingInput => ({
    projectId: 'project', projectSlug: 'slug', runJobId: 'run', itemId: 'D-1', text: 'verified: test green',
    creator: { type: 'USER', id: 'creator' }, approvalRequestId: 'approval-1', flowId: 'f1', ...over,
  });
  const ruling = (over: Partial<FleetPrRuling> = {}): FleetPrRuling => ({
    id: 'ruling-0', projectId: 'project', repoId: 'repo', prNumber: 42, jobId: 'run', itemId: 'D-1',
    itemKind: 'advisor', text: 'verified: test green', disposition: 'verified', actorType: 'USER', actorId: 'creator',
    state: 'pending', skipReason: null, appliedJobId: null, commentId: null, approvalRequestId: null,
    createdAt: new Date(), updatedAt: new Date(), ...over,
  });
  const flowSetup = (openItems: { id: string; kind: string }[] = [{ id: 'D-1', kind: 'advisor' }]) => {
    const order: string[] = [];
    const repo: IFleetPrRulingRepository = {
      findTarget: vi.fn(async () => { order.push('validate'); return { projectId: 'project', repoId: 'repo', command: 'RUN', outcome: 'draft', prNumber: 42, openItems, repo: targetRepo }; }),
      lockTarget: vi.fn(async () => { order.push('lock'); return { projectId: 'project', repoId: 'repo', prNumber: 42, openItems, repo: targetRepo }; }),
      latestRunForPr: vi.fn(async () => 'run'),
      latestRuling: vi.fn(async () => null),
      list: vi.fn(async () => []),
      replacePending: vi.fn(async () => { order.push('replace'); }),
      insert: vi.fn(async (data: NewFleetPrRuling) => { order.push('insert'); return { ...data, id: 'ruling-1', createdAt: new Date(), updatedAt: new Date() }; }),
      pendingForFix: vi.fn(async () => []),
      replaceOlderRuns: vi.fn(async () => undefined),
      settlePending: vi.fn(async () => null),
      runsForPr: vi.fn(async () => []),
    };
    const tx = { run: vi.fn(async <T>(fn: () => Promise<T>) => { order.push('tx'); return fn(); }), getClient: vi.fn(), isInTransaction: () => true };
    const contexts: (ReturnType<typeof currentContext>)[] = [];
    const audit = { record: vi.fn(async () => { order.push('audit'); contexts.push(currentContext()); }) };
    const effects = {
      ensureFinishTicket: vi.fn(async () => 'ticket'),
      createSystemRulingComment: vi.fn(async () => ({ id: 'comment-1' })),
      createRulingComment: vi.fn(async () => ({ id: 'comment' })),
      commentOnRulingResult: vi.fn(async () => undefined),
    };
    const actors = { load: vi.fn(async () => creatorPrincipal) };
    const github = {
      mintThreadReadToken: vi.fn(async () => ({ token: 'ephemeral' })),
      listIssueComments: vi.fn(async () => { order.push('index'); return [`published items ${NAX_ITEM_INDEX_MARKER}`]; }),
    };
    const service = new FleetPrRulingsService(repo, tx, audit as unknown as AuditRecorder, effects as never, github as never, actors as never);
    return { repo, tx, audit, effects, actors, github, order, contexts, service };
  };

  it('AC-1 records a system ruling for an eligible advisor item', async () => {
    const { service, repo } = flowSetup();
    expect(await service.createForFlow(flowInput())).toEqual({ kind: 'recorded', rulingId: 'ruling-1' });
    expect(repo.insert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      projectId: 'project', repoId: 'repo', prNumber: 42, jobId: 'run', itemId: 'D-1', itemKind: 'advisor',
      text: 'verified: test green', disposition: 'verified', actorType: 'SYSTEM', actorId: 'flow',
      state: 'pending', skipReason: null, appliedJobId: null, commentId: 'comment-1', approvalRequestId: 'approval-1',
    }));
  });

  it('AC-2 gates before the transaction and revalidates inside it', async () => {
    const { service, repo, github, order } = flowSetup();
    await service.createForFlow(flowInput());
    expect(order).toEqual(['validate', 'index', 'tx', 'lock', 'validate', 'replace', 'insert', 'audit']);
    expect(repo.findTarget).toHaveBeenCalledTimes(2);
    expect(repo.lockTarget).toHaveBeenCalledExactlyOnceWith('slug', 'run');
    expect(github.listIssueComments).toHaveBeenCalledOnce();
  });

  it('AC-3 refuses a ci item before the transaction', async () => {
    const { service, repo, tx } = flowSetup([{ id: 'C-1', kind: 'ci' }]);
    expect(await service.createForFlow(flowInput({ itemId: 'C-1' }))).toEqual({ kind: 'refused', reason: 'fleet.rulings.notRulable' });
    expect(repo.lockTarget).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
    expect(tx.run).not.toHaveBeenCalled();
  });

  it('AC-4 refuses a pull request without an item index', async () => {
    const { service, repo, github } = flowSetup();
    github.listIssueComments.mockResolvedValue([]);
    expect(await service.createForFlow(flowInput())).toEqual({ kind: 'refused', reason: 'fleet.rulings.noItemIndex' });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('AC-5 refuses a ruling that settled inside the transaction', async () => {
    const { service, repo } = flowSetup();
    let reads = 0;
    vi.mocked(repo.latestRuling).mockImplementation(async () => {
      reads += 1;
      return reads < 3 ? null : ruling({ id: 'old', state: 'applied' });
    });
    expect(await service.createForFlow(flowInput())).toEqual({ kind: 'refused', reason: 'fleet.rulings.settled' });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('AC-6 refuses when the creator principal is unavailable', async () => {
    const { service, repo, actors } = flowSetup();
    actors.load.mockRejectedValue(new ActorUnavailableError({ type: 'USER', id: 'creator' }));
    expect(await service.createForFlow(flowInput())).toEqual({ kind: 'refused', reason: 'creator unavailable' });
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it('AC-7 creates the finish ticket for the loaded creator principal', async () => {
    const { service, effects, actors } = flowSetup();
    await service.createForFlow(flowInput());
    expect(actors.load).toHaveBeenCalledExactlyOnceWith({ type: 'USER', id: 'creator' });
    expect(effects.ensureFinishTicket).toHaveBeenCalledExactlyOnceWith({ id: 'run' }, creatorPrincipal);
  });

  it('AC-8 comments on the finish ticket as the flow and keeps the comment id', async () => {
    const { service, effects, repo } = flowSetup();
    await service.createForFlow(flowInput());
    expect(effects.createSystemRulingComment).toHaveBeenCalledExactlyOnceWith('ticket', 'D-1 (advisor): verified: test green (flow f1)');
    expect(vi.mocked(repo.insert).mock.calls[0][0]).toMatchObject({ commentId: 'comment-1' });
  });

  it('AC-9 replaces the pending ruling before inserting', async () => {
    const { service, repo, order } = flowSetup();
    await service.createForFlow(flowInput());
    expect(repo.replacePending).toHaveBeenCalledExactlyOnceWith('run', 'D-1');
    expect(order.indexOf('replace')).toBeLessThan(order.indexOf('insert'));
  });

  it('AC-10 audits the ruling under the flow key', async () => {
    const { service, audit } = flowSetup();
    await service.createForFlow(flowInput());
    expect(audit.record).toHaveBeenCalledExactlyOnceWith({
      key: 'system.flow.advance', resourceType: 'fleet_job', resourceId: 'run', projectId: 'project',
      summary: 'flow ruled D-1: verified',
    });
  });

  it('AC-11 attributes the write to the flow on behalf of the creator', async () => {
    const { service, contexts } = flowSetup();
    await service.createForFlow(flowInput());
    expect(contexts[0]).toMatchObject({ actor: { type: 'SYSTEM', id: 'flow' }, onBehalfOf: { type: 'USER', id: 'creator' } });
  });

  it('AC-12 returns the same pending system ruling without writing again', async () => {
    const { service, repo, effects, audit } = flowSetup();
    vi.mocked(repo.latestRuling).mockResolvedValue(ruling({ id: 'ruling-9', state: 'pending', actorType: 'SYSTEM', actorId: 'flow' }));
    expect(await service.createForFlow(flowInput({ text: '  verified: test green  ' }))).toEqual({ kind: 'recorded', rulingId: 'ruling-9' });
    expect(repo.insert).not.toHaveBeenCalled();
    expect(effects.createSystemRulingComment).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('AC-13 protects applied rulings and human pending rulings', async () => {
    const { service, repo } = flowSetup();
    vi.mocked(repo.list).mockResolvedValue([
      ruling({ id: 'r3', itemId: 'D-3', state: 'applied' }),
      ruling({ id: 'r2', itemId: 'D-2', state: 'pending', actorType: 'USER' }),
      ruling({ id: 'r1', itemId: 'D-1', state: 'pending', actorType: 'AGENT' }),
    ]);
    expect(await service.ruledItemIds('r1')).toEqual(['D-3', 'D-2', 'D-1']);
  });

  it('AC-14 omits flow pending, skipped and replaced rulings', async () => {
    const { service, repo } = flowSetup();
    vi.mocked(repo.list).mockResolvedValue([
      ruling({ id: 'r4', itemId: 'D-4', state: 'pending', actorType: 'SYSTEM' }),
      ruling({ id: 'r3', itemId: 'D-3', state: 'skipped' }),
      ruling({ id: 'r2', itemId: 'D-2', state: 'replaced' }),
      ruling({ id: 'r1', itemId: 'D-1', state: 'pending', actorType: 'USER' }),
    ]);
    expect(await service.ruledItemIds('r1')).toEqual(['D-1']);
  });

  it('AC-15 comments the refusal on the run ticket', async () => {
    const { service, effects } = flowSetup();
    await service.commentRefused('r1', 'body');
    expect(effects.commentOnRulingResult).toHaveBeenCalledExactlyOnceWith('r1', 'body');
  });

  it('propagates an unknown failure instead of calling it refused', async () => {
    const { service, repo } = flowSetup();
    vi.mocked(repo.findTarget).mockRejectedValue(new Error('database down'));
    await expect(service.createForFlow(flowInput())).rejects.toThrow('database down');
  });

  it('propagates a failed insert instead of reporting a ruling', async () => {
    const { service, repo } = flowSetup();
    vi.mocked(repo.insert).mockRejectedValue(new Error('insert failed'));
    await expect(service.createForFlow(flowInput())).rejects.toThrow('insert failed');
  });
});
