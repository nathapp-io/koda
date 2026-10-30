import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { APPROVAL_REDEEM_HEADER } from './approval-gated.decorator';

/** The parts of the HTTP request a redemption header read needs. */
interface RedeemHeaderRequest {
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * US-007: the redemption header as a handler parameter — `@ApprovalRedeemHeader() redeem?: string`.
 *
 * `@Headers(APPROVAL_REDEEM_HEADER)` reads the same value, but Nest's swagger integration reflects that
 * parameter into the exported contract as a *required* header parameter, on top of the optional
 * `X-Koda-Approval-Request` that `@ApprovalGated({ redeem: true })` documents. A redeeming caller must
 * send the header and every other caller must not, so the documented parameter has to be the optional
 * one and only one. A custom parameter decorator stores `__customRouteArgs__` metadata, which the
 * explorer maps to no parameter type and drops — the same reason `@Principal()` never shows up.
 *
 * Absent answers `undefined`. An empty value passes through untouched: `ApprovalRouteGate.run` takes the
 * redeem branch only for a non-empty value, so an empty header is an ordinary call.
 */
export const ApprovalRedeemHeader = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context.switchToHttp().getRequest<RedeemHeaderRequest>();
    const value = request.headers?.[APPROVAL_REDEEM_HEADER];
    // A repeated header arrives as several values; the first one names the request.
    return Array.isArray(value) ? value[0] : value;
  },
);
