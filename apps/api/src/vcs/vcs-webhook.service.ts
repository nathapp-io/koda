import { Injectable } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { VcsConnection, Project } from '@prisma/client';
import { VcsSyncService } from './vcs-sync.service';
import { VcsIssue } from './types';

/**
 * GitHub webhook event payload (issues)
 */
export interface GitHubWebhookPayload {
  action: string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    html_url: string;
    labels: Array<{ name: string }>;
    created_at: string;
  };
}

export interface WebhookHandleResult {
  success: boolean;
  ignored?: boolean;
  reason?: string;
}

@Injectable()
export class VcsWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly syncService: VcsSyncService,
  ) {}

  // PrismaClientLike from @nathapp/nestjs-prisma doesn't expose VCS models,
  // but they exist at runtime. Using double cast to allow property access.
  private get db() {
    return this.prisma.client as unknown as Record<string, unknown>;
  }

  /**
   * Verify GitHub webhook signature using timing-safe comparison
   */
  verifySignature(payload: string, signature: string, secret: string): boolean {
    try {
      const hash = createHmac('sha256', secret).update(payload).digest('hex');
      const expectedSignature = `sha256=${hash}`;

      // Use timing-safe comparison to prevent timing attacks
      const expected = Buffer.from(expectedSignature);
      const received = Buffer.from(signature);

      // Signatures must be same length for comparison
      if (expected.length !== received.length) {
        return false;
      }

      return timingSafeEqual(expected, received);
    } catch {
      return false;
    }
  }

  /**
   * Handle GitHub webhook event
   */
  async handleWebhook(
    connection: VcsConnection & { project: Project },
    event: string,
    payload: GitHubWebhookPayload,
  ): Promise<WebhookHandleResult> {
    // Only handle issues.opened events
    if (event !== 'issues.opened') {
      return {
        success: true,
        ignored: true,
        reason: `Event type '${event}' is not processed`,
      };
    }

    // Convert GitHub payload to VcsIssue
    const issue: VcsIssue = {
      number: payload.issue.number,
      title: payload.issue.title,
      body: payload.issue.body,
      authorLogin: payload.issue.user.login,
      url: payload.issue.html_url,
      labels: payload.issue.labels.map((label) => label.name),
      createdAt: new Date(payload.issue.created_at),
    };

    // Check if author is allowed
    const allowedIssues = this.syncService.filterByAllowedAuthors([issue], connection.allowedAuthors);
    if (allowedIssues.length === 0) {
      return {
        success: true,
        ignored: true,
        reason: 'Author not in allowed list',
      };
    }

    // Sync the issue
    try {
      const result = await this.syncService.syncIssue(connection.project, issue, 'webhook');

      return {
        success: true,
        ignored: result.action === 'skipped',
        reason: result.action === 'skipped' ? result.reason : undefined,
      };
    } catch (error) {
      return {
        success: false,
        reason: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
