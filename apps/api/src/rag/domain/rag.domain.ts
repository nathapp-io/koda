import type { GraphDiffWrite } from '../prisma-rag.repository';

export const RAG_REPOSITORY = Symbol('RAG_REPOSITORY');

export interface RagProjectRecord {
  id: string;
  graphifyEnabled: boolean;
  deletedAt: Date | null;
}

export interface IRagRepository {
  findProjectGraphifyEnabled(projectId: string): Promise<{ graphifyEnabled: boolean } | null>;
  findProjectById(projectId: string): Promise<{ id: string; deletedAt: Date | null } | null>;
  findAllActiveProjectIds(): Promise<{ id: string }[]>;
  getStoredGraphNodes(projectId: string): Promise<
    { nodeId: string; label: string; type: string | null; sourceFile: string | null; community: number | null }[]
  >;
  getStoredGraphLinks(projectId: string): Promise<
    { sourceId: string; targetId: string; relation: string | null }[]
  >;
  applyGraphDiff(projectId: string, diff: GraphDiffWrite): Promise<void>;
  markGraphNodesVectorStale(projectId: string, nodeIds: string[]): Promise<void>;
  findVectorStaleNodeIds(projectId: string): Promise<string[]>;
  clearGraphNodeVectorStale(projectId: string, nodeId: string): Promise<void>;
}
