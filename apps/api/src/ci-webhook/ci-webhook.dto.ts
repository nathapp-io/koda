import { Type } from 'class-transformer';
import { IsString, IsOptional, IsArray, ValidateNested, IsIn } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CiPipelineDto {
  @ApiProperty({ description: 'Pipeline ID', example: '12345' })
  @IsString()
  id!: string;

  @ApiPropertyOptional({ description: 'Pipeline URL', example: 'https://github.com/org/repo/actions/runs/12345' })
  @IsOptional()
  @IsString()
  url?: string;
}

export class CiCommitDto {
  @ApiProperty({ description: 'Commit SHA', example: 'abc123def456' })
  @IsString()
  sha!: string;

  @ApiPropertyOptional({ description: 'Commit message', example: 'feat: add dark mode' })
  @IsOptional()
  @IsString()
  message?: string;
}

export class CiFailureDto {
  @ApiProperty({ description: 'Failed test or step name', example: 'AuthService.validateToken' })
  @IsString()
  test!: string;

  @ApiPropertyOptional({ description: 'File path where failure occurred', example: 'apps/api/src/auth/auth.service.ts' })
  @IsOptional()
  @IsString()
  file?: string;

  @ApiPropertyOptional({ description: 'Line number where failure occurred', example: 87 })
  @IsOptional()
  @Type(() => Number)
  line?: number;
}

export class CiWebhookPayloadDto {
  @ApiProperty({ description: 'CI event type', example: 'pipeline_failed' })
  @IsString()
  @IsIn(['pipeline_failed', 'pipeline_success'])
  event!: string;

  @ApiProperty({ description: 'Pipeline information', type: CiPipelineDto })
  @ValidateNested()
  @Type(() => CiPipelineDto)
  pipeline!: CiPipelineDto;

  @ApiProperty({ description: 'Commit information', type: CiCommitDto })
  @ValidateNested()
  @Type(() => CiCommitDto)
  commit!: CiCommitDto;

  @ApiProperty({ description: 'List of failures', type: [CiFailureDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CiFailureDto)
  failures!: CiFailureDto[];
}

export class CiWebhookResponseDto {
  @ApiProperty({ description: 'Whether the webhook was processed successfully' })
  success!: boolean;

  @ApiProperty({ description: 'Created ticket reference', example: 'KODA-42' })
  ticketRef?: string;

  @ApiProperty({ description: 'Message describing the result' })
  message!: string;
}
