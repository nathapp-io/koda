import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RetireDecisionDto {
  @ApiProperty({ required: false, maxLength: 500, description: 'Why the decision is being retired' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
