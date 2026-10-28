import { PrismaService } from '@nathapp/nestjs-prisma';
import type { PrismaClient } from '../../generated/prisma/client';
import { FleetNotificationReader } from './fleet-notification.reader';

/**
 * Permissions P3 (US-011) — the fleet approval notification reads the ask's status from the approval engine
 * (`ApprovalRequest`) and its job from the `FleetApprovalAsk` link, so a budget ask opened by the evaluator is
 * delivered like a relayed bash ask.
 *
 * The DB-backed acceptance criteria (US-011 AC-12 and AC-13) are in
 * `test/integration/notifications/fleet-ask-notifications.integration.spec.ts`. This spec pins the read without a
 * database: the stub answers `approvalRequest` and `fleetJob` and has no `fleetApproval` delegate at all.
 */

interface StubRows {
  request?: { status: string; fleetAsk: { jobId: string | null } | null } | null;
  job?: { repo: { owner: string; name: string } | null } | null;
}

function readerFor(rows: StubRows) {
  const requestFindUnique = vi.fn(async (_args: Record<string, unknown>) => rows.request ?? null);
  const jobFindUnique = vi.fn(async (_args: Record<string, unknown>) => rows.job ?? null);
  const client = { approvalRequest: { findUnique: requestFindUnique }, fleetJob: { findUnique: jobFindUnique } };
  return { reader: new FleetNotificationReader({ client } as unknown as PrismaService<PrismaClient>), requestFindUnique, jobFindUnique };
}

describe('FleetNotificationReader.approvalContext — engine reads (US-011)', () => {
  it('AC-12: a pending bash ask answers its request status and the job repo as owner/name', async () => {
    const { reader, requestFindUnique, jobFindUnique } = readerFor({
      request: { status: 'pending', fleetAsk: { jobId: 'job-1' } },
      job: { repo: { owner: 'acme', name: 'app' } },
    });

    await expect(reader.approvalContext('req-1')).resolves.toEqual({ status: 'pending', repo: 'acme/app' });

    expect(requestFindUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'req-1' }, select: { status: true, fleetAsk: { select: { jobId: true } } },
    });
    expect(jobFindUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: 'job-1' }, select: { repo: { select: { owner: true, name: true } } },
    });
  });

  it('AC-13: a budget ask with no job answers its request status and a null repo', async () => {
    const { reader, jobFindUnique } = readerFor({ request: { status: 'pending', fleetAsk: { jobId: null } } });

    await expect(reader.approvalContext('req-budget')).resolves.toEqual({ status: 'pending', repo: null });
    expect(jobFindUnique).not.toHaveBeenCalled();
  });

  it('answers a settled ask with its own status and null when the request is gone', async () => {
    const answered = readerFor({ request: { status: 'executed', fleetAsk: { jobId: null } } });

    await expect(answered.reader.approvalContext('req-2')).resolves.toEqual({ status: 'executed', repo: null });
    await expect(readerFor({ request: null }).reader.approvalContext('missing')).resolves.toBeNull();
  });
});
