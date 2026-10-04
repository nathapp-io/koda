import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Min } from 'class-validator';

/** Spec §3.2 query. Pass through `parseQuery` for numbers. */
export class LogRawQuery {
  @ApiPropertyOptional({ minimum: 0, description: "Attempt; defaults to the job's current leaseEpoch (D332)" })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) leaseEpoch?: number;

  @ApiPropertyOptional({ minimum: 0, default: 0 }) @IsOptional() @Type(() => Number) @IsInt() @Min(0) from?: number;

  @ApiPropertyOptional({ minimum: 0, description: 'Exclusive; default from + 1 MiB; to - from at most 1 MiB' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) to?: number;

  @ApiPropertyOptional({ enum: ['1'], description: '1 = the whole stream as an attachment (no range limit)' })
  @IsOptional() @IsIn(['1']) download?: string;
}
