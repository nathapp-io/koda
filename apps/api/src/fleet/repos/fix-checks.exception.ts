import { AppException } from '@nathapp/nestjs-common';

/**
 * 422: the fix-checks setting cannot be turned on for this repository. The only reason is
 * `github app required` — koda can only run detected checks for a repo it can broker a GitHub App
 * token for. Disabling is never refused, so this exception is only raised while enabling.
 */
export class FixChecksException extends AppException {
  constructor(readonly reason: string) {
    super(422, { reason }, 'fleet.fixChecks', 422);
  }
}
