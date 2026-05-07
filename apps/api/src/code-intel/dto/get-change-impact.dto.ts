import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GetChangeImpactDto {
  @ApiProperty({ description: 'Repository identifier' })
  @IsString()
  @IsNotEmpty()
  repoId!: string;

  @ApiProperty({ description: 'Git commit hash' })
  @IsString()
  @IsNotEmpty()
  commitHash!: string;

  @ApiProperty({ description: 'Comma-separated list of changed file paths' })
  @IsString()
  @IsNotEmpty()
  changedFiles!: string;

  @ApiPropertyOptional({ description: 'Ticket ID for provenance metadata' })
  @IsOptional()
  @IsString()
  ticketId?: string;
}
