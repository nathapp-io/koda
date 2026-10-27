import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import type { ApprovalPolicyInput, ApprovalSubjectType } from '../domain/approval.domain';
import { InvalidApprovalPolicyError } from '../domain/approval.errors';

export class ApprovalPolicySubjectDto {
  @ApiProperty({ enum: ['all', 'type', 'role', 'principal'] })
  @IsIn(['all', 'type', 'role', 'principal'])
  kind!: 'all' | 'type' | 'role' | 'principal';

  @ApiPropertyOptional({ enum: ['USER', 'AGENT', 'ASSISTANT'] })
  @IsOptional()
  @IsIn(['USER', 'AGENT', 'ASSISTANT'])
  principalType?: ApprovalSubjectType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  roleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  principalId?: string;
}

export function toPolicySubject(dto: ApprovalPolicySubjectDto): ApprovalPolicyInput['appliesTo'] {
  switch (dto?.kind) {
    case 'all': return { kind: 'all' };
    case 'type':
      if (dto.principalType && ['USER', 'AGENT', 'ASSISTANT'].includes(dto.principalType)) return { kind: 'type', principalType: dto.principalType };
      break;
    case 'role':
      if (dto.roleId) return { kind: 'role', roleId: dto.roleId };
      break;
    case 'principal':
      if ((dto.principalType === 'USER' || dto.principalType === 'AGENT') && dto.principalId) return { kind: 'principal', principalType: dto.principalType, principalId: dto.principalId };
      break;
  }
  throw new InvalidApprovalPolicyError('subject');
}
