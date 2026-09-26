import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { OutboxStatus } from '@nathapp/nestjs-outbox';

export class OutboxListQueryDto {
  @ApiPropertyOptional({ enum: OutboxStatus, default: OutboxStatus.PENDING })
  @IsOptional()
  @IsEnum(OutboxStatus)
  status?: OutboxStatus;
}
