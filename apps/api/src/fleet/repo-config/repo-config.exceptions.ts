import { AppException } from '@nathapp/nestjs-common';

/** 409: koda cannot obtain read access to the repo (spec §4.1). `reason` is a RepoCheckReason or `no_installation`. */
export class RepoUnreachableException extends AppException {
  constructor(readonly reason: string) {
    super(409, { reason }, 'fleet.repoUnreachable', 409);
  }
}

/** 502: the forge answered badly or not at all; the message never carries forge text (spec §4.1). */
export class ForgeErrorException extends AppException {
  constructor() {
    super(502, {}, 'fleet.forge', 502);
  }
}

/** 422: a `.nax/` file over 256 KiB or not UTF-8 text; the editor shows it read-only (spec §4.1). */
export class NaxFileUnreadableException extends AppException {
  constructor(readonly reason: 'too_large' | 'not_text') {
    super(422, { reason }, 'fleet.naxFile', 422);
  }
}

/** 409: the repo already has an active config job (spec §1, D465). */
export class ConfigJobActiveException extends AppException {
  constructor(readonly activeJobId: string) {
    super(409, { activeJobId }, 'fleet.configJobActive', 409);
  }
}
