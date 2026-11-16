import { IsEmail, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: 'common.validation.isEmail' })
  declare email: string;

  @ApiProperty({ example: 'Password123!' })
  @IsString({ message: 'common.validation.isString' })
  declare password: string;
}
