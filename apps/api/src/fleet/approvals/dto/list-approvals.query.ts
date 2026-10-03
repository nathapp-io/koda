import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { KodaPageQuery } from '../../../common/dto/koda-page.query';
import { APPROVAL_STATUSES, APPROVAL_TYPES, ApprovalStatus, ApprovalType } from '../domain/approval.domain';

export class ListApprovalsQuery extends KodaPageQuery {
  @ApiPropertyOptional({ enum: APPROVAL_STATUSES }) @IsOptional() @IsIn(APPROVAL_STATUSES) status?: ApprovalStatus;
  @ApiPropertyOptional({ enum: APPROVAL_TYPES }) @IsOptional() @IsIn(APPROVAL_TYPES) type?: ApprovalType;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) jobId?: string;
}
