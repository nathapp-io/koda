import { Test, TestingModule } from '@nestjs/testing';
import { TRANSACTION_MANAGER } from '@nathapp/nestjs-data';
import { AgentsService } from './agents.service';
import { PrismaAgentRepository } from './prisma-agent.repository';
import { AUTH_CFG } from '../config/auth.config';
import { MembershipService } from '../permissions/membership.service';
import { PermissionService } from '../permissions/permission.service';
import { AuditRecorder, AuditEntriesOf } from '../audit/audit-recorder.service';

const agent = { id: 'agent-id', slug: 'audit-agent', name: 'Agent', status: 'ACTIVE', apiKeyHash: 'hash', maxConcurrentTickets: 3, createdAt: new Date(), updatedAt: new Date(), capabilities: [] };

describe('AgentsService audit boundaries', () => {
  let module: TestingModule;
  let service: AgentsService;
  let inAudit: boolean;
  let inMembership: boolean;
  const record = vi.fn();
  const audited = vi.fn(async <T>(fn: () => Promise<T>, entriesOf: AuditEntriesOf<T>) => {
    expect(inAudit).toBe(false);
    inAudit = true;
    try {
      const value = await fn();
      await record(entriesOf(value));
      return value;
    } finally { inAudit = false; }
  });
  const repo = {
    findById: vi.fn(), findBySlug: vi.fn(), findBySlugScalar: vi.fn(),
    replaceCapabilities: vi.fn(), deleteBySlug: vi.fn(), create: vi.fn(),
    createCapabilities: vi.fn(), update: vi.fn(), updateApiKeyHash: vi.fn(),
  };
  const membership = {
    bindBaseline: vi.fn(), removeAllBindings: vi.fn(),
    afterCommit: vi.fn(async (fn: () => Promise<unknown>) => {
      inMembership = true;
      try { return await fn(); } finally { inMembership = false; }
    }),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    inAudit = false;
    inMembership = false;
    record.mockReset().mockResolvedValue(undefined);
    for (const mock of Object.values(repo)) mock.mockReset().mockResolvedValue(agent);
    membership.removeAllBindings.mockReset().mockResolvedValue(undefined);
    module = await Test.createTestingModule({ providers: [
      AgentsService,
      { provide: PrismaAgentRepository, useValue: repo },
      { provide: AUTH_CFG, useValue: { apiKeySecret: 'test-secret' } },
      { provide: TRANSACTION_MANAGER, useValue: { run: (fn: () => Promise<unknown>) => fn() } },
      { provide: MembershipService, useValue: membership },
      { provide: PermissionService, useValue: {} },
      { provide: AuditRecorder, useValue: { record, audited } },
    ] }).compile();
    service = module.get(AgentsService);
  });
  afterEach(async () => { await module.close(); });

  it('AC-9/10: replaces deduplicated capabilities inside exactly one audited fn', async () => {
    repo.replaceCapabilities.mockImplementation(async () => { expect(inAudit).toBe(true); });
    await service.updateCapabilities(agent.id, { capabilities: ['a', 'b', 'a', 'c'] });
    expect(audited).toHaveBeenCalledTimes(1);
    expect(repo.replaceCapabilities).toHaveBeenCalledWith(agent.id, ['a', 'b', 'c']);
    expect(record).toHaveBeenCalledWith({ key: 'agent.capabilities.update', resourceType: 'agent', resourceId: agent.id, projectId: null, summary: 'capabilities: 3' });
  });

  it('AC-15/16: deletes before cleaning bindings inside audited inside afterCommit', async () => {
    const order: string[] = [];
    repo.deleteBySlug.mockImplementation(async () => {
      expect(inAudit && inMembership).toBe(true); order.push('delete');
    });
    membership.removeAllBindings.mockImplementation(async () => {
      expect(inAudit && inMembership).toBe(true); order.push('bindings');
    });
    await service.remove(agent.slug);
    expect(membership.afterCommit).toHaveBeenCalledTimes(1);
    expect(audited).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['delete', 'bindings']);
    expect(record).toHaveBeenCalledWith({ key: 'agent.delete', resourceType: 'agent', resourceId: agent.id, projectId: null, summary: `deleted ${agent.slug}` });
  });

  it('records create without actor override or credentials', async () => {
    const result = await service.generateApiKey({ slug: agent.slug, name: agent.name });
    expect(record).toHaveBeenCalledWith({ key: 'agent.create', resourceType: 'agent', resourceId: agent.id, projectId: null, summary: `created ${agent.slug}` });
    expect(JSON.stringify(record.mock.calls)).not.toContain(result.apiKey);
  });

  it('records rotation without credentials', async () => {
    const result = await service.rotateApiKey(agent.slug);
    expect(audited).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({ key: 'agent.key.rotate', resourceType: 'agent', resourceId: agent.id, projectId: null, summary: 'key rotated' });
    expect(JSON.stringify(record.mock.calls)).not.toContain(result.apiKey);
  });

  it('summarizes only whitelisted update fields', async () => {
    await service.update(agent.slug, Object.assign({ name: 'Renamed' }, { capabilities: ['secret'], apiKeyHash: 'secret' }));
    expect(record).toHaveBeenCalledWith({ key: 'agent.update', resourceType: 'agent', resourceId: agent.id, projectId: null, summary: 'fields: name' });
    expect(repo.update).toHaveBeenCalledWith(agent.slug, { name: 'Renamed' });
  });
});
