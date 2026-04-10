import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ProjectResponseDto {
  @ApiProperty({
    description: 'Unique project identifier',
    example: 'proj-123',
  })
  id!: string;

  @ApiProperty({
    description: 'Project name',
    example: 'Koda',
  })
  name!: string;

  @ApiProperty({
    description: 'Project slug',
    example: 'koda',
  })
  slug!: string;

  @ApiProperty({
    description: 'Project key for ticket references',
    example: 'KODA',
  })
  key!: string;

  @ApiProperty({
    description: 'Project description',
    example: 'Dev ticket tracker',
    required: false,
  })
  description?: string | null;

  @ApiProperty({
    description: 'Git remote repository URL',
    example: 'https://github.com/nathapp-io/koda',
    required: false,
  })
  gitRemoteUrl?: string | null;

  @ApiProperty({
    description: 'Automatically index commits on ticket close',
    example: true,
  })
  autoIndexOnClose!: boolean;

  @ApiProperty({
    description: 'Project creation timestamp',
  })
  createdAt!: Date;

  @ApiProperty({
    description: 'Last update timestamp',
  })
  updatedAt!: Date;

  @ApiProperty({
    description: 'Soft delete timestamp (null if not deleted)',
    required: false,
  })
  deletedAt?: Date | null;

  @ApiPropertyOptional({
    description: 'CI webhook token for authentication',
    required: false,
  })
  ciWebhookToken?: string | null;

  @ApiPropertyOptional({
    description: 'Auto assign mode',
    required: false,
  })
  autoAssign?: string | null;

  @ApiProperty({
    description: 'Whether Graphify KB import is enabled for this project',
    example: false,
  })
  graphifyEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Timestamp of the last successful Graphify KB import',
    required: false,
  })
  graphifyLastImportedAt?: Date | null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static from(project: any): ProjectResponseDto {
    return {
      id: project.id,
      name: project.name,
      slug: project.slug,
      key: project.key,
      description: project.description,
      gitRemoteUrl: project.gitRemoteUrl,
      autoIndexOnClose: project.autoIndexOnClose,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      deletedAt: project.deletedAt,
      ciWebhookToken: project.ciWebhookToken,
      autoAssign: project.autoAssign,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static fromMany(projects: any[]): ProjectResponseDto[] {
    return projects.map(p => ProjectResponseDto.from(p));
  }
}
