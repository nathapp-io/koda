import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

/**
 * Permissions P2l US-010 — the one place that turns Nest's route metadata into a label.
 *
 * Two readers share it: the permission contract walker (`collectControllerRoutes`) prints the label
 * in a violation message, and `ActionContextInterceptor` uses it as the audit scope's surface, which
 * `UNAUDITED_SURFACES` matches by the same string. A second implementation would let the two drift
 * apart and silence a route's coverage check, so `joinRoutePath` and `methodName` live here only.
 *
 * The shape is `<METHOD> /<controller path>/<handler path>`. A controller whose `@Controller` path is
 * an array is not supported, as it is not in the walker: none exists.
 */

/** The controller path and the handler path, joined without duplicated separators. */
function joinRoutePath(...parts: readonly (string | undefined)[]): string {
  const segments = parts
    .map((part) => (part ?? '').trim())
    .map((part) => part.replace(/^\/+/, '').replace(/\/+$/, ''))
    .filter((part) => part.length > 0);
  return segments.length > 0 ? `/${segments.join('/')}` : '/';
}

/** `GET`, `POST`, ... for Nest's `RequestMethod` value. */
function methodName(method: RequestMethod): string {
  return RequestMethod[method] ?? 'UNKNOWN';
}

/**
 * The label of the route a controller method is wired to, or undefined for a method with no route
 * decorator.
 *
 * `handler` must be the method as Nest sees it — the prototype function (`Controller.prototype.name`)
 * or the same function read off an instance — because that is where the decorators set their
 * metadata. Nest's `ExecutionContext.getHandler()` returns exactly that reference.
 */
export function routeSurface(controller: Function, handler: Function): string | undefined {
  const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
  if (method === undefined) return undefined;

  const classPath = Reflect.getMetadata(PATH_METADATA, controller) as string | undefined;
  const handlerPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;

  return `${methodName(method)} ${joinRoutePath(classPath, handlerPath)}`;
}
