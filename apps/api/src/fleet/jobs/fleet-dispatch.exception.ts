import { AppException } from '@nathapp/nestjs-common';
import type { MisfitReason } from './placement-rules';

/** 422: the pinned runner can never run this job (spec §4). */
export class FleetDispatchException extends AppException {
  constructor(readonly reason: MisfitReason) {
    super(422, { reason }, 'fleet.dispatch', 422);
  }
}
