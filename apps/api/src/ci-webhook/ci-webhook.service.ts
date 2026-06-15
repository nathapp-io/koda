import { Injectable } from '@nestjs/common';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { TicketType, Priority } from '../common/enums';
import { buildGitUrl } from '../common/utils/git-url.util';
import { CiWebhookPayloadDto, CiFailureDto } from './ci-webhook.dto';
import { PrismaCiWebhookRepository } from './prisma-ci-webhook.repository';

@Injectable()
export class CiWebhookService {
  constructor(private readonly repo: PrismaCiWebhookRepository) {}

  async getWebhookSecret(projectSlug: string): Promise<string | null> {
    const project = await this.repo.findProjectBySlug(projectSlug);

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'projects');
    }

    return project.ciWebhookToken ?? null;
  }

  async processCiWebhook(projectSlug: string, payload: CiWebhookPayloadDto) {
    const project = await this.repo.findProjectBySlug(projectSlug);

    if (!project || project.deletedAt) {
      throw new NotFoundAppException({}, 'projects');
    }

    // Only process pipeline_failed events
    if (payload.event !== 'pipeline_failed') {
      return {
        success: true,
        message: `Event '${payload.event}' ignored - only 'pipeline_failed' events are processed`,
      };
    }

    if (!payload.failures || payload.failures.length === 0) {
      throw new ValidationAppException({}, 'ciWebhook');
    }

    // Use the first failure for the ticket title and git ref
    const primaryFailure = payload.failures[0];

    // Auto-create ticket with BUG type and HIGH priority
    const ticket = await this.createTicket(project, primaryFailure, payload);

    return {
      success: true,
      ticketRef: `${project.key}-${ticket.number}`,
      message: `Created ticket for CI failure: ${primaryFailure.test}`,
    };
  }

  private async createTicket(
    project: { id: string },
    failure: CiFailureDto,
    payload: CiWebhookPayloadDto,
  ) {
    // Build title: "CI failure: TestName (pipeline #id)"
    const title = `CI failure: ${failure.test} (pipeline #${payload.pipeline.id})`;

    // Build description with details
    const description = this.buildDescription(failure, payload);

    return this.repo.createTicket(project.id, {
      type: TicketType.BUG,
      title,
      description,
      status: 'CREATED',
      priority: Priority.HIGH,
      gitRefVersion: payload.commit.sha,
      gitRefFile: failure.file || null,
      gitRefLine: failure.line || null,
    });
  }

  private buildDescription(_failure: CiFailureDto, payload: CiWebhookPayloadDto): string {
    const failureLines = payload.failures.flatMap((f) => {
      const parts: string[] = [`- **${f.test}**`];
      if (f.file) parts.push(`  - File: \`${f.file}\``);
      if (f.line) parts.push(`  - Line: ${f.line}`);
      if (f.file && payload.commit.sha) {
        const project = { gitRemoteUrl: undefined } as { gitRemoteUrl?: string | null };
        const url = buildGitUrl(project.gitRemoteUrl, payload.commit.sha, f.file, f.line);
        if (url) parts.push(`  - URL: ${url}`);
      }
      return parts;
    });

    return [
      `## CI Pipeline Failure`,
      '',
      `**Pipeline ID:** ${payload.pipeline.id}`,
      ...(payload.pipeline.url ? [`**Pipeline URL:** ${payload.pipeline.url}`] : []),
      `**Commit:** \`${payload.commit.sha}\``,
      ...(payload.commit.message ? [`**Message:** ${payload.commit.message}`] : []),
      '',
      `## Failures`,
      '',
      ...failureLines,
    ].join('\n');
  }
}
