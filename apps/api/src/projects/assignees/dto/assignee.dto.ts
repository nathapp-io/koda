import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AssigneeDomain } from '../domain/project-assignee.domain';

/** S4c US-004 §3.3: one pickable assignee. */
export class AssigneeDto {
  @ApiProperty({ enum: ['user', 'agent'], description: 'Whether the assignee is a user or an agent' })
  declare type: 'user' | 'agent';

  @ApiProperty({ description: 'User.id for a user, Agent.id for an agent' })
  declare id: string;

  @ApiProperty() declare name: string;

  @ApiProperty({ description: 'The email for a user, the slug for an agent' })
  declare secondary: string;

  @ApiPropertyOptional({ description: 'Agent status (ACTIVE | PAUSED); absent for users' })
  declare status?: string;

  static from(a: AssigneeDomain): AssigneeDto {
    return {
      type: a.type,
      id: a.id,
      name: a.name,
      secondary: a.secondary,
      ...(a.status !== undefined && { status: a.status }),
    };
  }
}

export class AssigneeListDto {
  @ApiProperty({ type: [AssigneeDto] })
  declare items: AssigneeDto[];
}
