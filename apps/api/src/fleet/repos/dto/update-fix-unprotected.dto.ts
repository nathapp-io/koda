import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * The body of `PATCH /fleet/repos/:id/fix-unprotected`. The field is required, so a body that omits it
 * (or sends a non-boolean) is a 400 and never reaches the service.
 */
export class UpdateFixUnprotectedDto {
  @ApiProperty({ description: 'Allow FIX to push although the default branch is unprotected' })
  @IsBoolean() declare allowUnprotected: boolean;
}
