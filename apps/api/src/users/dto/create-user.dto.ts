import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import { PASSWORD_COMPLEXITY } from '../../auth/dto/register.dto';
import { GLOBAL_ROLES, GlobalRole } from '../domain/user-admin.domain';

export class CreateUserDto {
  @ApiProperty({ example: 'dev@example.com' })
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  declare email: string;

  @ApiProperty({ example: 'Dev User' })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(1, { message: '$t(common.validation.minLength)' })
  @MaxLength(100, { message: '$t(common.validation.maxLength)' })
  declare name: string;

  @ApiProperty({ description: 'Temporary password, handed over out of band', example: 'StrongPass123!' })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(8, { message: '$t(common.validation.minLength)' })
  @Matches(PASSWORD_COMPLEXITY, { message: '$t(common.validation.passwordComplexity)' })
  declare password: string;

  @ApiProperty({ enum: GLOBAL_ROLES })
  @IsIn(GLOBAL_ROLES, { message: '$t(common.validation.isEnum)' })
  declare role: GlobalRole;
}
