/**
 * Stub — implementation will be filled in by US-004 implementer.
 * Replaces raw NestJS HTTP exceptions; carries an i18n key for localised messages.
 */
import { HttpException, HttpStatus } from '@nestjs/common';

export class AppException extends HttpException {
  constructor(
    public readonly i18nKey: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super(i18nKey, status);
  }
}
