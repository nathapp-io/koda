import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MinLength } from 'class-validator';
import { PASSWORD_COMPLEXITY } from './register.dto';

export class ChangePasswordDto {
  @ApiProperty()
  @IsString({ message: 'common.validation.isString' })
  @MinLength(1, { message: 'common.validation.minLength|{"min":1}' })
  declare currentPassword: string;

  @ApiProperty()
  @IsString({ message: 'common.validation.isString' })
  @MinLength(8, { message: 'common.validation.minLength|{"min":8}' })
  @Matches(PASSWORD_COMPLEXITY, { message: 'common.validation.passwordComplexity' })
  declare newPassword: string;
}
