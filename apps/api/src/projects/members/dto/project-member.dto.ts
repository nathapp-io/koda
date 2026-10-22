import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectMemberRecord } from '../domain/project-member.domain';
import { MemberBindingDto } from './member-binding.dto';

/**
 * One project member (US-003), whatever kind of principal it is.
 *
 * A user row names a `User`: `userId` and `email` are set and `agentSlug` is null. An agent row names
 * an `Agent`: `userId` and `email` are null, `agentSlug` is set, and `disabled` is false because an
 * agent principal carries no account state. `principalType` + `principalId` are what a client keys on.
 *
 * `role` and `joinedAt` keep their pre-P1 meaning: the strongest legacy role of the principal's local
 * sources in the project, and the date of its earliest one. `bindings` says which roles it actually
 * holds, so a client renders chips instead of guessing from `role`.
 */
export class ProjectMemberDto {
  @ApiPropertyOptional({ nullable: true, type: String, description: 'Null for an agent' })
  declare userId: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Null for an agent' })
  declare email: string | null;

  @ApiPropertyOptional({ nullable: true, type: String }) declare name: string | null;

  @ApiProperty({ enum: ['ADMIN', 'DEVELOPER', 'AGENT', 'VIEWER'] }) declare role: string;

  /** Global account state (S4c US-003): a disabled member cannot act on the project. */
  @ApiProperty() declare disabled: boolean;

  @ApiProperty() declare joinedAt: Date;

  @ApiProperty({ enum: ['USER', 'AGENT'] }) declare principalType: string;

  @ApiProperty({ description: 'The User.id or Agent.id this row names' }) declare principalId: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'Null for a user' })
  declare agentSlug: string | null;

  @ApiProperty({ type: [MemberBindingDto], description: 'The roles held in this project, oldest first' })
  declare bindings: MemberBindingDto[];

  static from(r: ProjectMemberRecord): ProjectMemberDto {
    return {
      userId: r.userId,
      email: r.email,
      name: r.name,
      role: r.role,
      disabled: r.disabled,
      joinedAt: r.joinedAt,
      principalType: r.principalType,
      principalId: r.principalId,
      agentSlug: r.agentSlug,
      bindings: r.bindings.map(MemberBindingDto.from),
    };
  }
}
