import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_COMPLEXITY } from './register.dto';

/**
 * auth-passwords US-004: the public reset-confirmation body. `newPassword` carries `RegisterDto.password`'s
 * validators and messages verbatim, so a password the register route refuses is refused here too — before
 * the token is touched. `token` is the raw value the emailed link carried; only its sha256 is stored.
 */
export class PasswordResetConfirmDto {
  @ApiProperty({ description: 'The raw token from the reset link' })
  @IsString({ message: 'common.validation.isString' })
  @MinLength(1, { message: 'common.validation.minLength' })
  @MaxLength(128, { message: 'common.validation.maxLength' })
  declare token: string;

  @ApiProperty({ example: 'StrongPass123!' })
  @IsString({ message: 'common.validation.isString' })
  @MinLength(8, { message: 'common.validation.minLength' })
  @Matches(PASSWORD_COMPLEXITY, { message: 'common.validation.passwordComplexity' })
  declare newPassword: string;
}
