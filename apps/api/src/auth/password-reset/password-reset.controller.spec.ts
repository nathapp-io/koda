import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JsonResponse } from '@nathapp/nestjs-common';
import { IS_PUBLIC_KEY } from '@nathapp/nestjs-auth';
import { PasswordResetController } from './password-reset.controller';
import { PasswordResetService } from './password-reset.service';
import { REQUIRES_METADATA } from '../../permissions/requires.decorator';
import { RequiresGuard } from '../../permissions/requires.guard';
import { AUTH_LOGIN_LIMIT, AUTH_LOGIN_TTL_MS } from '../auth-throttle';

/**
 * auth-passwords US-003: the public reset-request route's contract.
 *
 * The controller has one dependency and no Nest lifecycle, so it is instantiated directly; the
 * decorator metadata is read back the way `RequiresGuard` and the permission contract walker read it.
 */
describe('PasswordResetController', () => {
  const LIMIT_KEY = 'THROTTLER:LIMITdefault';
  const TTL_KEY = 'THROTTLER:TTLdefault';
  const reflector = new Reflector();

  let passwordReset: { request: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> };
  let controller: PasswordResetController;

  beforeEach(() => {
    passwordReset = { request: vi.fn(async () => undefined), confirm: vi.fn(async () => undefined) };
    controller = new PasswordResetController(passwordReset as unknown as PasswordResetService);
  });

  it('AC-1: answers the Ok envelope with an empty body', async () => {
    const result = await controller.requestReset({ email: 'user@example.test' });

    expect(result).toBeInstanceOf(JsonResponse);
    expect(result.data).toEqual({});
  });

  it('AC-11: resolves the locale from Accept-Language, zh only for a value starting with zh', async () => {
    await controller.requestReset({ email: 'user@example.test' }, 'zh-CN,zh;q=0.9');
    await controller.requestReset({ email: 'user@example.test' }, 'fr-FR,fr;q=0.8');
    await controller.requestReset({ email: 'user@example.test' }, undefined);

    expect(passwordReset.request.mock.calls).toEqual([
      ['user@example.test', 'zh'],
      ['user@example.test', 'en'],
      ['user@example.test', 'en'],
    ]);
  });

  it('AC-13 setup: declares the public reset-request key behind RequiresGuard and @Public', () => {
    const handler = PasswordResetController.prototype.requestReset as unknown as object;

    expect(reflector.get(REQUIRES_METADATA, handler)).toEqual({
      keys: ['session.password.reset.request'], mode: 'all', enforcedBy: 'guard',
    });
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RequiresGuard);
  });

  it('AC-12: is throttled with the login limit and window', () => {
    const handler = PasswordResetController.prototype.requestReset as unknown as object;

    expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBe(AUTH_LOGIN_LIMIT);
    expect(Reflect.getMetadata(TTL_KEY, handler)).toBe(AUTH_LOGIN_TTL_MS);
    // No class-level throttle: only the reset route is limited.
    expect(Reflect.getMetadata(LIMIT_KEY, PasswordResetController)).toBeUndefined();
  });

  it('answers 200 and carries no @ApiBearerAuth, because both reset routes are public', () => {
    const handler = PasswordResetController.prototype.requestReset as unknown as object;

    expect(Reflect.getMetadata('__httpCode__', handler)).toBe(200);
    expect(Reflect.getMetadata('swagger/apiSecurity', PasswordResetController)).toBeUndefined();
  });

  /**
   * auth-passwords US-004: the confirm route's contract — same public surface, same throttle, and the
   * envelope the web client expects.
   */
  describe('confirmReset', () => {
    it('AC-1: answers the Ok envelope with an empty body and passes the token and password through', async () => {
      const result = await controller.confirmReset({ token: 'raw-token', newPassword: 'NewPassword123!' });

      expect(result).toBeInstanceOf(JsonResponse);
      expect(result.data).toEqual({});
      expect(passwordReset.confirm.mock.calls).toEqual([
        [{ token: 'raw-token', newPassword: 'NewPassword123!' }, expect.any(Date)],
      ]);
    });

    it('AC-13 setup: declares the public confirm key behind RequiresGuard and @Public', () => {
      const handler = PasswordResetController.prototype.confirmReset as unknown as object;

      expect(reflector.get(REQUIRES_METADATA, handler)).toEqual({
        keys: ['session.password.reset.confirm'], mode: 'all', enforcedBy: 'guard',
      });
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBe(true);
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(RequiresGuard);
    });

    it('AC-12: is throttled with the login limit and window', () => {
      const handler = PasswordResetController.prototype.confirmReset as unknown as object;

      expect(Reflect.getMetadata(LIMIT_KEY, handler)).toBe(AUTH_LOGIN_LIMIT);
      expect(Reflect.getMetadata(TTL_KEY, handler)).toBe(AUTH_LOGIN_TTL_MS);
      // No class-level throttle: only the two reset routes are limited.
      expect(Reflect.getMetadata(LIMIT_KEY, PasswordResetController)).toBeUndefined();
    });

    it('AC-14: answers 200, is a POST and carries no @ApiBearerAuth', () => {
      const handler = PasswordResetController.prototype.confirmReset as unknown as object;

      expect(Reflect.getMetadata('__httpCode__', handler)).toBe(200);
      expect(Reflect.getMetadata('path', handler)).toBe('password-reset/confirm');
      expect(Reflect.getMetadata('swagger/apiSecurity', PasswordResetController)).toBeUndefined();
    });
  });
});
