import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  declare email: string;

  @ApiProperty({ example: 'John Doe' })
  @IsString()
  @MinLength(1)
  declare name: string;

  @ApiProperty({ example: 'password123' })
  @IsString()
  @MinLength(8)
  declare password: string;
}
