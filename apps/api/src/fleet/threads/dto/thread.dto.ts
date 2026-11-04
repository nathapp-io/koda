import { ApiProperty } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import type { ThreadSkillSource } from '../../../skills/skill-catalog.domain';
import type { ChatThreadKind, ThreadMode, ThreadBackend } from '../../common/thread-jobs';
import type { ThreadSession, ThreadWriteResult } from '../domain/chat-thread.domain';
import type { ThreadSendRefusal } from '../thread-send-rules';
import type { ChatThreadHandoff } from '../domain/chat-thread.domain';

/**
 * thread-agents-modes US-007: one answerable session approval the thread waits on. `command` and `unsandboxed` are
 * absent when the request did not carry them; `reason` is the runner's own explanation of why it asks.
 */
export class ThreadPendingApprovalDto {
  @ApiProperty({ description: 'The request id the decision route takes' }) requestId: string;
  @ApiProperty({ description: 'The tool that needs the decision' }) tool: string;
  @ApiProperty({ description: 'What the tool would do, in the runner\'s own words' }) summary: string;
  @ApiProperty({ required: false, description: 'The command the tool would run, when it runs one' }) command?: string;
  @ApiProperty({ required: false, description: 'Why the runner is asking' }) reason?: string;
  @ApiProperty({ description: 'When the runner stops waiting for the decision' }) expiresAt: string;
  @ApiProperty({ required: false, description: 'Set when the request would leave the session sandbox' }) unsandboxed?: true;
}

export class ThreadDto {
  @ApiProperty({ enum: ['read', 'ask', 'full'] }) mode: ThreadMode;
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['REPO', 'PROJECT', 'WORKSPACE'] }) kind: ChatThreadKind;
  @ApiProperty({ description: "The thread's project; for a WORKSPACE thread, its home project" }) projectId: string;
  @ApiProperty({ nullable: true }) repoId: string | null;
  @ApiProperty({ nullable: true }) baseRef: string | null;
  @ApiProperty({ nullable: true }) feature: string | null;
  @ApiProperty() title: string;
  @ApiProperty() createdById: string;
  @ApiProperty({ nullable: true }) runnerId: string | null;
  @ApiProperty() backend: ThreadBackend;
  @ApiProperty() status: string;
  @ApiProperty({ nullable: true }) archivedAt: Date | null;
  @ApiProperty({ type: 'array', items: { type: 'object' } }) skills: ThreadSkillSource[];
  @ApiProperty() maxCostUsd: string;
  @ApiProperty() costUsd: string;
  @ApiProperty({ nullable: true }) tokens: unknown;
  @ApiProperty({ nullable: true }) specPath: string | null;
  @ApiProperty({ nullable: true }) pendingQuestion: unknown;
  @ApiProperty({ type: [ThreadPendingApprovalDto], description: 'The answerable session approvals the thread waits on, oldest first (US-007)' }) pendingApprovals: ThreadPendingApprovalDto[];
  @ApiProperty({ nullable: true, type: 'object', properties: { jobId: { type: 'string' }, state: { type: 'string', enum: ['live', 'closed', 'failed'] }, resumed: { type: 'boolean' }, contextReset: { type: 'boolean' }, reason: { type: 'string', nullable: true }, at: { type: 'string' }, stale: { type: 'boolean' }, kodaToolsUnavailableOn: { type: 'string', description: 'Set when the hosting runner does not advertise kodaTools (S5b 1b-D4)' }, projectCodeUnavailableOn: { type: 'string', description: 'Set when the hosting runner does not advertise projectCode on a PROJECT thread (S5b 1c-b-D8)' } } }) session: ThreadSession | null;
  @ApiProperty() lastActivityAt: Date;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true, type: 'object', properties: { id: { type: 'string' }, state: { type: 'string' } } }) activeJob: { id: string; state: string } | null;
  @ApiProperty({ type: [String] }) writtenPaths: string[];
  @ApiProperty({ nullable: true, type: String }) publishedSha: string | null;
  @ApiProperty() specPublished: boolean;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true }) lastWrite: ThreadWriteResult | null;
}

/**
 * S5b 2a-D12: one `PENDING` action of a thread, as its detail shows it. The preview is the text the creator will
 * approve; `projectSlug` is the project the action acts in, which a WORKSPACE thread's action may differ from its home.
 */
export class PendingActionDto {
  @ApiProperty({ description: 'The action id, the value `koda_get_action` and the decide route take' }) id: string;
  @ApiProperty({ nullable: true, description: 'The summary approval the action opened; null while propose links it', type: String }) approvalId: string | null;
  @ApiProperty({ description: 'The koda tool the action would run' }) tool: string;
  @ApiProperty({ description: 'The preview the creator decides on' }) preview: string;
  @ApiProperty({ description: 'Slug of the project the action acts in' }) projectSlug: string;
  @ApiProperty({ description: 'When the action expires if it is not decided' }) expiresAt: Date;
  @ApiProperty({ description: 'When the action was proposed' }) createdAt: Date;
}

export class ThreadDetailDto extends ThreadDto {
  @ApiProperty({ enum: ['disabled', 'archived', 'costCap', 'budgetPaused', 'runnerOffline', 'runnerOutdated', 'closing', 'turnRunning'], nullable: true }) sendRefusal: ThreadSendRefusal | null;
  @ApiProperty({ type: 'object', properties: { plan: { type: 'object', nullable: true, additionalProperties: true }, run: { type: 'object', nullable: true, additionalProperties: true } } }) handoff: ChatThreadHandoff;
  @ApiProperty({ type: [PendingActionDto], description: 'The thread\'s PENDING actions, oldest first (2a-D12)' }) pendingActions: PendingActionDto[];
}

export class ThreadListDto {
  @ApiProperty({ type: [ThreadDto] }) items: ThreadDto[];
  @ApiProperty() threadsEnabled: boolean;
}

export class ChatMessageDto {
  @ApiProperty() id: string;
  @ApiProperty() seq: number;
  @ApiProperty({ nullable: true }) jobId: string | null;
  @ApiProperty({ nullable: true }) turnId: string | null;
  @ApiProperty() role: string;
  @ApiProperty({ nullable: true }) authorUserId: string | null;
  @ApiProperty({ nullable: true }) clientMessageId: string | null;
  @ApiProperty() content: string;
  @ApiProperty({ nullable: true }) toolSummary: unknown;
  @ApiProperty() status: string;
  @ApiProperty({ nullable: true }) errorReason: string | null;
  @ApiProperty({ nullable: true }) usage: unknown;
  @ApiProperty({ nullable: true }) costUsd: string | null;
  @ApiProperty({ nullable: true }) costSource: string | null;
  @ApiProperty() createdAt: Date;
}

export class ChatMessageListDto {
  @ApiProperty({ type: [ChatMessageDto] }) items: ChatMessageDto[];
}

export class SendMessageDto {
  @Allow() @ApiProperty({ minLength: 1, maxLength: 32768 }) text: string;
  @Allow() @ApiProperty({ pattern: '^[A-Za-z0-9_-]{1,64}$' }) clientMessageId: string;
}

export class SendMessageResultDto {
  @ApiProperty({ type: ChatMessageDto }) message: ChatMessageDto;
  @ApiProperty({ nullable: true }) jobId: string | null;
}

export class ChangeThreadModeDto {
  @Allow() @ApiProperty({ enum: ['read', 'ask', 'full'] }) mode: ThreadMode;
}

export class UpdateThreadDto {
  @Allow() @ApiProperty() maxCostUsd: number;
}

export class AnswerQuestionDto {
  @Allow() @ApiProperty({ minLength: 1, maxLength: 128 }) requestId: string;
  @Allow() @ApiProperty({ minLength: 1, maxLength: 32768 }) text: string;
}

/**
 * thread-agents-modes US-008: the body of an approval decision. The request id comes from the route, and the
 * decision is validated by the service so an unknown value is a 400 naming `decision` rather than a whitelist 400.
 */
export class DecideThreadApprovalDto {
  @Allow() @ApiProperty({ enum: ['allow', 'deny'], description: 'allow runs the pending tool, deny refuses it' }) decision: string;
}

export class CreateThreadDto {
  @Allow() @ApiProperty({ required: false, enum: ['read', 'ask', 'full'], default: 'read' }) mode?: ThreadMode;
  @Allow() @ApiProperty({ required: false, enum: ['REPO', 'PROJECT'] }) kind?: ChatThreadKind;
  @Allow() @ApiProperty({ required: false }) repoId?: string;
  @Allow() @ApiProperty({ required: false }) feature?: string;
  @Allow() @ApiProperty({ required: false }) baseRef?: string;
  @Allow() @ApiProperty() title: string;
  @Allow() @ApiProperty({ required: false }) maxCostUsd?: number;
  @Allow() @ApiProperty({ type: 'object', additionalProperties: true }) backend: ThreadBackend;
}
