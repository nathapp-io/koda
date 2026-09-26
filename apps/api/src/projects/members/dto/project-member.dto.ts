import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectMemberRecord } from '../domain/project-member.domain';

export class ProjectMemberDto {
  @ApiProperty() declare userId: string;
  @ApiProperty() declare email: string;
  @ApiPropertyOptional({ nullable: true, type: String }) declare name: string | null;
  @ApiProperty({ enum: ['ADMIN', 'DEVELOPER', 'AGENT', 'VIEWER'] }) declare role: string;
  @ApiProperty() declare joinedAt: Date;

  static from(r: ProjectMemberRecord): ProjectMemberDto {
    return { userId: r.userId, email: r.email, name: r.name, role: r.role, joinedAt: r.joinedAt };
  }
}
