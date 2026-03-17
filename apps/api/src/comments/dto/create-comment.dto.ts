import { IsString, MinLength, IsIn, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CommentType } from '@prisma/client';

// Re-export as CommentTypeEnum for backward compatibility with tests
export { CommentType as CommentTypeEnum };

export class CreateCommentDto {
  @ApiProperty({
    description: 'Comment body',
    example: 'This is a comment',
    minLength: 1,
  })
  @IsOptional()
  @IsString()
  @MinLength(1, { message: 'Body must not be empty' })
  body?: string;

  @ApiProperty({
    description: 'Comment type',
    enum: CommentType,
    example: 'GENERAL',
  })
  @IsOptional()
  @IsIn(['VERIFICATION', 'FIX_REPORT', 'REVIEW', 'STATUS_CHANGE', 'GENERAL'])
  type?: string;
}
