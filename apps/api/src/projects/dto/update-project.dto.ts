import { IsString, MinLength, Matches, IsOptional, IsUrl, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateProjectDto {
  @ApiProperty({
    description: 'Project name',
    example: 'Updated Project Name',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters long' })
  name?: string;

  @ApiProperty({
    description: 'Project slug - lowercase alphanumeric with hyphens',
    example: 'updated-project',
    required: false,
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'Slug must contain only lowercase alphanumeric characters and hyphens',
  })
  slug?: string;

  @ApiProperty({
    description: 'Project key - 2-6 uppercase alphanumeric characters',
    example: 'UPDATED',
    required: false,
    pattern: '^[A-Z0-9]{2,6}$',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9]{2,6}$/, {
    message: 'Key must be 2-6 uppercase alphanumeric characters',
  })
  key?: string;

  @ApiProperty({
    description: 'Project description',
    example: 'Updated description',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Git remote repository URL',
    example: 'https://github.com/nathapp-io/updated-repo',
    required: false,
  })
  @IsOptional()
  @IsUrl()
  gitRemoteUrl?: string;

  @ApiProperty({
    description: 'Automatically index commits on ticket close',
    example: false,
    required: false,
  })
  @IsOptional()
  @IsBoolean()
  autoIndexOnClose?: boolean;
}
