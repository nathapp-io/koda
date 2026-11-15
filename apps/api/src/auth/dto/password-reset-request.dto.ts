import { IsEmail, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * auth-passwords US-003: the public reset-request body. The address validators and their messages are
 * the ones `RegisterDto.email` uses, so both surfaces refuse the same input the same way.
 */
export class PasswordResetRequestDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: 'common.validation.isEmail' })
  @MaxLength(254, { message: 'common.validation.maxLength' })
  declare email: string;
}
