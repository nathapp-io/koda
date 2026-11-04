import { AppException } from '@nathapp/nestjs-common';

/**
 * 422: the FIX unprotected-branch override cannot be turned on for this repository. The only reason is
 * `github app required`: FIX mints its credentials through the GitHub App. Disabling is never refused,
 * so this exception is only raised while enabling.
 */
export class FixUnprotectedException extends AppException {
  constructor(readonly reason: string) {
    super(422, { reason }, 'fleet.fixUnprotected', 422);
  }
}
