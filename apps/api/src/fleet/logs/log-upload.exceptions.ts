import { AppException } from '@nathapp/nestjs-common';

/** Plan D319: 413 chunk too large, 422 SHA mismatch, 507 storage failure. */
export class FleetLogException extends AppException {
  constructor(status: 413 | 422 | 507, args: Record<string, unknown> = {}) {
    const key = status === 413 ? 'fleet.logChunk' : status === 422 ? 'fleet.logHash' : 'fleet.logStorage';
    super(status, args, key, status);
  }
}
