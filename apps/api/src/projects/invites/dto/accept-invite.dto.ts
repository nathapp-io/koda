import { IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PASSWORD_COMPLEXITY } from '../../../auth/dto/register.dto';

/**
 * Fleet S4b US-005: the public accept body. `password` carries register's exact
 * complexity rules; the invite itself supplies the email and the role.
 */
export class AcceptInviteDto {
  @ApiPropertyOptional({ example: 'Jane Doe' })
  @IsOptional()
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(1, { message: '$t(common.validation.minLength)' })
  declare name?: string;

  @ApiProperty({ example: 'StrongPass123!' })
  @IsString({ message: '$t(common.validation.isString)' })
  @MinLength(8, { message: '$t(common.validation.minLength)' })
  @Matches(PASSWORD_COMPLEXITY, {
    message: '$t(common.validation.passwordComplexity)',
  })
  declare password: string;
}
