import { ApiProperty } from '@nestjs/swagger';

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
}
