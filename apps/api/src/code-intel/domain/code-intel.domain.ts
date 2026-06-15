export const CODE_INTEL_REPOSITORY = Symbol('CODE_INTEL_REPOSITORY');

export interface SymbolRow {
  id: string;
  symbolId: string;
  projectId: string;
  repoId: string;
  commitHash: string;
  name: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  callers: unknown;
  callees: unknown;
  docComment: string | null;
}

export interface GraphNodeRow {
  nodeId: string;
  label: string;
  sourceFile: string | null;
  community: number | null;
}

export interface EntityNodeRow {
  entityId: string;
  entityType: string;
  label: string;
  metadata: string;
}

export interface EntityLinkRow {
  sourceId: string;
  targetId: string;
  relation: string;
}

export interface ICodeIntelRepository {
  findSymbolsByFiles(projectId: string, files: string[]): Promise<SymbolRow[]>;
  findGraphNodesByType(projectId: string, type: string): Promise<GraphNodeRow[]>;
  findEntityNodesByIds(projectId: string, entityIds: string[]): Promise<EntityNodeRow[]>;
  findEntityLinksByTargetIds(projectId: string, targetIds: string[], relation: string): Promise<EntityLinkRow[]>;
  findEntityNodesByIdsAndType(projectId: string, entityIds: string[], entityType: string): Promise<EntityNodeRow[]>;
  countSymbols(projectId: string): Promise<number>;
  countEntityNodesByTypes(projectId: string, entityTypes: string[]): Promise<number>;
  countEntityNodesByType(projectId: string, entityType: string): Promise<number>;
}
