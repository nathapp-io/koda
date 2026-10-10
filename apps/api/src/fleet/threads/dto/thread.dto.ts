import { ApiProperty } from '@nestjs/swagger';
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

export class CreateThreadDto {
  @ApiProperty() repoId: string;
  @ApiProperty() feature: string;
  @ApiProperty({ required: false }) baseRef?: string;
  @ApiProperty() title: string;
  @ApiProperty({ required: false }) maxCostUsd?: number;
  @ApiProperty({ type: 'object', additionalProperties: true }) backend: ThreadBackend;
}
