import { AppException } from '@nathapp/nestjs-common';

/**
 * 409 for state conflicts (duplicate email, last admin). @nathapp/nestjs-common
 * has no conflict AppException; this one keeps the i18n `<prefix>.409` lookup
 * that plain HttpException(…, CONFLICT) skips.
 */
export class ConflictAppException extends AppException {
  constructor(args: Record<string, unknown> = {}, prefix?: string) {
    super(409, args, prefix, 409);
  }
}
