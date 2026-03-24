import { Injectable } from '@nestjs/common';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { PrismaClient } from '@prisma/client';
import { TicketType, Priority } from '../common/enums';
import { buildGitUrl } from '../common/utils/git-url.util';
import { CiWebhookPayloadDto, CiFailureDto } from './ci-webhook.dto';

@Injectable()
export class CiWebhookService {
  constructor(private prisma: PrismaService<PrismaClient>) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get db() { return this.prisma.client; }

  async processCiWebhook(projectSlug: string, payload: CiWebhookPayloadDto) {
    // Find project by slug
    const project = await this.db.project.findUnique({
      where: { slug: projectSlug },
    });

    if (!project || project.deletedAt) {
      throw new NotFoundAppException();
    }

    // Validate token if set on project
    // Note: Token validation can be added here if needed

    // Only process pipeline_failed events
    if (payload.event !== 'pipeline_failed') {
      return {
        success: true,
        message: `Event '${payload.event}' ignored - only 'pipeline_failed' events are processed`,
      };
    }

    if (!payload.failures || payload.failures.length === 0) {
      throw new ValidationAppException();
    }

    // Use the first failure for the ticket title and git ref
    const primaryFailure = payload.failures[0];

    // Auto-create ticket with BUG type and HIGH priority
    const ticket = await this.createTicket(project.id, primaryFailure, payload);

    return {
      success: true,
      ticketRef: `${project.key}-${ticket.number}`,
      message: `Created ticket for CI failure: ${primaryFailure.test}`,
    };
  }

  private async createTicket(
    projectId: string,
    failure: CiFailureDto,
    payload: CiWebhookPayloadDto,
  ) {
    // Use transaction to safely auto-increment ticket number
    return this.db.$transaction(async (tx) => {
      // Find the highest number for this project (include soft-deleted to avoid number reuse)
      const lastTicket = await tx.ticket.findFirst({
        where: { projectId },
        orderBy: { number: 'desc' },
      });

      const nextNumber = (lastTicket?.number ?? 0) + 1;

      // Build title: "CI failure: TestName (pipeline #id)"
      const title = `CI failure: ${failure.test} (pipeline #${payload.pipeline.id})`;

      // Build description with details
      const description = this.buildDescription(failure, payload);

      // Create the ticket
      return tx.ticket.create({
        data: {
          projectId,
          number: nextNumber,
          type: TicketType.BUG,
          title,
          description,
          status: 'CREATED',
          priority: Priority.HIGH,
          gitRefVersion: payload.commit.sha,
          gitRefFile: failure.file || null,
          gitRefLine: failure.line || null,
        },
      });
    });
  }

  private buildDescription(_failure: CiFailureDto, payload: CiWebhookPayloadDto): string {
    const lines: string[] = [];

    lines.push(`## CI Pipeline Failure`);
    lines.push('');
    lines.push(`**Pipeline ID:** ${payload.pipeline.id}`);
    if (payload.pipeline.url) {
      lines.push(`**Pipeline URL:** ${payload.pipeline.url}`);
    }
    lines.push(`**Commit:** \`${payload.commit.sha}\``);
    if (payload.commit.message) {
      lines.push(`**Message:** ${payload.commit.message}`);
    }
    lines.push('');
    lines.push(`## Failures`);
    lines.push('');

    for (const f of payload.failures) {
      lines.push(`- **${f.test}**`);
      if (f.file) {
        lines.push(`  - File: \`${f.file}\``);
      }
      if (f.line) {
        lines.push(`  - Line: ${f.line}`);
      }
      if (f.file && payload.commit.sha) {
        const project = { gitRemoteUrl: undefined } as { gitRemoteUrl?: string | null };
        const url = buildGitUrl(project.gitRemoteUrl, payload.commit.sha, f.file, f.line);
        if (url) {
          lines.push(`  - URL: ${url}`);
        }
      }
    }

    return lines.join('\n');
  }
}
