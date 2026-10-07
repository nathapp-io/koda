import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsIn, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { CONFIG_JOB_OUTCOMES } from '../../common/config-jobs';
import type { ConfigEditMode, ConfigJobOutcome } from '../../common/config-jobs';
import type { NaxPathGroup } from '../../common/nax-config-paths';

const OUTCOMES = [...CONFIG_JOB_OUTCOMES];
const GROUPS = ['rules', 'context', 'config', 'profiles', 'constitution'];

/** Shape only; config-edit-input.ts enforces the allowlist, sizes and duplicates (spec §1, §2). */
export class ConfigFileEditDto {
  @ApiProperty({ maxLength: 512 }) @IsString() @MaxLength(512) declare path: string;
  @ApiProperty({ enum: ['put', 'delete'] }) @IsIn(['put', 'delete']) declare op: 'put' | 'delete';
  @ApiPropertyOptional({ description: 'Required for put, forbidden for delete; UTF-8, at most 256 KiB' }) @IsOptional() @IsString() content?: string;
  @ApiProperty({ type: String, nullable: true, description: 'Blob SHA the file was loaded at; null for a new file' })
  @IsOptional() @IsString() @MaxLength(64) declare baseSha: string | null;
}

export class SubmitConfigEditDto {
  @ApiProperty({ description: 'Default-branch commit the files were read at (nax-files baseSha)' }) @IsString() @MaxLength(64) declare baseSha: string;
  @ApiProperty({ type: [ConfigFileEditDto], maxItems: 50 })
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => ConfigFileEditDto) declare edits: ConfigFileEditDto[];
  @ApiProperty({ maxLength: 200 }) @IsString() @MaxLength(400) declare prTitle: string;
  @ApiPropertyOptional({ description: 'At most 8 KiB' }) @IsOptional() @IsString() prBody?: string;
}

export class RegenerateConfigDto {
  @ApiProperty({ maxLength: 200 }) @IsString() @MaxLength(400) declare prTitle: string;
  @ApiPropertyOptional() @IsOptional() @IsString() prBody?: string;
}

export class NaxFileEntryDto {
  @ApiProperty() declare path: string;
  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Null on GitLab (tree listings carry no size)' }) declare size: number | null;
  @ApiProperty() declare blobSha: string;
  @ApiProperty({ enum: GROUPS }) declare group: NaxPathGroup;
}

export class NaxFileListDto {
  @ApiProperty() declare baseSha: string;
  @ApiProperty() declare defaultBranch: string;
  @ApiProperty({ type: [NaxFileEntryDto] }) declare files: NaxFileEntryDto[];
}

export class NaxFileContentDto {
  @ApiProperty() declare path: string;
  @ApiProperty() declare blobSha: string;
  @ApiProperty() declare content: string;
}

export class ConfigJobResultDto {
  @ApiProperty({ enum: OUTCOMES }) declare outcome: ConfigJobOutcome;
  @ApiPropertyOptional({ type: [String] }) files?: string[];
  @ApiPropertyOptional({ description: 'nax output tail, at most 8 KiB' }) output?: string;
}

export class ConfigEditPayloadDto {
  @ApiProperty({ enum: ['edit', 'regenerate', 'drift'] }) declare mode: ConfigEditMode;
  @ApiProperty({ type: [ConfigFileEditDto] }) declare edits: ConfigFileEditDto[];
  @ApiPropertyOptional({ type: String, nullable: true }) declare prTitle: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) declare prBody: string | null;
  @ApiProperty() declare baseSha: string;
}

export class FleetJobConfigEditDto {
  @ApiProperty({ enum: ['edit', 'regenerate', 'drift'] }) declare mode: ConfigEditMode;
  @ApiProperty({ type: [String], description: 'Edited paths (contents via GET .../config-edit)' }) declare files: string[];
  @ApiPropertyOptional({ type: String, nullable: true }) declare prTitle: string | null;
  @ApiPropertyOptional({ type: ConfigJobResultDto, nullable: true }) declare result: ConfigJobResultDto | null;
}
