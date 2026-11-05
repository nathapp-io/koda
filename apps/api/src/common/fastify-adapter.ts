import { FastifyAdapter } from '@nestjs/platform-fastify';

/**
 * thread-agents-modes US-008 (F1): the longest path parameter the API accepts.
 *
 * Fastify's default is 100, and it answers 414 `FST_ERR_MAX_PARAM_LENGTH` for anything longer before the route runs.
 * The approval request id the pending list stores and the decision routes take is bounded at 128
 * (`THREAD_REQUEST_ID_MAX`), so with the default every pending approval whose id was 101..128 characters — the runner's
 * own request ids are opaque — was unanswerable. The limit sits just above the API's own bound so that an over-long id
 * is still the handler's 400 naming `requestId` instead of a transport refusal; `fastify-adapter.spec.ts` pins both
 * relations.
 */
export const MAX_PATH_PARAM_LENGTH = 256;

/**
 * The Fastify adapter the API boots with, in production and in the HTTP test harness that opts into the production
 * adapter. A single factory keeps the parameter limit (and anything added here) identical in both.
 *
 * The limit goes through `routerOptions` — the shape Fastify 5 asks for — rather than the deprecated top-level
 * `maxParamLength`, which logs a `FSTDEP022` warning on every boot.
 */
export function createFastifyAdapter(): FastifyAdapter {
  return new FastifyAdapter({ routerOptions: { maxParamLength: MAX_PATH_PARAM_LENGTH } });
}
