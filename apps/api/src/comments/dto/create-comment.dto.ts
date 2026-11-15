import { IsString, MinLength, IsIn, IsOptional } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { CommentType } from '../../common/enums';

// Re-export as CommentTypeEnum for backward compatibility with tests
export { CommentType as CommentTypeEnum };

export class CreateCommentDto {
  @ApiProperty({
    description: 'Comment body',
    example: 'This is a comment',
    minLength: 1,
  })
  @IsOptional()
  @IsString({ message: 'common.validation.isString' })
  @MinLength(1, { message: 'common.validation.required' })
  body?: string;

  @ApiProperty({
    description: 'Comment type',
    enum: ['GENERAL'],
    example: 'GENERAL',
  })
  @IsOptional()
  @IsIn(['GENERAL'], {
    message: 'common.validation.isEnum',
  })
  type?: string;
}
