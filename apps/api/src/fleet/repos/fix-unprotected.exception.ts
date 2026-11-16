import { AppException } from '@nathapp/nestjs-common';

/**
 * 422: the FIX unprotected-branch override cannot be turned on for this repository. The only reason is
 * `github app required` or `gitlab credentials required`: FIX mints credentials through its provider connection. Disabling is never refused,
 * so this exception is only raised while enabling.
 */
export class FixUnprotectedException extends AppException {
  constructor(readonly reason: string) {
    super(422, { reason }, 'fleet.fixUnprotected', 422);
  }
}
