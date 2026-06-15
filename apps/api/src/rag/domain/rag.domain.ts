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
  upsertNodesInBatches(
    projectId: string,
    nodes: Array<{
      nodeId: string;
      label: string;
      type?: string;
      sourceFile?: string;
      community?: number;
    }>,
    links: Array<{ sourceId: string; targetId: string; relation?: string }>,
    nodeIds: string[],
    batchSize: number,
  ): Promise<void>;
  deleteGraphNodeLinks(
    projectId: string,
    conditions: { sourceId: string; targetId: string }[],
  ): Promise<void>;
  deleteGraphNodesByIds(projectId: string, nodeIds: string[]): Promise<void>;
  deleteGraphLinksByNodeIds(projectId: string, nodeIds: string[]): Promise<void>;
}
