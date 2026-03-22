import { IsOptional, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class TransitionWithCommentDto {
  @ApiPropertyOptional({
    description: 'Comment body explaining the transition',
    example: 'This ticket has been verified and is ready to work on',
  })
  @IsOptional()
  @IsString()
  body?: string;
}
