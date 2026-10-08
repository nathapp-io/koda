import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import type { TransformFnParams } from 'class-transformer';
import { IsEmail, IsIn, MaxLength } from 'class-validator';
import { ProjectMemberRole } from '../../members/domain/project-member.domain';
import { INVITE_ROLES } from '../domain/project-invite.domain';

/** A padded address (' New@X.io ') is normalised before @IsEmail runs; the service lowercases it. */
const trimmed = ({ value }: TransformFnParams): unknown => (typeof value === 'string' ? value.trim() : value);

/** Fleet S4b US-004: body of `POST /projects/:slug/invites`. */
export class CreateInviteDto {
  @ApiProperty({ description: 'Email to add or invite', example: 'dev@example.com' })
  @Transform(trimmed)
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  @MaxLength(254)
  declare email: string;

  @ApiProperty({ enum: INVITE_ROLES })
  @IsIn(INVITE_ROLES, { message: '$t(common.validation.isEnum)' })
  declare role: ProjectMemberRole;
}
