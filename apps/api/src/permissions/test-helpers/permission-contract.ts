import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import type { ModulesContainer } from '@nestjs/core';
import { AssistantToolRegistry } from '../../fleet/assistant/assistant-tool.registry';
import { APPROVAL_GATED_METADATA } from '../../approvals/route/approval-gated.decorator';
import { PENDING_GATE_ROUTES, SECRET_GATE_ROUTES, type PendingGateFeature } from '../pending-gate-routes';
import { PERMISSION_CATALOG, PENDING_SURFACE_KEYS, type PermissionCatalogEntry } from '../catalog';
import { routeSurface } from '../route-surface';
import { REQUIRES_METADATA, type RequiresMetadata } from '../requires.decorator';
import { RequiresGuard } from '../requires.guard';
import { SYSTEM_WRITER_METADATA } from '../system-writer.decorator';

export interface RouteDeclaration {
  /** `"<METHOD> /<controller path>/<handler path>"`, for violation messages. */
  route: string;
  /** Upper-case Nest HTTP method. */
  method: string;
  /** Whether the handler carries `APPROVAL_GATED_METADATA`. */
  gated: boolean;
  /** Handler metadata, else class metadata, as RequiresGuard reads it. */
  requires: RequiresMetadata | undefined;
  /** Whether RequiresGuard is among the class's or the handler's `@UseGuards`. */
  hasRequiresGuard: boolean;
}

export interface ToolDeclaration {
  tool: string;
  key: string;
}

export interface SystemWriterDeclaration {
  writer: string;
  key: string;
}

export interface PermissionDeclarations {
  routes: readonly RouteDeclaration[];
  tools: readonly ToolDeclaration[];
  systemWriters: readonly SystemWriterDeclaration[];
}

export type ContractViolation =
  | { kind: 'route-without-key'; route: string }
  | { kind: 'unknown-key'; source: string; key: string }
  | { kind: 'guard-missing'; route: string }
  | { kind: 'unused-key'; key: string }
  | { kind: 'pending-key-declared'; source: string; key: string }
  | { kind: 'ungated-approvable-write'; route: string }
  | { kind: 'gated-without-approvable-key'; route: string }
  | { kind: 'stale-pending-gate-route'; route: string };

/** The parts of Nest's `InstanceWrapper` the collector reads. */
interface ProviderWrapper {
  readonly metatype: unknown;
  readonly instance: unknown;
}

/** A system writer class and the catalog key it declares. */
interface SystemWriterMatch {
  clazz: Function;
  key: string;
}

/** `true` for the `RequiresGuard` class itself and for an instance of it. */
function isRequiresGuard(guard: unknown): boolean {
  if (guard === RequiresGuard) return true;
  return (
    typeof guard === 'object' &&
    guard !== null &&
    (guard as { constructor?: unknown }).constructor === RequiresGuard
  );
}

/**
 * One declaration per routed handler of a controller.
 *
 * The route label comes from `routeSurface`, the same function the request interceptor uses as its
 * audit scope's surface, so the two can never print different strings for one route.
 *
 * The Requires metadata is read exactly as `RequiresGuard` reads it: the handler's own metadata
 * first, the controller's second. The guard flag is true when `RequiresGuard` is among the
 * controller's or the handler's `@UseGuards`, because Nest applies both.
 */
function collectControllerRoutes(controller: Function): RouteDeclaration[] {
  const prototype = (controller as { prototype?: Record<string, unknown> }).prototype;
  if (!prototype) return [];

  const classGuards = Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined;
  const classRequires = Reflect.getMetadata(REQUIRES_METADATA, controller) as
    | RequiresMetadata
    | undefined;
  const routes: RouteDeclaration[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler = prototype[name];
    if (typeof handler !== 'function') continue;

    const route = routeSurface(controller, handler);
    if (route === undefined) continue;

    const handlerGuards = Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined;
    const handlerRequires = Reflect.getMetadata(REQUIRES_METADATA, handler) as
      | RequiresMetadata
      | undefined;
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;

    routes.push({
      route,
      method: RequestMethod[method] ?? 'UNKNOWN',
      gated: Reflect.getMetadata(APPROVAL_GATED_METADATA, handler) === true,
      requires: handlerRequires !== undefined ? handlerRequires : classRequires,
      hasRequiresGuard: [...(classGuards ?? []), ...(handlerGuards ?? [])].some(isRequiresGuard),
    });
  }

  return routes;
}

/**
 * The system writer a provider wrapper declares, if any.
 *
 * The class is looked up on the wrapper's metatype first and on the initialized instance's
 * constructor second: a factory-built provider (the FTS optimize strategy) has no metatype of its
 * own, only the class its factory returned.
 */
function collectSystemWriter(wrapper: ProviderWrapper): SystemWriterMatch | undefined {
  const instance = wrapper.instance as { constructor?: unknown } | null | undefined;
  for (const candidate of [wrapper.metatype, instance?.constructor]) {
    if (typeof candidate !== 'function') continue;
    const key = Reflect.getMetadata(SYSTEM_WRITER_METADATA, candidate) as unknown;
    if (typeof key === 'string') return { clazz: candidate, key };
  }
  return undefined;
}

/**
 * Walks a booted Nest app's controllers and providers, and the tool registry, and reads back every
 * permission key they declare.
 *
 * A class reached through several wrappers (a `useExisting` alias, a re-export) is reported once:
 * the wrappers are deduplicated by class identity, not by key, because distinct classes may
 * legitimately declare the same key.
 */
export function collectPermissionDeclarations(
  modules: ModulesContainer,
  registry: AssistantToolRegistry,
): PermissionDeclarations {
  const routes: RouteDeclaration[] = [];
  const systemWriters: SystemWriterDeclaration[] = [];
  const seenControllers = new Set<Function>();
  const seenWriters = new Set<Function>();

  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const metatype = wrapper.metatype;
      if (typeof metatype !== 'function' || seenControllers.has(metatype)) continue;
      seenControllers.add(metatype);
      routes.push(...collectControllerRoutes(metatype));
    }

    for (const wrapper of module.providers.values()) {
      const writer = collectSystemWriter(wrapper);
      if (!writer || seenWriters.has(writer.clazz)) continue;
      seenWriters.add(writer.clazz);
      systemWriters.push({ writer: writer.clazz.name, key: writer.key });
    }
  }

  const tools = registry
    .list()
    .map((tool) => ({ tool: tool.descriptor.name, key: tool.key }));

  return { routes, tools, systemWriters };
}

/** Returns every permission declaration contract violation. */
export function findContractViolations(
  declarations: PermissionDeclarations,
  catalog: readonly PermissionCatalogEntry[] = PERMISSION_CATALOG,
  pending: ReadonlySet<string> = PENDING_SURFACE_KEYS,
  pendingGateRoutes: ReadonlyMap<string, string> = PENDING_GATE_ROUTES,
): ContractViolation[] {
  const catalogKeys = new Set(catalog.map(({ key }) => key));
  const catalogByKey = new Map(catalog.map((entry) => [entry.key, entry]));
  const declaredKeys = new Set<string>();
  const violations: ContractViolation[] = [];

  const record = (source: string, key: string): void => {
    declaredKeys.add(key);
    if (!catalogKeys.has(key)) violations.push({ kind: 'unknown-key', source, key });
    if (pending.has(key)) violations.push({ kind: 'pending-key-declared', source, key });
  };

  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
  const declarationsBySurface = new Map(declarations.routes.map((route) => [route.route, route]));

  for (const route of declarations.routes) {
    const requiredKeys = route.requires?.keys ?? [];
    const approvableKeys = requiredKeys.filter((key) => catalogByKey.get(key)?.approval?.approvable === true);
    const approvableWrite = writeMethods.has(route.method) && approvableKeys.length > 0;

    if (route.gated && approvableKeys.length === 0) {
      violations.push({ kind: 'gated-without-approvable-key', route: route.route });
    }
    if (approvableWrite && !route.gated && !pendingGateRoutes.has(route.route)) {
      violations.push({ kind: 'ungated-approvable-write', route: route.route });
    }

    if (route.requires === undefined) {
      violations.push({ kind: 'route-without-key', route: route.route });
      continue;
    }

    if (route.requires.enforcedBy === 'guard' && !route.hasRequiresGuard) {
      violations.push({ kind: 'guard-missing', route: route.route });
    }
    for (const key of route.requires.keys) record(route.route, key);
  }

  for (const [surface] of pendingGateRoutes) {
    const route = declarationsBySurface.get(surface);
    const approvableWrite = route !== undefined && writeMethods.has(route.method) &&
      (route.requires?.keys ?? []).some((key) => catalogByKey.get(key)?.approval?.approvable === true);
    if (!approvableWrite || route?.gated) {
      violations.push({ kind: 'stale-pending-gate-route', route: surface });
    }
  }

  for (const tool of declarations.tools) record(tool.tool, tool.key);
  for (const writer of declarations.systemWriters) record(writer.writer, writer.key);

  for (const { key } of catalog) {
    if (!declaredKeys.has(key) && !pending.has(key)) violations.push({ kind: 'unused-key', key });
  }

  return violations;
}

/** Derives the rollout allowlist expected for every ungated approvable write declaration. */
export function expectedPendingGateRoutes(
  routes: readonly RouteDeclaration[],
  catalog: readonly PermissionCatalogEntry[] = PERMISSION_CATALOG,
): [string, string][] {
  const catalogByKey = new Map(catalog.map((entry) => [entry.key, entry]));
  const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

  return routes
    .filter((route) => writeMethods.has(route.method) && !route.gated)
    .flatMap((route) => {
      const approvableKeys = (route.requires?.keys ?? [])
        .filter((key) => catalogByKey.get(key)?.approval.approvable === true);
      if (approvableKeys.length === 0) return [];

      const feature = SECRET_GATE_ROUTES.has(route.route)
        ? 'gate-secret'
        : approvableKeys.some((key) => catalogByKey.get(key)?.approval.default !== 'none')
          ? 'gate-high'
          : approvableKeys.every((key) => /^(fleet|thread|testhook)\./.test(key))
            ? 'gate-fleet'
            : 'gate-core-domains';
      return [[route.route, feature] as [string, string]];
    })
    .sort(([left], [right]) => left.localeCompare(right));
}
