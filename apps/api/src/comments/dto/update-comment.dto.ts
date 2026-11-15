import { IsOptional, IsString, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateCommentDto {
  @ApiPropertyOptional({
    description: 'Comment body',
    example: 'Updated comment body',
    minLength: 1,
  })
  @IsOptional()
  @IsString({ message: 'common.validation.isString' })
  @MinLength(1, { message: 'common.validation.required' })
  body?: string;
}
