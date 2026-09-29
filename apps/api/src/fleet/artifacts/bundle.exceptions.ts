import { AppException } from '@nathapp/nestjs-common';

/** 413 too large, 415 not gzip, 422 hash mismatch (spec §3.3). */
export class FleetBundleException extends AppException {
  constructor(status: 413 | 415 | 422, args: Record<string, unknown> = {}) {
    super(status, args, 'fleet.bundle', status);
  }
}

/** 409: the caller does not hold the job's current lease (spec §6.2). */
export class FleetFenceException extends AppException {
  constructor() {
    super(409, {}, 'fleet.fence', 409);
  }
}
