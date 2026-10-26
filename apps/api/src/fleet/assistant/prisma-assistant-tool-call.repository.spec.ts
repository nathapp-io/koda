import { currentBookkeepingReason } from '../../action-context/audit-coverage';
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
