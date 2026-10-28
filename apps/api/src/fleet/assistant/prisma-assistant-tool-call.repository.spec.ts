import { currentBookkeepingReason } from '../../action-context/audit-coverage';
import { FLEET_ASK_KEYS } from '../approvals/domain/approval.domain';
import type { AssistantToolCallRecord } from './assistant-tool-call.domain';
import { PrismaAssistantToolCallRepository } from './prisma-assistant-tool-call.repository';

/**
 * Permissions P2 US-007: the tool-call ledger row is the audit trail of a tool call, not a domain change, so
 * `record` writes it uncounted under `assistant.tool-call-ledger`. The PG side of the same insert is covered by
 * test/integration; this spec pins the marker where it runs, which needs no database.
 */
const ROW: AssistantToolCallRecord = {
  jobId: 'j1', threadId: 't1', projectId: 'p1', toolCallId: 'tc1', actorType: 'user', actorId: 'u1',
  tool: 'koda_add_comment', inputHash: 'h1', outcome: 'ok', content: 'comment c1 added', isError: false,
  resultBytes: 15, durationMs: 7,
};

function stub() {
  const seen: Array<ReturnType<typeof currentBookkeepingReason>> = [];
  const client = {
    assistantToolCall: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        seen.push(currentBookkeepingReason());
        return { id: 'c1', createdAt: new Date(0), ...args.data };
      }),
    },
  };
  const tx = { getClient: () => client, run: (fn: () => Promise<unknown>) => fn(), isInTransaction: () => false };
  return { repo: new PrismaAssistantToolCallRepository(tx as never, { client } as never), client, seen };
}

describe('PrismaAssistantToolCallRepository audit coverage (permissions P2 US-007)', () => {
  it('AC-11: record(row) calls assistantToolCall.create while currentBookkeepingReason() answers assistant.tool-call-ledger', async () => {
    const { repo, client, seen } = stub();

    await repo.record(ROW);

    expect(client.assistantToolCall.create).toHaveBeenCalledExactlyOnceWith({ data: ROW });
    expect(seen).toEqual(['assistant.tool-call-ledger']);
  });

  it('leaves no reason current once the row is stored, and returns nothing', async () => {
    const { repo } = stub();

    await expect(repo.record(ROW)).resolves.toBeUndefined();

    expect(currentBookkeepingReason()).toBeUndefined();
  });

  it('a failed insert rejects with its own error and still clears the reason', async () => {
    const { repo, client } = stub();
    client.assistantToolCall.create.mockRejectedValueOnce(new Error('unique violation on toolCallId'));

    await expect(repo.record(ROW)).rejects.toThrow('unique violation on toolCallId');

    expect(currentBookkeepingReason()).toBeUndefined();
  });
});

/**
 * Permissions P3 (US-011): `koda_my_projects`' pending-approval count reads the engine's `ApprovalRequest`
 * rows carrying a fleet key *and a `FleetApprovalAsk` link*, so neither a pending request of another
 * permission key nor a fleet-key request without a link counts. The DB-backed criterion (US-011 AC-11) is
 * in `test/integration/fleet/assistant-workspace-tools.integration.spec.ts`; this spec pins the read
 * without a database, and its stub has no `fleetApproval` delegate, so a read of the legacy row cannot pass.
 */
describe('PrismaAssistantToolCallRepository.findProjectCounts — engine ask counts (US-011)', () => {
  /** One pending request of the stub's table: `linked` is whether a `FleetApprovalAsk` row points at it. */
  interface PendingRequest {
    projectId: string | null;
    linked: boolean;
  }

  /**
   * The stub counts the requests its `where` keeps — the project set and, when asked for, the link condition —
   * so a read that drops either filter answers a count of rows that are not fleet asks.
   */
  function countsStub(pending: PendingRequest[]) {
    const ticketGroupBy = vi.fn(async (_args: Record<string, unknown>) => []);
    const jobGroupBy = vi.fn(async (_args: Record<string, unknown>) => []);
    const requestGroupBy = vi.fn(async (args: Record<string, unknown>) => {
      const where = args['where'] as { projectId?: { in?: readonly string[] }; fleetAsk?: unknown } | undefined;
      const kept = pending
        .filter((row) => where?.fleetAsk === undefined || row.linked)
        .filter((row) => row.projectId === null || (where?.projectId?.in ?? []).includes(row.projectId));
      const counted = new Map<string | null, number>();
      for (const row of kept) counted.set(row.projectId, (counted.get(row.projectId) ?? 0) + 1);
      return [...counted].map(([projectId, count]) => ({ projectId, _count: { _all: count } }));
    });
    const client = {
      ticket: { groupBy: ticketGroupBy },
      fleetJob: { groupBy: jobGroupBy },
      approvalRequest: { groupBy: requestGroupBy },
    };
    const tx = { getClient: () => client, run: (fn: () => Promise<unknown>) => fn(), isInTransaction: () => false };
    return { repo: new PrismaAssistantToolCallRepository(tx as never, { client } as never), requestGroupBy };
  }

  const FAILED_SINCE = new Date('2026-10-01T00:00:00.000Z');

  it('AC-11: counts the linked pending fleet-key requests per project and ignores every other pending request', async () => {
    const { repo, requestGroupBy } = countsStub([{ projectId: 'p1', linked: true }]);

    const counts = await repo.findProjectCounts(['p1', 'p2'], FAILED_SINCE);

    expect(counts.get('p1')).toEqual({ openTickets: 0, failedJobs7d: 0, pendingApprovals: 1 });
    expect(counts.get('p2')).toEqual({ openTickets: 0, failedJobs7d: 0, pendingApprovals: 0 });
    expect(requestGroupBy).toHaveBeenCalledExactlyOnceWith({
      by: ['projectId'],
      where: { projectId: { in: ['p1', 'p2'] }, status: 'pending', permissionKey: { in: [...FLEET_ASK_KEYS] }, fleetAsk: { isNot: null } },
      _count: { _all: true },
    });
  });

  it('does not count a pending fleet-key request whose ask has no link', async () => {
    const { repo } = countsStub([
      { projectId: 'p1', linked: true },
      { projectId: 'p1', linked: false },
    ]);

    const counts = await repo.findProjectCounts(['p1'], FAILED_SINCE);

    expect(counts.get('p1')).toEqual({ openTickets: 0, failedJobs7d: 0, pendingApprovals: 1 });
  });

  it('ignores a group with no project and a project outside the asked list', async () => {
    const { repo } = countsStub([
      { projectId: null, linked: true },
      { projectId: null, linked: true },
      { projectId: 'other', linked: true },
    ]);

    const counts = await repo.findProjectCounts(['p1'], FAILED_SINCE);

    expect(counts.get('p1')).toEqual({ openTickets: 0, failedJobs7d: 0, pendingApprovals: 0 });
    expect([...counts.keys()]).toEqual(['p1']);
  });

  it('answers the zero-filled entries without reading any table when no project is asked for', async () => {
    const { repo, requestGroupBy } = countsStub([]);

    const counts = await repo.findProjectCounts([], FAILED_SINCE);

    expect([...counts.keys()]).toEqual([]);
    expect(requestGroupBy).not.toHaveBeenCalled();
  });
});
