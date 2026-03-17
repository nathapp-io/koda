import { IsString, IsNotEmpty, IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export enum CommentTypeEnum {
  VERIFICATION = 'VERIFICATION',
  FIX_REPORT = 'FIX_REPORT',
  REVIEW = 'REVIEW',
  STATUS_CHANGE = 'STATUS_CHANGE',
  GENERAL = 'GENERAL',
}

export class CreateCommentDto {
  @ApiProperty({
    description: 'Comment body text',
    example: 'This is a test comment',
  })
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiProperty({
    description: 'Comment type',
    enum: CommentTypeEnum,
    example: CommentTypeEnum.GENERAL,
  })
  @IsEnum(CommentTypeEnum)
  @IsNotEmpty()
  type: CommentTypeEnum;
}
