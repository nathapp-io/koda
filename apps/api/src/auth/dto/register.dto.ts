import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  declare email: string;

  @ApiProperty({ example: 'John Doe' })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(1, { message: '$t(common.validation.minLength)' })
  declare name: string;

  @ApiProperty({ example: 'password123' })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(8, { message: '$t(common.validation.minLength)' })
  declare password: string;
}
