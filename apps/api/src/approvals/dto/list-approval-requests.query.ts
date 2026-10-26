import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { KodaPageQuery } from '../../common/dto/koda-page.query';
import type { ApprovalRequestStatus } from '../domain/approval.domain';

export const APPROVAL_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'cancelled', 'executed', 'failed'] as const;
const toBoolean = ({ value }: { value: unknown }) => value === 'true' ? true : value === 'false' ? false : value;

export class ListApprovalRequestsQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: APPROVAL_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(APPROVAL_REQUEST_STATUSES)
  status?: ApprovalRequestStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  projectId?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  permissionKey?: string;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  mine?: boolean;
}
