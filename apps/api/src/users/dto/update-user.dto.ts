import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional } from 'class-validator';
import { GLOBAL_ROLES, GlobalRole } from '../domain/user-admin.domain';

export class UpdateUserDto {
  @ApiPropertyOptional({ enum: GLOBAL_ROLES })
  @IsOptional()
  @IsIn(GLOBAL_ROLES, { message: '$t(common.validation.isEnum)' })
  role?: GlobalRole;

  @ApiPropertyOptional({ description: 'Disabling revokes every session of the user' })
  @IsOptional()
  @IsBoolean({ message: '$t(common.validation.isBoolean)' })
  disabled?: boolean;
}
