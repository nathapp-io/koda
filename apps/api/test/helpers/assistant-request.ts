import type { PrismaClient } from '../../src/generated/prisma/client';

/** Read the request and its thread link together for tool integration assertions. */
export async function findThreadAction(db: PrismaClient, where: { requestId?: string; jobId?: string; toolCallId?: string }) {
  if (where.jobId && where.toolCallId) {
    // A duplicate call has no link of its own: its ledger answer names the original request.
    const call = await db.assistantToolCall.findUniqueOrThrow({ where: { jobId_toolCallId: { jobId: where.jobId, toolCallId: where.toolCallId } } });
    where = { requestId: pendingRequestId(call.content) };
  }
  const link = await db.assistantActionRequest.findFirstOrThrow({ where, include: { request: true } });
  return { ...link, ...link.request };
}

export function pendingRequestId(content: string): string {
  const id = /^pending ([^: ]+): awaiting approval; do not retry$/.exec(content)?.[1];
  if (!id) throw new Error(`expected a pending approval answer, got: ${content}`);
  return id;
}
