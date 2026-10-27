import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client';
import { PrismaService } from '@nathapp/nestjs-prisma';

/** Fleet S4a §2.4: lookups the fleet notification consumers need at delivery time. */
@Injectable()
export class FleetNotificationReader {
  constructor(private readonly prisma: PrismaService<PrismaClient>) {}

  private get db() {
    return this.prisma.client;
  }

  async projectSlug(projectId: string): Promise<string | null> {
    const p = await this.db.project.findUnique({ where: { id: projectId }, select: { slug: true, deletedAt: true } });
    return p && !p.deletedAt ? p.slug : null;
  }

  /**
   * The approval's current status and, for a job ask, the job's repo as owner/name. Null when the request is gone.
   *
   * Permissions P3 US-007 (fix round 1): the ask is an `ApprovalRequest` with a `FleetApprovalAsk` link, so a budget
   * ask opened by the evaluator is delivered like any other. `FleetApprovalAsk.jobId` has no Prisma relation
   * (schema), so the repo is a second lookup.
   */
  async approvalContext(approvalId: string): Promise<{ status: string; repo: string | null } | null> {
    const a = await this.db.approvalRequest.findUnique({
      where: { id: approvalId }, select: { status: true, fleetAsk: { select: { jobId: true } } },
    });
    if (!a) return null;
    const jobId = a.fleetAsk?.jobId ?? null;
    const job = jobId
      ? await this.db.fleetJob.findUnique({ where: { id: jobId }, select: { repo: { select: { owner: true, name: true } } } })
      : null;
    return { status: a.status, repo: job?.repo ? `${job.repo.owner}/${job.repo.name}` : null };
  }
}
