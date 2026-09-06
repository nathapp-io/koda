import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule as NathappAuthModule, JwtStrategy, JwtRefreshStrategy } from '@nathapp/nestjs-auth';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtAuthProvider } from './jwt-auth.provider';
import { KodaJwtRefreshStrategyProvider } from './koda-jwt-refresh-strategy.provider';
import { CombinedAuthGuard } from './guards/combined-auth.guard';
import { AgentAuthProvider } from './agent-auth.provider';
import { KodaCaslAbilityFactory } from './casl/koda-casl-ability.factory';
import { AuthRepositoryModule } from './auth-repository.module';

type JwtFromRequestFunction = (req: unknown) => string | null;

const KODA_TOKEN_COOKIE = 'koda_token';
const KODA_REFRESH_COOKIE = 'koda_refresh';

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * JWT extractor that accepts the token via either:
 *   - `Authorization: Bearer <token>` (programmatic callers, API key flow)
 *   - `koda_token` cookie (Nuxt SSR / browser session)
 *
 * The cookie path is what makes server-side httpOnly cookie storage
 * possible (WEB-02): the web app's Nuxt server sets the cookie and the
 * browser forwards it on every request, so JS never sees the raw token.
 */
const kodaTokenExtractor: JwtFromRequestFunction = (req: unknown): string | null => {
  const request = req as {
    headers?: Record<string, string | string[] | undefined>;
    cookies?: Record<string, string | undefined>;
  };

  const authHeaderValue = request.headers?.['authorization'];
  const authHeader = Array.isArray(authHeaderValue) ? authHeaderValue[0] : authHeaderValue;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (rawKey) return rawKey;
  }

  const fromCookies = request.cookies?.[KODA_TOKEN_COOKIE];
  if (typeof fromCookies === 'string' && fromCookies.length > 0) return fromCookies;

  const cookieHeader = request.headers?.['cookie'];
  const cookieHeaderValue = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (typeof cookieHeaderValue === 'string') {
    const cookies = parseCookies(cookieHeaderValue);
    if (cookies[KODA_TOKEN_COOKIE]) return cookies[KODA_TOKEN_COOKIE];
  }

  return null;
};

/**
 * Refresh-token extractor — same dual-source shape but uses the refresh cookie.
 */
const kodaRefreshExtractor: JwtFromRequestFunction = (req: unknown): string | null => {
  const request = req as {
    headers?: Record<string, string | string[] | undefined>;
    cookies?: Record<string, string | undefined>;
  };

  const authHeaderValue = request.headers?.['authorization'];
  const authHeader = Array.isArray(authHeaderValue) ? authHeaderValue[0] : authHeaderValue;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const rawKey = authHeader.slice('Bearer '.length).trim();
    if (rawKey) return rawKey;
  }

  const fromCookies = request.cookies?.[KODA_REFRESH_COOKIE];
  if (typeof fromCookies === 'string' && fromCookies.length > 0) return fromCookies;

  const cookieHeader = request.headers?.['cookie'];
  const cookieHeaderValue = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (typeof cookieHeaderValue === 'string') {
    const cookies = parseCookies(cookieHeaderValue);
    if (cookies[KODA_REFRESH_COOKIE]) return cookies[KODA_REFRESH_COOKIE];
  }

  return null;
};

export { KODA_TOKEN_COOKIE, KODA_REFRESH_COOKIE };

@Module({
  imports: [
    AuthRepositoryModule,
    NathappAuthModule.forRootAsync({
      imports: [ConfigModule, AuthRepositoryModule],
      inject: [ConfigService],
      authProvider: { useClass: JwtAuthProvider },
      refreshStrategyProvider: { useClass: KodaJwtRefreshStrategyProvider },
      caslAbilityFactory: KodaCaslAbilityFactory,
      useFactory: (config: ConfigService) => {
        const authConfig = config.get<{
          jwtSecret: string;
          jwtExpiresIn: string;
          jwtRefreshSecret: string;
          jwtRefreshExpiresIn: string;
        }>('auth');
        return {
          jwtOptions: {
            secret: authConfig?.jwtSecret,
            signOption: {
              expiresIn: authConfig?.jwtExpiresIn ?? '15m',
            },
            jwtFromRequestFunction: kodaTokenExtractor,
          },
          refreshJwtOptions: {
            secret: authConfig?.jwtRefreshSecret,
            signOption: {
              expiresIn: authConfig?.jwtRefreshExpiresIn ?? '7d',
            },
            jwtFromRequestFunction: kodaRefreshExtractor,
          },
        };
      },
    }),
  ],
  providers: [
    AuthService,
    JwtAuthProvider,
    KodaJwtRefreshStrategyProvider,
    JwtStrategy,
    JwtRefreshStrategy,
    AgentAuthProvider,
    CombinedAuthGuard,
    KodaCaslAbilityFactory,
  ],
  controllers: [AuthController],
  exports: [AuthService, CombinedAuthGuard, AgentAuthProvider, KodaCaslAbilityFactory, KodaJwtRefreshStrategyProvider],
})
export class AuthModule {}
