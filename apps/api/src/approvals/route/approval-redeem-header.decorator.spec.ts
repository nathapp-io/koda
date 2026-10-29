import type { ExecutionContext } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { APPROVAL_REDEEM_HEADER } from './approval-gated.decorator';
import { ApprovalRedeemHeader } from './approval-redeem-header.decorator';

/** A handler carrying the decorator, so the parameter factory can be read back off the metadata. */
class Probe {
  handler(@ApprovalRedeemHeader() _redeem?: string): void {}
}

/** The factory `createParamDecorator` stored for `Probe.handler`'s first parameter. */
function redeemFactory(): (data: unknown, context: ExecutionContext) => unknown {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler') as
    | Record<string, { factory: (data: unknown, context: ExecutionContext) => unknown }>
    | undefined;
  const entry = Object.values(args ?? {})[0];
  if (!entry) throw new Error('the decorator stored no parameter metadata');
  return entry.factory;
}

/** A minimal `ExecutionContext` over the given request headers. */
const context = (headers: Record<string, string | string[] | undefined>) => ({
  switchToHttp: () => ({ getRequest: () => ({ headers }) }),
}) as unknown as ExecutionContext;

describe('ApprovalRedeemHeader', () => {
  it('US-007: reads the redemption request id from the request headers', () => {
    expect(redeemFactory()(undefined, context({ [APPROVAL_REDEEM_HEADER]: 'r1' }))).toBe('r1');
  });

  it('US-007: answers undefined when the caller sends no header', () => {
    expect(redeemFactory()(undefined, context({}))).toBeUndefined();
  });

  it('US-007: takes the first value when the header arrives more than once', () => {
    expect(redeemFactory()(undefined, context({ [APPROVAL_REDEEM_HEADER]: ['r1', 'r2'] }))).toBe('r1');
  });

  /**
   * US-007 (fix round 1): the decorator is invisible to `@nestjs/swagger`, unlike `@Headers(name)`,
   * which reflects the parameter into the contract as a required header. A route that documents it
   * through `@ApprovalGated({ redeem: true })` must not end up with two header parameters.
   */
  it('US-007: stores no parameter type the swagger explorer would document', () => {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, Probe, 'handler') as Record<string, unknown>;

    expect(Object.keys(args)).toHaveLength(1);
    // A `@Headers(name)` parameter is keyed `<RouteParamtypes.HEADERS>:<index>`; a custom decorator's
    // key carries `__customRouteArgs__` under a random prefix, which the explorer maps to a placeholder
    // and then drops.
    expect(Object.keys(args)[0]).toContain('__customRouteArgs__');
  });
});
