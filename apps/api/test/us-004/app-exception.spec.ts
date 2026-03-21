/**
 * US-004 — AppException class contract (v3 @nathapp/nestjs-common)
 *
 * Tests that AppException is a numeric-coded HTTP exception.
 * v3 signature: new AppException(code: number, args?, prefix?, httpStatus?)
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { AppException, NotFoundAppException, ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';

describe('AppException', () => {
  describe('constructor', () => {
    it('is an instance of HttpException', () => {
      const ex = new AppException(404, undefined, undefined, HttpStatus.NOT_FOUND);
      expect(ex).toBeInstanceOf(HttpException);
    });

    it('is an instance of AppException', () => {
      const ex = new AppException(404, undefined, undefined, HttpStatus.NOT_FOUND);
      expect(ex).toBeInstanceOf(AppException);
    });

    it('stores the numeric code on the instance', () => {
      const ex = new AppException(403, undefined, undefined, HttpStatus.FORBIDDEN);
      expect(ex.code).toBe(403);
    });

    it('carries the provided HTTP status via getStatus()', () => {
      const ex = new AppException(404, undefined, undefined, HttpStatus.NOT_FOUND);
      expect(ex.getStatus()).toBe(HttpStatus.NOT_FOUND);
    });

    it('defaults to 500 when no httpStatus provided', () => {
      const ex = new AppException(-1);
      expect(ex.getStatus()).toBe(500);
    });

    it('stores args when provided', () => {
      const args = { field: 'email' };
      const ex = new AppException(-2, args);
      expect(ex.args).toEqual(args);
    });

    it('stores prefix when provided', () => {
      const ex = new AppException(-2, undefined, 'tickets');
      expect(ex.prefix).toBe('tickets');
    });
  });

  describe('typed exception subclasses', () => {
    it('NotFoundAppException has HTTP 404 status', () => {
      const ex = new NotFoundAppException();
      expect(ex).toBeInstanceOf(AppException);
      expect(ex.getStatus()).toBe(HttpStatus.NOT_FOUND);
    });

    it('ForbiddenAppException has HTTP 403 status', () => {
      const ex = new ForbiddenAppException();
      expect(ex).toBeInstanceOf(AppException);
      expect(ex.getStatus()).toBe(HttpStatus.FORBIDDEN);
    });

    it('ValidationAppException is an AppException', () => {
      const ex = new ValidationAppException();
      expect(ex).toBeInstanceOf(AppException);
    });

    it.each([
      [new NotFoundAppException(), HttpStatus.NOT_FOUND],
      [new ForbiddenAppException(), HttpStatus.FORBIDDEN],
    ] as const)(
      'each typed exception carries the correct HTTP status',
      (ex, expectedStatus) => {
        expect(ex.getStatus()).toBe(expectedStatus);
      },
    );
  });
});
