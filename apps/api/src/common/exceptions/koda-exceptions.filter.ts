import { ArgumentsHost, Catch, Injectable, Logger, Optional } from '@nestjs/common';
import type { ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import {
  AppException,
  GlobalExceptionsFilter,
  I18nWrapper,
  JsonResponse,
  resolveRequestLanguage,
} from '@nathapp/nestjs-common';

/**
 * Koda's error envelope for `@nathapp` AppExceptions.
 *
 * The library filter replies `{ ret, message }`. Koda's clients also need the
 * machine-readable refusal: which i18n key refused and with which interpolation
 * args. The CLI and the web read `message`, while a client that has to react to a
 * specific refusal (the 409 `projectAgents.hasOpenTickets` with the agent's open
 * ticket count and refs, or the 409 `members.userDisabled`) reads `data.key` and
 * `data.args` instead of parsing prose.
 *
 * `NathApplication.useAppGlobalFilters()` resolves the `GlobalExceptionsFilter`
 * token from DI and only falls back to its own instance when nothing is
 * registered there, so `AppModule` providing this class under that token is what
 * installs it. Exceptions the library derives a status for (no explicit
 * `httpStatus`) and everything that is not an AppException keep going through a
 * stock filter.
 */
@Catch()
@Injectable()
export class KodaExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(KodaExceptionsFilter.name);
  private readonly fallback: GlobalExceptionsFilter;

  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    @Optional() private readonly i18n?: I18nWrapper,
  ) {
    this.fallback = new GlobalExceptionsFilter(httpAdapterHost, i18n?.I18nService);
  }

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    if (!(exception instanceof AppException) || exception.httpStatus === undefined) {
      await this.fallback.catch(exception, host);
      return;
    }

    const key = `${exception.prefix ?? 'exception'}.${exception.code}`;
    const message = await this.translate(key, host, exception);
    const { httpStatus } = exception;

    if (httpStatus >= 500) {
      this.logger.error(`AppException: ret: ${exception.code} - ${message}`);
    } else {
      this.logger.warn(`AppException: ret: ${exception.code} - ${message}`);
    }

    const payload = JsonResponse.Error(exception.code, message);
    payload.data = { key, args: exception.args ?? {} };

    this.httpAdapterHost.httpAdapter.reply(host.switchToHttp().getResponse(), payload, httpStatus);
  }

  /** Same lookup the library filter performs: `<prefix>.<code>` localized for the request. */
  private async translate(key: string, host: ArgumentsHost, exception: AppException): Promise<string> {
    if (!this.i18n) return key;
    const lang = resolveRequestLanguage(host.switchToHttp().getRequest());
    return this.i18n.translate(key, { lang, args: exception.args });
  }
}
