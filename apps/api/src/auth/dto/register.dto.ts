import { IsEmail, IsOptional, IsString, MinLength, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class RegisterDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: '$t(common.validation.isEmail)' })
  declare email: string;

  @ApiPropertyOptional({ example: 'John Doe' })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(1, { message: '$t(common.validation.minLength)' })
  declare name?: string;

  @ApiProperty({ example: 'StrongPass123!' })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(8, { message: '$t(common.validation.minLength)' })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).+$/, {
    message: '$t(common.validation.passwordComplexity)',
  })
  declare password: string;
}
