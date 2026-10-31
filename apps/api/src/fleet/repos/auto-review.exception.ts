import { AppException } from '@nathapp/nestjs-common';

/** 422: auto-review settings cannot be enabled for this caller or repository. */
export class AutoReviewException extends AppException {
  constructor(readonly reason: string) {
    super(422, { reason }, 'fleet.autoReview', 422);
  }
}
