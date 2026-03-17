import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class TransitionWithCommentDto {
  @ApiProperty({
    description: 'Comment body explaining the transition',
    example: 'This ticket has been verified and is ready to work on',
  })
  @IsString()
  body!: string;
}
