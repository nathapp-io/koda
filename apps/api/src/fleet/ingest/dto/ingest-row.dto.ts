import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { INGEST_STATUSES, IngestListRow, IngestStatus } from '../domain/bundle-ingest.domain';

export class IngestRowDto {
  @ApiProperty() id: string;
  @ApiProperty() jobId: string;
  @ApiProperty() leaseEpoch: number;
  @ApiProperty() projectId: string;
  @ApiProperty({ enum: INGEST_STATUSES }) status: IngestStatus;
  @ApiProperty() attempts: number;
  @ApiProperty() parserVersion: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } }) files: Record<string, string>;
  @ApiPropertyOptional({ nullable: true }) error: string | null;
  @ApiPropertyOptional({ nullable: true }) ingestedAt: string | null;
  @ApiProperty() updatedAt: string;

  static from(r: IngestListRow): IngestRowDto {
    return Object.assign(new IngestRowDto(), {
      ...r, ingestedAt: r.ingestedAt ? r.ingestedAt.toISOString() : null, updatedAt: r.updatedAt.toISOString(),
    });
  }
}

export class IngestQueuedDto {
  @ApiProperty() queued: number;
}
