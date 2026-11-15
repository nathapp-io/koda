import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_COMPLEXITY } from '../../auth/dto/register.dto';

/**
 * Permissions P1l (US-005): an account is created as a plain member. There is no request field for a
 * global role — granting one is `POST /role-bindings` (roleKey `admin`, no project) after the create.
 */
export class CreateUserDto {
  @ApiProperty({ example: 'dev@example.com' })
  @IsEmail({}, { message: 'common.validation.isEmail' })
  @MaxLength(254, { message: 'common.validation.maxLength' })
  declare email: string;

  @ApiProperty({ example: 'Dev User' })
  @IsString({ message: 'common.validation.isString' })
  @MinLength(1, { message: 'common.validation.minLength' })
  @MaxLength(100, { message: 'common.validation.maxLength' })
  declare name: string;

  @ApiProperty({ description: 'Temporary password, handed over out of band', example: 'StrongPass123!' })
  @IsString({ message: 'common.validation.isString' })
  @MinLength(8, { message: 'common.validation.minLength' })
  @Matches(PASSWORD_COMPLEXITY, { message: 'common.validation.passwordComplexity' })
  declare password: string;
}
