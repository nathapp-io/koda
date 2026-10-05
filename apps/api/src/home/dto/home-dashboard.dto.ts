import { ApiExtraModels, ApiProperty } from '@nestjs/swagger';
import type { HomeApprovalView, HomeActivityView, HomeJobView, HomeProjectView, HomeTicketView, HomeView } from '../home.types';

const DATE = { format: 'date-time' } as const;
const NULLABLE_DATE = { type: String, format: 'date-time', nullable: true } as const;
const NULLABLE_STRING = { type: String, nullable: true } as const;
const USD = { example: '0.42', description: 'Decimal as string' };

export class HomeTicketDto implements HomeTicketView {
  @ApiProperty() id: string;
  @ApiProperty() projectId: string;
  @ApiProperty({ example: 'acme' }) projectSlug: string;
  @ApiProperty({ example: 'ACME-12', description: 'Project key + number' }) ref: string;
  @ApiProperty() title: string;
  @ApiProperty({ enum: ['BUG', 'ENHANCEMENT', 'TASK', 'QUESTION'] }) type: string;
  @ApiProperty({ enum: ['CREATED', 'VERIFIED', 'IN_PROGRESS', 'VERIFY_FIX', 'CLOSED', 'REJECTED'] }) status: string;
  @ApiProperty({ enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] }) priority: string;
  @ApiProperty(DATE) updatedAt: Date;
}

export class HomeApprovalDto implements HomeApprovalView {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['budget_override_required', 'nax_bash_escalate'] }) type: string;
  @ApiProperty({ ...NULLABLE_STRING, description: 'null for a no-project (requeue-candidate) approval' }) projectId: string | null;
  @ApiProperty({ ...NULLABLE_STRING, description: 'null when the project row is gone' }) projectSlug: string | null;
  @ApiProperty(NULLABLE_STRING) jobId: string | null;
  @ApiProperty(DATE) requestedAt: Date;
  @ApiProperty(NULLABLE_DATE) expiresAt: Date | null;
}

export class HomeJobDto implements HomeJobView {
  @ApiProperty() id: string;
  @ApiProperty() projectId: string;
  @ApiProperty() projectSlug: string;
  @ApiProperty() feature: string;
  @ApiProperty({ enum: ['RUN', 'PLAN'] }) command: string;
  @ApiProperty({ enum: ['QUEUED', 'ASSIGNED', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'ESCALATED', 'CRASHED', 'CANCELLED'] }) state: string;
  @ApiProperty(NULLABLE_STRING) stateReason: string | null;
  @ApiProperty({ type: Number, description: 'Pending approvals counted across the scanned pending list' }) pendingApprovals: number;
  @ApiProperty(USD) costSpentUsd: string;
  @ApiProperty(NULLABLE_STRING) resultPrUrl: string | null;
  @ApiProperty(DATE) queuedAt: Date;
  @ApiProperty(NULLABLE_DATE) finishedAt: Date | null;
  @ApiProperty({ enum: ['failed', 'blocked'], description: 'failed = finished FAILED/ESCALATED/CRASHED within the window; blocked = waiting on a pending approval' })
  reason: 'failed' | 'blocked';
}

export class HomeProjectDto implements HomeProjectView {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({ example: 'ACME' }) key: string;
  @ApiProperty() slug: string;
  @ApiProperty(NULLABLE_STRING) description: string | null;
  @ApiProperty({ description: 'Tickets in CREATED/VERIFIED/IN_PROGRESS/VERIFY_FIX' }) openTickets: number;
  @ApiProperty({ description: 'Recent failed jobs plus jobs waiting on a pending approval (7-day window)' }) attentionJobs: number;
}

export class HomeActivityDto implements HomeActivityView {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['ticket_event', 'agent_event', 'decision_event'] }) eventType: HomeActivityView['eventType'];
  @ApiProperty() projectSlug: string;
  @ApiProperty({ description: 'Raw action code (e.g. CREATED, STATUS_CHANGE); the client words it' }) action: string;
  @ApiProperty({ description: 'User or agent id of the actor' }) actorId: string;
  @ApiProperty(NULLABLE_STRING) ticketId: string | null;
  @ApiProperty(DATE) createdAt: Date;
}

export class HomeNeedsYouDto {
  @ApiProperty({ type: [HomeTicketDto], description: 'Assigned to the caller, open, newest update first, capped' }) tickets: HomeTicketDto[];
  @ApiProperty({ description: 'Exact count behind the cap' }) ticketsTotal: number;
  @ApiProperty({ type: [HomeApprovalDto], description: 'Pending in the caller\'s projects (plus no-project ones for a global admin), newest first, capped' })
  approvals: HomeApprovalDto[];
  @ApiProperty() approvalsTotal: number;
  @ApiProperty({ type: [HomeJobDto], description: 'Blocked first, then failed, both newest first, capped' }) jobs: HomeJobDto[];
  @ApiProperty() jobsTotal: number;
}

/** GET /home — the signed-in user's cross-project dashboard snapshot. */
export class HomeDashboardDto implements HomeView {
  @ApiProperty({ ...DATE, description: 'Server time every age is measured against' }) generatedAt: Date;
  @ApiProperty({ type: HomeNeedsYouDto }) needsYou: HomeNeedsYouDto;
  @ApiProperty({ type: [HomeProjectDto], description: 'Attention first, then open tickets, then name' }) projects: HomeProjectDto[];
  @ApiProperty({ type: [HomeActivityDto], description: 'Merged ticket/agent/decision events, newest first, capped' }) activity: HomeActivityDto[];
}
