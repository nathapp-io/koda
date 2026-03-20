/**
 * US-004 — AppException class contract
 *
 * Tests that AppException carries an i18n key and extends HttpException
 * so NestJS can serialize it into an HTTP error response.
 * These tests are RED until AppException is fully implemented.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { AppException } from '../../src/common/app-exception';

describe('AppException', () => {
  describe('constructor', () => {
    it('is an instance of HttpException', () => {
      const ex = new AppException('errors.notFound', HttpStatus.NOT_FOUND);
      expect(ex).toBeInstanceOf(HttpException);
    });

    it('is an instance of AppException', () => {
      const ex = new AppException('errors.notFound', HttpStatus.NOT_FOUND);
      expect(ex).toBeInstanceOf(AppException);
    });

    it('stores the i18n key on the instance', () => {
      const ex = new AppException('errors.forbidden', HttpStatus.FORBIDDEN);
      expect(ex.i18nKey).toBe('errors.forbidden');
    });

    it('carries the provided HTTP status', () => {
      const ex = new AppException('errors.notFound', HttpStatus.NOT_FOUND);
      expect(ex.getStatus()).toBe(HttpStatus.NOT_FOUND);
    });

    it('defaults to 400 BAD_REQUEST when no status provided', () => {
      const ex = new AppException('common.validation.required');
      expect(ex.getStatus()).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('i18n key patterns', () => {
    it.each([
      ['errors.notFound', HttpStatus.NOT_FOUND],
      ['errors.forbidden', HttpStatus.FORBIDDEN],
      ['errors.unauthorized', HttpStatus.UNAUTHORIZED],
      ['auth.invalidCredentials', HttpStatus.UNAUTHORIZED],
      ['auth.emailTaken', HttpStatus.CONFLICT],
      ['tickets.notFound', HttpStatus.NOT_FOUND],
      ['tickets.invalidTransition', HttpStatus.BAD_REQUEST],
      ['projects.notFound', HttpStatus.NOT_FOUND],
    ] as const)(
      'accepts i18n key "%s" with status %d',
      (key, status) => {
        const ex = new AppException(key, status);
        expect(ex.i18nKey).toBe(key);
        expect(ex.getStatus()).toBe(status);
      },
    );
  });
});
