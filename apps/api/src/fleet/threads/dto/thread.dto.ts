import { ApiProperty } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import type { ThreadSkillSource } from '../../../skills/skill-catalog.domain';
import type { ThreadBackend } from '../../common/thread-jobs';

export class ThreadDto {
  @ApiProperty() id: string;
  @ApiProperty() repoId: string;
  @ApiProperty() baseRef: string;
  @ApiProperty() feature: string;
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
  @ApiProperty() specPath: string;
  @ApiProperty({ nullable: true }) pendingQuestion: unknown;
  @ApiProperty() lastActivityAt: Date;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true, type: 'object', properties: { id: { type: 'string' }, state: { type: 'string' } } }) activeJob: { id: string; state: string } | null;
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

export class SendMessageDto {
  @Allow() @ApiProperty({ minLength: 1, maxLength: 32768 }) text: string;
  @Allow() @ApiProperty({ pattern: '^[A-Za-z0-9_-]{1,64}$' }) clientMessageId: string;
}

export class SendMessageResultDto {
  @ApiProperty({ type: ChatMessageDto }) message: ChatMessageDto;
  @ApiProperty({ nullable: true }) jobId: string | null;
}

export class CreateThreadDto {
  @Allow() @ApiProperty() repoId: string;
  @Allow() @ApiProperty() feature: string;
  @Allow() @ApiProperty({ required: false }) baseRef?: string;
  @Allow() @ApiProperty() title: string;
  @Allow() @ApiProperty({ required: false }) maxCostUsd?: number;
  @Allow() @ApiProperty({ type: 'object', additionalProperties: true }) backend: ThreadBackend;
}
