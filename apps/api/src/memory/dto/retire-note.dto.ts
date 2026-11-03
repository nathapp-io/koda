import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * memory-notes US-011: the body of `POST /memory/notes/:id/retire`.
 *
 * A project note is retired in its own project, so `projectId` is a body field only a *user* note needs: the
 * row has no project of its own, and the project named here is the one membership, `memory.create` and the
 * approval policy are checked against. A project note ignores it (its own project is what authorises the
 * retire), which is why it stays optional. `reason` is bounded exactly as `RetireDecisionDto.reason` is.
 *
 * `@IsOptional()` lets an explicit `null` through exactly as it lets an absent field through, so `null` means
 * "no project named": a project note ignores it and a user note answers the same 400 a missing field earns.
 */
export class RetireNoteDto {
  @ApiProperty({
    required: false,
    description: 'Project the caller is a member of. Required for a user-scoped note (which has no project of its own); ignored for a project note.',
  })
  @IsOptional()
  @IsString()
  projectId?: string;

  @ApiProperty({ required: false, maxLength: 500, description: 'Why the note is being retired' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
