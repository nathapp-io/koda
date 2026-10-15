import { ApiProperty } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import type { ThreadSkillSource } from '../../../skills/skill-catalog.domain';
import type { ChatThreadKind, ThreadBackend } from '../../common/thread-jobs';
import type { ThreadSession, ThreadWriteResult } from '../domain/chat-thread.domain';
import type { ThreadSendRefusal } from '../thread-send-rules';
import type { ChatThreadHandoff } from '../domain/chat-thread.domain';

export class ThreadDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['REPO', 'PROJECT'] }) kind: ChatThreadKind;
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
  @ApiProperty({ nullable: true, type: 'object', properties: { jobId: { type: 'string' }, state: { type: 'string', enum: ['live', 'closed', 'failed'] }, resumed: { type: 'boolean' }, contextReset: { type: 'boolean' }, reason: { type: 'string', nullable: true }, at: { type: 'string' }, stale: { type: 'boolean' } } }) session: ThreadSession | null;
  @ApiProperty() lastActivityAt: Date;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true, type: 'object', properties: { id: { type: 'string' }, state: { type: 'string' } } }) activeJob: { id: string; state: string } | null;
  @ApiProperty({ type: [String] }) writtenPaths: string[];
  @ApiProperty({ nullable: true, type: String }) publishedSha: string | null;
  @ApiProperty() specPublished: boolean;
  @ApiProperty({ nullable: true, type: 'object', additionalProperties: true }) lastWrite: ThreadWriteResult | null;
}

export class ThreadDetailDto extends ThreadDto {
  @ApiProperty({ enum: ['disabled', 'archived', 'costCap', 'budgetPaused', 'runnerOffline', 'runnerOutdated', 'closing', 'turnRunning'], nullable: true }) sendRefusal: ThreadSendRefusal | null;
  @ApiProperty({ type: 'object', properties: { plan: { type: 'object', nullable: true, additionalProperties: true }, run: { type: 'object', nullable: true, additionalProperties: true } } }) handoff: ChatThreadHandoff;
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

export class UpdateThreadDto {
  @Allow() @ApiProperty() maxCostUsd: number;
}

export class AnswerQuestionDto {
  @Allow() @ApiProperty({ minLength: 1, maxLength: 128 }) requestId: string;
  @Allow() @ApiProperty({ minLength: 1, maxLength: 32768 }) text: string;
}

export class CreateThreadDto {
  @Allow() @ApiProperty({ required: false, enum: ['REPO', 'PROJECT'] }) kind?: ChatThreadKind;
  @Allow() @ApiProperty({ required: false }) repoId?: string;
  @Allow() @ApiProperty({ required: false }) feature?: string;
  @Allow() @ApiProperty({ required: false }) baseRef?: string;
  @Allow() @ApiProperty() title: string;
  @Allow() @ApiProperty({ required: false }) maxCostUsd?: number;
  @Allow() @ApiProperty({ type: 'object', additionalProperties: true }) backend: ThreadBackend;
}
