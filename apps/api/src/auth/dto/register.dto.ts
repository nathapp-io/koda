import { IsEmail, IsString, MinLength, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  declare email: string;

  @ApiProperty({ example: 'John Doe' })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(1, { message: '$t(common.validation.minLength)' })
  declare name: string;

  @ApiProperty({ example: 'StrongPass123!' })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(12, { message: '$t(common.validation.minLength)' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).+$/, {
    message: '$t(common.validation.passwordComplexity)',
  })
  declare password: string;
}
