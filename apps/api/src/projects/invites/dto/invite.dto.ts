import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectMemberDto } from '../../members/dto/project-member.dto';
import { InviteStatus } from '../domain/project-invite.domain';

/** Fleet S4b US-004: the public invite shape. Never carries a token or a token hash. */
export class InviteDto {
  @ApiProperty() declare id: string;
  @ApiProperty() declare email: string;
  @ApiProperty() declare role: string;
  @ApiProperty({ enum: ['PENDING', 'ACCEPTED', 'EXPIRED', 'CANCELLED'] }) declare status: InviteStatus;
  @ApiPropertyOptional({ nullable: true, type: String }) declare inviterName: string | null;
  @ApiProperty() declare expiresAt: Date;
  @ApiProperty() declare createdAt: Date;
}

/** Fleet S4b US-004: one result class so the CLI types expose every outcome field. */
export class InviteCreateResultDto {
  @ApiProperty({ enum: ['ADDED', 'INVITED'] }) declare outcome: 'ADDED' | 'INVITED';
  @ApiPropertyOptional({ type: ProjectMemberDto }) declare member?: ProjectMemberDto;
  @ApiPropertyOptional({ type: InviteDto }) declare invite?: InviteDto;
  @ApiPropertyOptional() declare invitePath?: string;
  @ApiPropertyOptional() declare emailed?: boolean;
}
