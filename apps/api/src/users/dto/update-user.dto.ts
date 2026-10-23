import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * Permissions P1l (US-005): `disabled` is the only user patch field. A global admin is granted by
 * `POST /role-bindings` and removed by its `DELETE`, so a patch can no longer promote or demote.
 */
export class UpdateUserDto {
  @ApiPropertyOptional({ description: 'Disabling revokes every session of the user' })
  @IsOptional()
  @IsBoolean({ message: '$t(common.validation.isBoolean)' })
  disabled?: boolean;
}
