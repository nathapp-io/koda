import type { AgentPrincipal, UserPrincipal } from '../../../auth/principal/koda-principal.types';
import type { AuditRecorder } from '../../../audit/audit-recorder.service';
import type { PrismaMemoryItemRepository } from '../../../memory/prisma-memory-item.repository';
import type { ExtractionService } from '../../../memory/extraction.service';
import type { MemoryWriteGuard } from '../../../memory/memory-write.guard';
import type { ApprovalRequestQueries } from '../../../approvals/approval-request.queries';
import type { ToolContext } from '../assistant-tool.types';
import { getActionTool } from './action-tools';
import { addMemoryTool } from './add-memory-tool';
import { recordDecisionTool } from './record-decision-tool';
import { listApprovalsTool } from './fleet-tools';

const agent: AgentPrincipal = { actorType: 'agent', id: 'claude', slug: 'claude', name: 'Claude', status: 'ACTIVE', agentRoles: [], capabilities: [], authorities: [], blacklisted: false, revoked: false };
const context = (over: Partial<ToolContext> = {}): ToolContext => ({ actor: agent, projectId: 'p1', projectSlug: 'web', threadId: null, jobId: null, now: new Date(), data: text => text, ...over });
/** US-008: the tools take the replace guard; these cases are about provenance, so it always allows. */
const guard = {
  assertMayReplace: vi.fn(async () => undefined),
  replaceCheck: vi.fn(() => vi.fn(async () => undefined)),
} as unknown as MemoryWriteGuard;
/** US-003: both memory tools also record the write; these cases are about provenance, so nothing is recorded. */
const audit = { record: vi.fn(async (): Promise<void> => undefined) } as unknown as AuditRecorder;
describe('origin-aware tools', () => {
  it('AC-9: MCP action lookup is actor-scoped, never thread-scoped', async () => {
    const actions = { findScopedInThread: vi.fn(), findOwnRequest: vi.fn(async () => ({ id: 'a1', projectId: 'p1', actorType: 'AGENT', actorId: 'claude', permissionKey: 'comment.create', assistantAction: null, status: 'executed' as const, createdAt: new Date(), decidedAt: null, settledAt: null, result: null })) };
    await getActionTool(actions).execute(context(), { id: 'a1' });
    expect(actions.findOwnRequest).toHaveBeenCalledWith('a1', 'p1', { type: 'AGENT', id: 'claude' });
    expect(actions.findScopedInThread).not.toHaveBeenCalled();
  });
  it('AC-10: MCP memory records actor provenance', async () => {
    const upsert = vi.fn(async () => ({ id: 'm1' }));
    const tool = addMemoryTool({ memory: { upsert } as unknown as PrismaMemoryItemRepository, guard, audit });
    await tool.execute(context(), tool.parse({ kind: 'FACT', subject: 's', predicate: 'p' }));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ sourceType: 'mcp', sourceId: 'claude', ownerId: 'claude', ownerType: 'AGENT' }),
      expect.objectContaining({ beforeSupersede: expect.any(Function) }),
    );
  });
  it('AC-11: MCP decision records actor provenance', async () => {
    const recordDecision = vi.fn(async () => ({ memoryId: 'm1' }));
    const memory = {} as PrismaMemoryItemRepository;
    const tool = recordDecisionTool({ memory, extraction: { recordDecision } as unknown as ExtractionService, guard, audit });
    await tool.execute(context(), tool.parse({ topic: 't', decision: 'd' }));
    expect(recordDecision).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'mcp:claude', ownerType: 'AGENT' }),
      memory,
      expect.objectContaining({ beforeSupersede: expect.any(Function) }),
    );
  });
  it('AC-12: approvals read the engine as the actor principal, filtered to the thread project', async () => {
    const list = vi.fn(async () => ({ records: [], hasNext: false }));
    const tool = listApprovalsTool({ list } as unknown as ApprovalRequestQueries);
    await tool.execute(context(), tool.parse({}));
    expect(list).toHaveBeenLastCalledWith(
      { type: 'AGENT', id: 'claude' },
      { status: 'pending', projectId: 'p1' },
      { current: 1, size: 20 },
    );
    const user = { actorType: 'user', id: 'u1' } as UserPrincipal;
    await tool.execute(context({ actor: user }), tool.parse({}));
    expect(list).toHaveBeenLastCalledWith(
      { type: 'USER', id: 'u1' },
      { status: 'pending', projectId: 'p1' },
      { current: 1, size: 20 },
    );
  });
});
