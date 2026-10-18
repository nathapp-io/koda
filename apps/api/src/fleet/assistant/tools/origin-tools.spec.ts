import type { AgentPrincipal, UserPrincipal } from '../../../auth/principal/koda-principal.types';
import type { PrismaMemoryItemRepository } from '../../../memory/prisma-memory-item.repository';
import type { ExtractionService } from '../../../memory/extraction.service';
import type { ApprovalsService } from '../../approvals/approvals.service';
import type { ToolContext } from '../assistant-tool.types';
import { getActionTool } from './action-tools';
import { addMemoryTool } from './add-memory-tool';
import { recordDecisionTool } from './record-decision-tool';
import { listApprovalsTool } from './fleet-tools';

const agent: AgentPrincipal = { actorType: 'agent', id: 'claude', slug: 'claude', name: 'Claude', status: 'ACTIVE', agentRoles: [], capabilities: [], authorities: [], blacklisted: false, revoked: false };
const context = (over: Partial<ToolContext> = {}): ToolContext => ({ actor: agent, projectId: 'p1', projectSlug: 'web', threadId: null, jobId: null, now: new Date(), data: text => text, ...over });
describe('origin-aware tools', () => {
  it('AC-9: MCP action lookup is actor-scoped, never thread-scoped', async () => {
    const actions = { findScopedById: vi.fn(), findScopedByActor: vi.fn(async () => ({ id: 'a1', tool: 'koda_add_comment', status: 'EXECUTED', createdAt: new Date(), decidedAt: null, result: null })) };
    await getActionTool(actions).execute(context(), { id: 'a1' });
    expect(actions.findScopedByActor).toHaveBeenCalledWith('a1', 'p1', { type: 'agent', id: 'claude' });
    expect(actions.findScopedById).not.toHaveBeenCalled();
  });
  it('AC-10: MCP memory records actor provenance', async () => {
    const upsert = vi.fn(async () => ({ id: 'm1' }));
    const tool = addMemoryTool({ memory: { upsert } as unknown as PrismaMemoryItemRepository });
    await tool.execute(context(), tool.parse({ kind: 'FACT', subject: 's', predicate: 'p' }));
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ sourceType: 'mcp', sourceId: 'claude', ownerId: 'claude' }));
  });
  it('AC-11: MCP decision records actor provenance', async () => {
    const recordDecision = vi.fn(async () => ({ memoryId: 'm1' }));
    const memory = {} as PrismaMemoryItemRepository;
    const tool = recordDecisionTool({ memory, extraction: { recordDecision } as unknown as ExtractionService });
    await tool.execute(context(), tool.parse({ topic: 't', decision: 'd' }));
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({ sourceId: 'mcp:claude' }), memory);
  });
  it('AC-12: approvals use null for agents and preserve legacy user fixture roles', async () => {
    const list = vi.fn(async () => ({ records: [], hasNext: false }));
    const tool = listApprovalsTool({ list } as unknown as ApprovalsService);
    await tool.execute(context({ actor: { ...agent, ...{ projectRole: 'ADMIN' } } }), tool.parse({}));
    expect(list).toHaveBeenLastCalledWith({ kind: 'project', projectId: 'p1', role: null }, { status: 'pending' }, { current: 1, size: 20 });
    const user = { id: 'u1', projectRole: 'DEVELOPER' } as UserPrincipal;
    await tool.execute(context({ actor: user }), tool.parse({}));
    expect(list).toHaveBeenLastCalledWith({ kind: 'project', projectId: 'p1', role: 'DEVELOPER' }, { status: 'pending' }, { current: 1, size: 20 });
  });
});
