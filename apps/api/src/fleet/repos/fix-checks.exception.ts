import { AppException } from '@nathapp/nestjs-common';

/**
 * 422: the fix-checks setting cannot be turned on for this repository. GitHub repos need an App
 * installation and GitLab repos need stored credentials. Disabling is never refused, so this
 * exception is only raised while enabling.
 */
export class FixChecksException extends AppException {
  constructor(readonly reason: string) {
    super(422, { reason }, 'fleet.fixChecks', 422);
  }
}
