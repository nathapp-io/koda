import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { OutboxStatus } from '@nathapp/nestjs-outbox';

/**
 * Typed as the string-literal union, not `OutboxStatus`: for a package enum the swagger
 * CLI plugin emits a require of the Bun store path, which the production image cannot
 * resolve (see scripts/check-dist-requires.ts). `@IsEnum` guarantees the value at runtime.
 */
export type OutboxStatusValue = `${OutboxStatus}`;

export class OutboxListQueryDto {
  @ApiPropertyOptional({ enum: OutboxStatus, default: OutboxStatus.PENDING })
  @IsOptional()
  @IsEnum(OutboxStatus)
  status?: OutboxStatusValue;
}
