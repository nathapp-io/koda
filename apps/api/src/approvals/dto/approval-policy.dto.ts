import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsDefined, IsIn, IsInt, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import type { ApprovalMode, KeyScope, PermissionRisk } from '../../permissions/catalog';
import type { ApprovalPolicyRecord, ApprovalSubjectType } from '../domain/approval.domain';
import { ApprovalPolicySubjectDto } from './approval-policy-subject.dto';

const MODES = ['none', 'self', 'agent', 'human'] as const;

export class CreateApprovalPolicyDto {
  @ApiProperty({ minLength: 1, maxLength: 200 })
  @IsString()
  @Length(1, 200)
  permissionPattern!: string;

  @ApiProperty({ type: ApprovalPolicySubjectDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => ApprovalPolicySubjectDto)
  appliesTo!: ApprovalPolicySubjectDto;

  @ApiProperty({ enum: MODES })
  @IsIn(MODES)
  mode!: ApprovalMode;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @IsInt()
  timeoutSec?: number | null;

  @ApiPropertyOptional({ enum: ['reject', 'approve'] })
  @IsOptional()
  @IsIn(['reject', 'approve'])
  onTimeout?: 'reject' | 'approve';

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @IsInt()
  requiredApprovals?: number;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  approverMustHoldAction?: boolean;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  requireDistinctApprover?: boolean;
}

export class ApprovalPolicyDto {
  @ApiProperty() id!: string;
  @ApiProperty() selector!: string;
  @ApiProperty({ type: String, nullable: true }) projectId!: string | null;
  @ApiProperty() permissionPattern!: string;
  @ApiProperty({ enum: ['USER', 'AGENT', 'ASSISTANT'], nullable: true }) principalType!: ApprovalSubjectType | null;
  @ApiProperty({ type: String, nullable: true }) roleId!: string | null;
  @ApiProperty({ type: String, nullable: true }) principalId!: string | null;
  @ApiProperty({ enum: MODES }) mode!: ApprovalMode;
  @ApiProperty({ type: Number, nullable: true }) timeoutSec!: number | null;
  @ApiProperty({ enum: ['reject', 'approve'] }) onTimeout!: 'reject' | 'approve';
  @ApiProperty() requiredApprovals!: number;
  @ApiProperty() approverMustHoldAction!: boolean;
  @ApiProperty() requireDistinctApprover!: boolean;
  @ApiProperty() updatedByType!: string;
  @ApiProperty() updatedById!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) updatedAt!: string;

  static from(record: ApprovalPolicyRecord): ApprovalPolicyDto {
    return Object.assign(new ApprovalPolicyDto(), { ...record, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString() });
  }
}

export class ApprovableKeyDto {
  @ApiProperty() key!: string;
  @ApiProperty({ enum: ['global', 'project', 'any'] }) scope!: KeyScope;
  @ApiProperty({ enum: ['low', 'medium', 'high', 'critical'] }) risk!: PermissionRisk;
  @ApiProperty({ enum: MODES }) floor!: ApprovalMode;
  @ApiProperty({ enum: MODES }) default!: ApprovalMode;
}
