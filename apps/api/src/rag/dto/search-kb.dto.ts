import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Min, MinLength } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class SearchKbDto {
  @ApiPropertyOptional({ description: 'Natural language search query' })
  @IsString()
  @MinLength(1)
  query!: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 50, description: 'Result limit (capped at 50)' })
  @IsOptional()
  @Type(() => Number)
  @Transform(({ value }) => { const n = Number(value); return isNaN(n) ? value : Math.min(n, 50); })
  @IsNumber()
  @Min(1)
  limit?: number = 20;
}
