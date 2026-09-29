import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsIn, IsInt, IsObject, IsString, Matches, MaxLength } from 'class-validator';
import { LABEL_PATTERN } from './create-enrollment.dto';

export class EnrollDto {
  @ApiProperty() @IsString() @MaxLength(200) declare enrollmentToken: string;
  @ApiProperty({ description: 'Unique runner name' }) @Matches(/^[a-z0-9][a-z0-9-]{0,62}$/) declare name: string;
  @ApiProperty({ enum: ['darwin', 'linux'] }) @IsIn(['darwin', 'linux']) declare os: 'darwin' | 'linux';
  @ApiProperty({ enum: ['arm64', 'x64'] }) @IsIn(['arm64', 'x64']) declare arch: 'arm64' | 'x64';
  @ApiProperty() @IsString() @MaxLength(40) declare daemonVersion: string;
  @ApiProperty() @IsInt() declare protocolVersion: number;
  @ApiProperty() @IsString() @MaxLength(64) declare bootId: string;
  @ApiProperty({ type: [String] }) @IsArray() @ArrayMaxSize(20) @Matches(LABEL_PATTERN, { each: true }) declare labels: string[];
  @ApiProperty({ type: Object, description: 'RunnerCapabilities (spec §2.1), validated by parseCapabilities' })
  @IsObject() declare capabilities: Record<string, unknown>;
}
