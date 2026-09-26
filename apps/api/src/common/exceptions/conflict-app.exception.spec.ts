import { AppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from './conflict-app.exception';

describe('ConflictAppException', () => {
  it('is an AppException with code 409 and HTTP 409', () => {
    const ex = new ConflictAppException({}, 'users');
    expect(ex).toBeInstanceOf(AppException);
    expect(ex.code).toBe(409);
    expect(ex.httpStatus).toBe(409);
    expect(ex.prefix).toBe('users');
  });
});
