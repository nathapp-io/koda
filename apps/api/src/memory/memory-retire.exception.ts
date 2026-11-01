import { AppException } from '@nathapp/nestjs-common';

/** 422: retirement is supported only for decisions. */
export class MemoryRetireException extends AppException {
  constructor(readonly reason: string) {
    super(422, { reason }, 'memory.retireNotDecision', 422);
  }
}
