import { IsString, IsArray, ValidateNested, IsNotEmpty } from 'class-validator';
import { Type } from 'class-transformer';

export class SourceFileDto {
  @IsString()
  @IsNotEmpty()
  path!: string;

  @IsString()
  @IsNotEmpty()
  content!: string;
}

export class IndexCommitDto {
  @IsString()
  @IsNotEmpty()
  repoId!: string;

  @IsString()
  @IsNotEmpty()
  commitHash!: string;

  @IsString()
  @IsNotEmpty()
  projectSlug!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SourceFileDto)
  files!: SourceFileDto[];
}
