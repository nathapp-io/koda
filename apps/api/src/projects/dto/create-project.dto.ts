import { IsString, MinLength, Matches, IsOptional, IsUrl, IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProjectDto {
  @ApiProperty({
    description: 'Project name',
    example: 'Koda',
    minLength: 2,
  })
  @IsString()
  @MinLength(2, { message: 'Name must be at least 2 characters long' })
  name!: string;

  @ApiProperty({
    description: 'Project slug - lowercase alphanumeric with hyphens',
    example: 'koda',
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
  })
  @IsString()
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'Slug must contain only lowercase alphanumeric characters and hyphens',
  })
  slug!: string;

  @ApiProperty({
    description: 'Project key - 2-6 uppercase letters for ticket references',
    example: 'KODA',
    pattern: '^[A-Z]{2,6}$',
  })
  @IsString()
  @Matches(/^[A-Z]{2,6}$/, {
    message: 'Key must be 2-6 uppercase letters',
  })
  key!: string;

  @ApiProperty({
    description: 'Project description',
    example: 'Dev ticket tracker',
    required: false,
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Git remote repository URL',
    example: 'https://github.com/nathapp-io/koda',
    required: false,
  })
  @IsOptional()
  @IsUrl()
  gitRemoteUrl?: string;

  @ApiProperty({
    description: 'Automatically index commits on ticket close',
    example: true,
    required: false,
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  autoIndexOnClose?: boolean;
}
