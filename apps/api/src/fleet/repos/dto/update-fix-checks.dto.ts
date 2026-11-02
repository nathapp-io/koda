import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Fleet FIX US-001: the body of `PATCH /fleet/repos/:id/fix-checks`. The field is required, so a body
 * that omits it (or sends a non-boolean such as `"yes"`) is a 400 and never reaches the service.
 */
export class UpdateFixChecksDto {
  @ApiProperty({ description: 'Allow FIX to run the check commands it detects for a base branch without nax check commands' })
  @IsBoolean() declare trustDetectedChecks: boolean;
}
