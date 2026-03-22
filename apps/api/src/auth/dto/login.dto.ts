import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  declare email: string;

  @ApiProperty({ example: 'password123' })
  @IsString({ message: '$t(common.validation.isString)' })
  declare password: string;
}
