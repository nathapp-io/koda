import { AppException } from '@nathapp/nestjs-common';

/** S2a §3 / D345: the stream's files were deleted by retention (§5). */
export class FleetLogExpiredException extends AppException {
  constructor() {
    super(410, {}, 'fleet.logExpired', 410);
  }
}
