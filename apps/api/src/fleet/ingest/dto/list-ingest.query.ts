import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { KodaPageQuery } from '../../../common/dto/koda-page.query';
import { INGEST_STATUSES, IngestStatus } from '../domain/bundle-ingest.domain';

export class ListIngestQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: INGEST_STATUSES })
  @IsOptional()
  @IsIn(INGEST_STATUSES as unknown as string[])
  status?: IngestStatus;
}
