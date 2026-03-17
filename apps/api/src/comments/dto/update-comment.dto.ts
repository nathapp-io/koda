import { IsString, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateCommentDto {
  @ApiProperty({
    description: 'Updated comment body text',
    example: 'Updated comment body',
  })
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  body?: string;
}
