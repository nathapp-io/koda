import { PERMISSION_CATALOG, PENDING_SURFACE_KEYS, type PermissionCatalogEntry } from '../catalog';
import type { RequiresMetadata } from '../requires.decorator';

export interface RouteDeclaration {
  /** `"<METHOD> /<controller path>/<handler path>"`, for violation messages. */
  route: string;
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
  | { kind: 'pending-key-declared'; source: string; key: string };

/** Returns every permission declaration contract violation. */
export function findContractViolations(
  declarations: PermissionDeclarations,
  catalog: readonly PermissionCatalogEntry[] = PERMISSION_CATALOG,
  pending: ReadonlySet<string> = PENDING_SURFACE_KEYS,
): ContractViolation[] {
  const catalogKeys = new Set(catalog.map(({ key }) => key));
  const declaredKeys = new Set<string>();
  const violations: ContractViolation[] = [];

  const record = (source: string, key: string): void => {
    declaredKeys.add(key);
    if (!catalogKeys.has(key)) violations.push({ kind: 'unknown-key', source, key });
    if (pending.has(key)) violations.push({ kind: 'pending-key-declared', source, key });
  };

  for (const route of declarations.routes) {
    if (route.requires === undefined) {
      violations.push({ kind: 'route-without-key', route: route.route });
      continue;
    }

    if (route.requires.enforcedBy === 'guard' && !route.hasRequiresGuard) {
      violations.push({ kind: 'guard-missing', route: route.route });
    }
    for (const key of route.requires.keys) record(route.route, key);
  }

  for (const tool of declarations.tools) record(tool.tool, tool.key);
  for (const writer of declarations.systemWriters) record(writer.writer, writer.key);

  for (const { key } of catalog) {
    if (!declaredKeys.has(key) && !pending.has(key)) violations.push({ kind: 'unused-key', key });
  }

  return violations;
}
