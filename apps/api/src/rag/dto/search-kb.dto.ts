import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class SearchKbDto {
  @ApiPropertyOptional({ description: 'Natural language search query' })
  @IsString()
  @MinLength(1)
  query!: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, description: 'Result limit (capped at 50)' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  limit?: number = 20;
}
