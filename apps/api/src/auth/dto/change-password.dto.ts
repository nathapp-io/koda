import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';
import { PASSWORD_COMPLEXITY } from './register.dto';

export class ChangePasswordDto {
  @ApiProperty()
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(1, { message: '$t(common.validation.minLength)' })
  declare currentPassword: string;

  @ApiProperty()
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(8, { message: '$t(common.validation.minLength)' })
  @Matches(PASSWORD_COMPLEXITY, { message: '$t(common.validation.passwordComplexity)' })
  declare newPassword: string;
}
