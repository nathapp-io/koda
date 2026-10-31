export type ApprovalHttp = (
  method: string,
  path: string,
  options?: { body?: unknown; token?: string },
) => Promise<{ status: number; body: unknown }>;

type ApprovalSummary = { id: string; status: string };
type ApprovalPage = { data: { records: ApprovalSummary[] } };
type ApprovalDetail = { data: { details?: { resolvedBy?: string | null; outcome?: Record<string, unknown> | null } | null } };

export interface JobApproval {
  id: string;
  status: string;
  resolvedBy: string | null;
  outcome: Record<string, unknown> | null;
}

export async function listJobApprovals(http: ApprovalHttp, jobId: string): Promise<JobApproval[]> {
  const listResponse = await http('GET', `/approvals?jobId=${encodeURIComponent(jobId)}`);
  const rows = (listResponse.body as ApprovalPage).data.records;
  return Promise.all(rows.map(async (row) => {
    const detailResponse = await http('GET', `/approvals/${encodeURIComponent(row.id)}`);
    const details = (detailResponse.body as ApprovalDetail).data.details;
    return {
      id: row.id,
      status: row.status,
      resolvedBy: details?.resolvedBy ?? null,
      outcome: details?.outcome ?? null,
    };
  }));
}

export async function decideApproval(
  http: ApprovalHttp,
  id: string,
  choice: 'allow' | 'allow_for_job' | 'deny',
): Promise<number> {
  const body = choice === 'deny'
    ? { decision: 'reject' }
    : { decision: 'approve', params: { choice } };
  const response = await http('POST', `/approvals/${encodeURIComponent(id)}/decisions`, { body });
  return response.status;
}
