import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsObject, IsOptional, IsString } from 'class-validator';

export class DispatchAgentDto {
  @ApiProperty() @IsString() declare name: string;
  @ApiProperty() @IsString() declare task: string;
  @ApiPropertyOptional() @IsOptional() @IsString() model?: string;
  @ApiPropertyOptional({ type: Object }) @IsOptional() @IsObject() modelAliases?: Record<string, string>;
  @ApiPropertyOptional() @IsOptional() @IsInt() timeoutSec?: number;
}
