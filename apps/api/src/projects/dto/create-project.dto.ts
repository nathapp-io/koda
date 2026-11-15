import { IsString, MinLength, Matches, IsOptional, IsUrl, IsBoolean, IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateProjectDto {
  @ApiProperty({
    description: 'Project name',
    example: 'Koda',
    minLength: 2,
  })
  @IsString({ message: 'common.validation.isString' })
  @MinLength(2, { message: 'common.validation.minLength' })
  name!: string;

  @ApiProperty({
    description: 'Project slug - lowercase alphanumeric with hyphens',
    example: 'koda',
    pattern: '^[a-z0-9]+(-[a-z0-9]+)*$',
  })
  @IsString({ message: 'common.validation.isString' })
  @Matches(/^[a-z0-9]+(-[a-z0-9]+)*$/, {
    message: 'projects.slugInvalid',
  })
  slug!: string;

  @ApiProperty({
    description: 'Project key - 2-6 uppercase letters for ticket references',
    example: 'KODA',
    pattern: '^[A-Z]{2,6}$',
  })
  @IsString({ message: 'common.validation.isString' })
  @Matches(/^[A-Z]{2,6}$/, {
    message: 'projects.keyInvalid',
  })
  key!: string;

  @ApiProperty({
    description: 'Project description',
    example: 'Dev ticket tracker',
    required: false,
  })
  @IsOptional()
  @IsString({ message: 'common.validation.isString' })
  description?: string;

  @ApiProperty({
    description: 'Git remote repository URL',
    example: 'https://github.com/nathapp-io/koda',
    required: false,
  })
  @IsOptional()
  @IsUrl({}, { message: 'common.validation.isUrl' })
  gitRemoteUrl?: string;

  @ApiProperty({
    description: 'Automatically index commits on ticket close',
    example: true,
    required: false,
    default: true,
  })
  @IsOptional()
  @IsBoolean({ message: 'common.validation.isBoolean' })
  autoIndexOnClose?: boolean;

  @ApiProperty({
    description: 'Auto-assign mode for tickets: OFF, SUGGEST, or AUTO',
    example: 'OFF',
    required: false,
    default: 'OFF',
    enum: ['OFF', 'SUGGEST', 'AUTO'],
  })
  @IsOptional()
  @IsString({ message: 'common.validation.isString' })
  @IsIn(['OFF', 'SUGGEST', 'AUTO'], { message: 'common.validation.isIn' })
  autoAssign?: string;
}
