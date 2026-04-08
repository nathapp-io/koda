import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '@nathapp/nestjs-prisma';
import { VcsConnection, Project } from '@prisma/client';
import { VcsSyncService } from './vcs-sync.service';
import { VcsPrSyncService } from './vcs-pr-sync.service';
import { VcsLinkExtractorService } from './vcs-link-extractor.service';
import { VcsIssue } from './types';

/**
 * GitHub webhook event payload (issues)
 */
export interface GitHubWebhookPayload {
  action: string;
  issue?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    html_url: string;
    labels: Array<{ name: string }>;
    created_at: string;
  };
  pull_request?: {
    number: number;
    title: string;
    body: string | null;
    user: { login: string };
    html_url: string;
    state: string;
    draft: boolean;
    merged: boolean;
    merged_at: string | null;
    merged_by: { login: string } | null;
    merge_commit_sha?: string | null;
    base: { ref: string; repo: { full_name: string } };
    head: { ref: string; repo: { full_name: string } };
  };
}

export interface WebhookHandleResult {
  success: boolean;
  ignored?: boolean;
  reason?: string;
}

interface TicketLinkDelegate {
  findFirst(options: { where: Record<string, unknown>; select?: unknown; include?: unknown }): Promise<unknown>
  findUnique(options: { where: Record<string, unknown>; select?: unknown; include?: unknown }): Promise<unknown>
  update(options: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<unknown>
}

interface TicketDelegate {
  findUnique(options: { where: Record<string, unknown>; include?: unknown }): Promise<unknown>
}

interface ExtendedPrismaClient {
  ticketLink: TicketLinkDelegate
  ticket: TicketDelegate
  [key: string]: unknown
}

interface TicketLinkData {
  id: string
  ticketId: string
  prNumber: number | null
  prState: string | null
  url: string
  externalRef: string | null
  ticket?: {
    id: string
    status: string
    projectId: string
    number: number
    externalVcsId: string | null
  }
}

@Injectable()
export class VcsWebhookService {
  private readonly logger = new Logger(VcsWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncService: VcsSyncService,
    private readonly prSyncService: VcsPrSyncService,
    @Optional() private readonly vcsLinkExtractorService?: VcsLinkExtractorService,
    @Optional() private readonly configService?: ConfigService,
  ) {}

  // PrismaClientLike from @nathapp/nestjs-prisma doesn't expose VCS models,
  // but they exist at runtime. Using double cast to allow property access.
  private get db() {
    return this.prisma.client as unknown as ExtendedPrismaClient;
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
    // Route to appropriate handler based on event type
    if (event === 'issues.opened') {
      return this.handleIssueOpened(connection, payload);
    }

    if (event === 'pull_request') {
      return this.handlePullRequest(connection, payload);
    }

    // Unhandled event types are silently ignored
    return {
      success: true,
      ignored: true,
      reason: `Event type '${event}' is not processed`,
    };
  }

  /**
   * Handle issues.opened event
   */
  private async handleIssueOpened(
    connection: VcsConnection & { project: Project },
    payload: GitHubWebhookPayload,
  ): Promise<WebhookHandleResult> {
    if (!payload.issue) {
      return {
        success: false,
        reason: 'Missing issue data in payload',
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

  /**
   * Handle pull_request event
   */
  private async handlePullRequest(
    connection: VcsConnection & { project: Project },
    payload: GitHubWebhookPayload,
  ): Promise<WebhookHandleResult> {
    if (!payload.pull_request) {
      return {
        success: false,
        reason: 'Missing pull_request data in payload',
      };
    }

    const pr = payload.pull_request;
    const action = payload.action;

    // Handle specific pull_request actions
    switch (action) {
      case 'opened':
        return this.handlePullRequestOpened(connection, pr);

      case 'closed':
        if (pr.merged) {
          return this.handlePullRequestMerged(connection, pr);
        } else {
          return this.handlePullRequestClosed(connection, pr);
        }

      case 'ready_for_review':
        return this.handlePullRequestReadyForReview(connection, pr);

      case 'reopened':
        return this.handlePullRequestReopened(connection, pr);

      case 'converted_to_draft':
        return this.handlePullRequestConvertedToDraft(connection, pr);

      case 'synchronize':
        return this.handlePullRequestSynchronize(connection, pr);

      default:
        // AC8: Unhandled pull_request actions are ignored without error
        return {
          success: true,
          ignored: true,
          reason: `Action '${action}' is not processed`,
        };
    }
  }

  /**
   * Handle pull_request opened action
   * AC2: sets prState to 'draft' if draft=true, otherwise 'open'
   */
  private async handlePullRequestOpened(
    connection: VcsConnection & { project: Project },
    pr: NonNullable<GitHubWebhookPayload['pull_request']>,
  ): Promise<WebhookHandleResult> {
    const prNumber = pr.number;

    // Find TicketLink by prNumber
    const ticketLink = await this.findTicketLinkByPrNumber(connection.project.id, prNumber);

    if (!ticketLink) {
      // AC7: If no TicketLink matches prNumber, silently ignore
      return {
        success: true,
        ignored: true,
        reason: 'No TicketLink found for PR number',
      };
    }

    const newPrState = pr.draft ? 'draft' : 'open';

    await this.db.ticketLink.update({
      where: { id: ticketLink.id },
      data: {
        prState: newPrState,
        prUpdatedAt: new Date(),
      },
    });

    this.logger.debug(`Updated TicketLink ${ticketLink.id} prState to '${newPrState}' for PR #${prNumber}`);

    return {
      success: true,
      ignored: false,
    };
  }

  /**
   * Handle pull_request merged action
   * AC3: updates prState to 'merged' and triggers auto-transition
   */
  private async handlePullRequestMerged(
    connection: VcsConnection & { project: Project },
    pr: NonNullable<GitHubWebhookPayload['pull_request']>,
  ): Promise<WebhookHandleResult> {
    const prNumber = pr.number;

    // Find TicketLink by prNumber
    const ticketLink = await this.findTicketLinkByPrNumber(connection.project.id, prNumber);

    if (!ticketLink) {
      // AC7: If no TicketLink matches prNumber, silently ignore
      return {
        success: true,
        ignored: true,
        reason: 'No TicketLink found for PR number',
      };
    }

    // Trigger auto-transition logic (same as VcsPrSyncService.handleMergedPrAutoTransition)
    await this.prSyncService.handleMergedPrAutoTransition(
      ticketLink as TicketLinkData,
      {
        number: pr.number,
        state: pr.state,
        draft: pr.draft,
        merged: pr.merged,
        mergedAt: pr.merged_at ? new Date(pr.merged_at) : null,
        mergedBy: pr.merged_by?.login ?? null,
        mergeSha: pr.merge_commit_sha ?? null,
        url: pr.html_url,
        title: pr.title,
      },
    );

    // Update prState to merged
    await this.db.ticketLink.update({
      where: { id: ticketLink.id },
      data: {
        prState: 'merged',
        prUpdatedAt: new Date(),
      },
    });

    this.logger.debug(`Updated TicketLink ${ticketLink.id} prState to 'merged' for merged PR #${prNumber}`);

    return {
      success: true,
      ignored: false,
    };
  }

  /**
   * Handle pull_request closed (not merged) action
   * AC4: sets prState to 'closed'
   */
  private async handlePullRequestClosed(
    connection: VcsConnection & { project: Project },
    pr: NonNullable<GitHubWebhookPayload['pull_request']>,
  ): Promise<WebhookHandleResult> {
    const prNumber = pr.number;

    // Find TicketLink by prNumber
    const ticketLink = await this.findTicketLinkByPrNumber(connection.project.id, prNumber);

    if (!ticketLink) {
      // AC7: If no TicketLink matches prNumber, silently ignore
      return {
        success: true,
        ignored: true,
        reason: 'No TicketLink found for PR number',
      };
    }

    await this.db.ticketLink.update({
      where: { id: ticketLink.id },
      data: {
        prState: 'closed',
        prUpdatedAt: new Date(),
      },
    });

    this.logger.debug(`Updated TicketLink ${ticketLink.id} prState to 'closed' for PR #${prNumber}`);

    return {
      success: true,
      ignored: false,
    };
  }

  /**
   * Handle pull_request ready_for_review action
   * AC5: transitions prState from 'draft' to 'open'
   */
  private async handlePullRequestReadyForReview(
    connection: VcsConnection & { project: Project },
    pr: NonNullable<GitHubWebhookPayload['pull_request']>,
  ): Promise<WebhookHandleResult> {
    const prNumber = pr.number;

    // Find TicketLink by prNumber
    const ticketLink = await this.findTicketLinkByPrNumber(connection.project.id, prNumber);

    if (!ticketLink) {
      // AC7: If no TicketLink matches prNumber, silently ignore
      return {
        success: true,
        ignored: true,
        reason: 'No TicketLink found for PR number',
      };
    }

    await this.db.ticketLink.update({
      where: { id: ticketLink.id },
      data: {
        prState: 'open',
        prUpdatedAt: new Date(),
      },
    });

    this.logger.debug(`Updated TicketLink ${ticketLink.id} prState to 'open' for PR #${prNumber}`);

    return {
      success: true,
      ignored: false,
    };
  }

  /**
   * Handle pull_request reopened action
   * Reopened PRs should return to open state.
   */
  private async handlePullRequestReopened(
    connection: VcsConnection & { project: Project },
    pr: NonNullable<GitHubWebhookPayload['pull_request']>,
  ): Promise<WebhookHandleResult> {
    const prNumber = pr.number;
    const ticketLink = await this.findTicketLinkByPrNumber(connection.project.id, prNumber);

    if (!ticketLink) {
      return {
        success: true,
        ignored: true,
        reason: 'No TicketLink found for PR number',
      };
    }

    await this.db.ticketLink.update({
      where: { id: ticketLink.id },
      data: {
        prState: 'open',
        prUpdatedAt: new Date(),
      },
    });

    return {
      success: true,
      ignored: false,
    };
  }

  /**
   * Handle pull_request converted_to_draft action
   */
  private async handlePullRequestConvertedToDraft(
    connection: VcsConnection & { project: Project },
    pr: NonNullable<GitHubWebhookPayload['pull_request']>,
  ): Promise<WebhookHandleResult> {
    const prNumber = pr.number;
    const ticketLink = await this.findTicketLinkByPrNumber(connection.project.id, prNumber);

    if (!ticketLink) {
      return {
        success: true,
        ignored: true,
        reason: 'No TicketLink found for PR number',
      };
    }

    await this.db.ticketLink.update({
      where: { id: ticketLink.id },
      data: {
        prState: 'draft',
        prUpdatedAt: new Date(),
      },
    });

    return {
      success: true,
      ignored: false,
    };
  }

  /**
   * Handle pull_request synchronize action
   * AC-24: Calls extractLinksFromPr to capture new commits
   */
  private async handlePullRequestSynchronize(
    connection: VcsConnection & { project: Project },
    pr: NonNullable<GitHubWebhookPayload['pull_request']>,
  ): Promise<WebhookHandleResult> {
    const prNumber = pr.number;

    // Find TicketLink by prNumber to get the associated ticket
    const ticketLink = await this.findTicketLinkByPrNumber(connection.project.id, prNumber);

    if (!ticketLink) {
      return {
        success: true,
        ignored: true,
        reason: 'No TicketLink found for PR number',
      };
    }

    // Get the full ticket data including project
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fullTicket = (await this.db.ticket.findUnique({
      where: { id: ticketLink.ticketId },
      include: { project: true },
    })) as { id: string; externalVcsId: string | null; project: { id: string; key: string } } | null;

    if (!fullTicket) {
      return {
        success: true,
        ignored: true,
        reason: 'Ticket not found',
      };
    }

    // Call extractLinksFromPr to capture new commits
    // The head.ref contains the branch name that was pushed
    if (this.vcsLinkExtractorService && this.configService) {
      const encryptionKey = this.configService.get<string>('vcs.encryptionKey');
      if (encryptionKey) {
        try {
          await this.vcsLinkExtractorService.extractLinksFromPr(
            { id: fullTicket.project.id, key: fullTicket.project.key },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            fullTicket as any,
            connection,
            encryptionKey,
            pr.head.ref,
            pr.number,
          );
          this.logger.debug(`extractLinksFromPr called for PR #${prNumber} with branch ${pr.head.ref}`);
        } catch (err) {
          this.logger.warn(
            `[webhook] Failed to extract links from PR #${prNumber}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Don't fail the webhook - just log the error
        }
      }
    }

    return {
      success: true,
      ignored: false,
    };
  }

  /**
   * Find TicketLink by project ID and PR number
   * AC6: Webhook handlers look up TicketLink using prNumber field from webhook payload
   */
  private async findTicketLinkByPrNumber(
    projectId: string,
    prNumber: number,
  ): Promise<TicketLinkData | null> {
    const ticketLink = (await this.db.ticketLink.findFirst({
      where: {
        prNumber: prNumber,
        ticket: {
          projectId: projectId,
        },
      },
      include: {
        ticket: {
          select: {
            id: true,
            status: true,
            projectId: true,
            number: true,
            externalVcsId: true,
          },
        },
      },
    })) as TicketLinkData | null;

    return ticketLink;
  }
}
