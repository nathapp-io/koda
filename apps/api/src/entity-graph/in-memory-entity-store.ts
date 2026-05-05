import { EntityNodeType, EntityRecord, IEntityStore } from './dto/entity-graph.types';

interface LinkRecord {
  targetId: string;
  relation: string;
  metadata: Record<string, unknown>;
}

interface LinkByTargetRecord {
  sourceId: string;
  relation: string;
  metadata: Record<string, unknown>;
}

export class InMemoryEntityStore implements IEntityStore {
  private nodes: Map<string, EntityRecord> = new Map();
  private linksBySource: Map<string, LinkRecord[]> = new Map();
  private linksByTarget: Map<string, LinkByTargetRecord[]> = new Map();

  async findNodeByEntityId(projectId: string, entityId: string): Promise<EntityRecord | null> {
    return this.nodes.get(`${projectId}:${entityId}`) ?? null;
  }

  async findNodesByType(projectId: string, entityType: EntityNodeType): Promise<EntityRecord[]> {
    return Array.from(this.nodes.values()).filter(
      (n) => n.entityId.startsWith(`${projectId}:`) && n.entityType === entityType,
    );
  }

  async findLinksBySource(projectId: string, sourceId: string): Promise<LinkRecord[]> {
    return this.linksBySource.get(`${projectId}:${sourceId}`) ?? [];
  }

  async upsertNode(
    projectId: string,
    entityId: string,
    entityType: EntityNodeType,
    label: string,
    metadata?: Record<string, unknown>,
  ): Promise<EntityRecord> {
    const record: EntityRecord = { entityId, entityType, label, metadata: metadata ?? {} };
    this.nodes.set(`${projectId}:${entityId}`, record);
    return record;
  }

  async upsertLink(
    projectId: string,
    sourceId: string,
    targetId: string,
    relation: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const sourceKey = `${projectId}:${sourceId}`;
    const targetKey = `${projectId}:${targetId}`;

    const existingSource = this.linksBySource.get(sourceKey) ?? [];
    const idx = existingSource.findIndex((l) => l.targetId === targetId && l.relation === relation);
    if (idx >= 0) {
      existingSource[idx] = { targetId, relation, metadata: metadata ?? {} };
    } else {
      existingSource.push({ targetId, relation, metadata: metadata ?? {} });
    }
    this.linksBySource.set(sourceKey, existingSource);

    const existingTarget = this.linksByTarget.get(targetKey) ?? [];
    const idxTarget = existingTarget.findIndex((l) => l.sourceId === sourceId && l.relation === relation);
    if (idxTarget >= 0) {
      existingTarget[idxTarget] = { sourceId, relation, metadata: metadata ?? {} };
    } else {
      existingTarget.push({ sourceId, relation, metadata: metadata ?? {} });
    }
    this.linksByTarget.set(targetKey, existingTarget);
  }

  async deleteLinksBySource(projectId: string, sourceId: string): Promise<void> {
    const sourceKey = `${projectId}:${sourceId}`;
    const links = this.linksBySource.get(sourceKey) ?? [];

    for (const link of links) {
      const targetKey = `${projectId}:${link.targetId}`;
      const targetLinks = this.linksByTarget.get(targetKey) ?? [];
      const filtered = targetLinks.filter((l) => l.sourceId !== sourceId);
      if (filtered.length === 0) {
        this.linksByTarget.delete(targetKey);
      } else {
        this.linksByTarget.set(targetKey, filtered);
      }
    }
    this.linksBySource.delete(sourceKey);
  }

  async findLinksByTarget(projectId: string, targetId: string): Promise<LinkByTargetRecord[]> {
    return this.linksByTarget.get(`${projectId}:${targetId}`) ?? [];
  }

  clear(): void {
    this.nodes.clear();
    this.linksBySource.clear();
    this.linksByTarget.clear();
  }
}