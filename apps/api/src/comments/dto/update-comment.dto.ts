import { IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateCommentDto {
  @ApiProperty({
    description: 'Comment body',
    example: 'Updated comment body',
    minLength: 1,
  })
  @IsString()
  @MinLength(1, { message: 'Body must not be empty' })
  body!: string;
}
