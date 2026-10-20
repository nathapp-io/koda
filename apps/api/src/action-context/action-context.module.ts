import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ActionContextInterceptor } from './action-context.interceptor';

/**
 * US-001: makes the action context global.
 *
 * `APP_INTERCEPTOR` is registered here rather than in `AppModule` so the context — and the write
 * attribution that depends on it — is one import away from being switched off; Nest treats the token
 * as an application-wide enhancer whatever module provides it.
 */
@Module({
  providers: [{ provide: APP_INTERCEPTOR, useClass: ActionContextInterceptor }],
})
export class ActionContextModule {}
