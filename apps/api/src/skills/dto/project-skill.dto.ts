import { ApiProperty } from '@nestjs/swagger';
import type { ProjectSkillDomain } from '../skill-catalog.domain';

export class ProjectSkillDto implements ProjectSkillDomain {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty()
  enabled!: boolean;

  @ApiProperty({ type: 'object', properties: {
    id: { type: 'string' }, gitUrl: { type: 'string' }, ref: { type: 'string' },
    resolvedSha: { type: 'string', nullable: true }, status: { type: 'string' },
  } })
  source!: ProjectSkillDomain['source'];

  static fromDomain(skill: ProjectSkillDomain): ProjectSkillDto {
    return Object.assign(new ProjectSkillDto(), skill);
  }
}

export class ProjectSkillListDto {
  @ApiProperty({ type: [ProjectSkillDto] })
  items!: ProjectSkillDto[];
}
