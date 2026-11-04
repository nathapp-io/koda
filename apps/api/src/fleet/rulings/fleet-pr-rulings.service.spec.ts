import { FleetPrRulingsService } from './fleet-pr-rulings.service';
import type { IFleetPrRulingRepository, NewFleetPrRuling } from './fleet-pr-ruling.domain';
import type { AgentPrincipal } from '../../auth/principal/koda-principal.types';
import type { AuditRecorder } from '../../audit/audit-recorder.service';
import { currentActor, currentContext, runWithActor } from '../../action-context/action-context';

describe('FleetPrRulingsService', () => {
  const agent: AgentPrincipal = { actorType: 'agent', id: 'agent', slug: 'ruler', status: 'ACTIVE', capabilities: [] };
  const setup = () => {
    const order: string[] = [];
    const repo: IFleetPrRulingRepository = {
      findTarget: vi.fn(async () => { order.push('validate'); return { projectId: 'project', repoId: 'repo', command: 'RUN', outcome: 'draft', prNumber: 42, openItems: [{ id: 'D-1', kind: 'review' }] }; }),
      latestRunForPr: vi.fn(async () => 'run'), latestRuling: vi.fn(async () => null), list: vi.fn(),
      lockTarget: vi.fn(async () => { order.push('lock'); return { projectId: 'project', repoId: 'repo', prNumber: 42, openItems: [{ id: 'D-1', kind: 'review' }] }; }),
      replacePending: vi.fn(async () => { order.push('replace'); }),
      insert: vi.fn(async (data: NewFleetPrRuling) => { order.push('insert'); return { ...data, id: 'ruling', createdAt: new Date(), updatedAt: new Date() }; }),
    };
    const tx = { run: vi.fn(async <T>(fn: () => Promise<T>) => { order.push('tx'); return fn(); }), getClient: vi.fn(), isInTransaction: () => true };
    const audit = { record: vi.fn(async () => { order.push('audit'); expect(currentActor()).toEqual({ type: 'AGENT', id: agent.id }); }) };
    return { repo, tx, audit, order, service: new FleetPrRulingsService(repo, tx, audit as unknown as AuditRecorder) };
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
  it.each(['confirm', 'looks fine'])('rejects invalid text without writes: %s', async (text) => {
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
    vi.mocked(repo.lockTarget).mockResolvedValue({ projectId: 'project', repoId: 'repo', prNumber: null, openItems: [{ id: 'D-1', kind: 'review' }] });
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
