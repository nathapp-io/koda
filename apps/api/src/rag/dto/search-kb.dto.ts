import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Max, Min, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class SearchKbDto {
  @ApiProperty({ description: 'Natural language search query' })
  @IsString()
  @MinLength(1)
  query!: string;

  @ApiProperty({ required: false, default: 5, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(50)
  limit?: number = 5;
}
