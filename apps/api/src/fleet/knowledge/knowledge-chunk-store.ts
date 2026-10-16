import { Injectable } from '@nestjs/common';
import { isSafeFilterValue, LanceRecord, LanceTable, LanceTableManager } from '../../rag/lance-table-manager';

const MAX_FILE_ROWS = 2_000;

export class KnowledgeStoreUnavailableError extends Error {
  constructor() {
    super('knowledge store unavailable: LanceDB is not available');
    this.name = 'KnowledgeStoreUnavailableError';
  }
}

export class KnowledgeInvalidPathError extends Error {
  constructor(sourceId: string) {
    super(`knowledge source id is not a safe filter value: ${JSON.stringify(sourceId)}`);
    this.name = 'KnowledgeInvalidPathError';
  }
}

/** Metadata JSON of a repository chunk row (1c-c-D4). */
export interface KnowledgeChunkMetadata {
  repoId: string;
  owner: string;
  name: string;
  path: string;
  sha: string;
  blobSha: string;
  title: string;
  headingPath: string;
  anchor: string;
  chunkIndex: number;
  chunkCount: number;
  abstract: string;
  text: string;
  status?: string;
  supersededBy?: string;
}

export interface KnowledgeChunkRow extends KnowledgeChunkMetadata {
  id: string;
  sourceId: string;
  provider: string;
}

const tableName = (projectId: string): string => `project_${projectId}`;

function parseRow(record: LanceRecord): KnowledgeChunkRow {
  const metadata = JSON.parse(record.metadata) as KnowledgeChunkMetadata;
  return { ...metadata, id: record.id, sourceId: record.source_id, provider: record.provider };
}

/** Repository chunks in the shared `project_<projectId>` LanceDB table (1c-c-D5). */
@Injectable()
export class KnowledgeChunkStore {
  constructor(private readonly manager: LanceTableManager) {}

  /** Deletes the file's rows, then adds all of `rows` in one call, under the table's write mutex. */
  async replaceFile(projectId: string, sourceId: string, rows: LanceRecord[]): Promise<void> {
    this.assertReady(sourceId);
    for (const row of rows) {
      if (row.source_id !== sourceId) throw new KnowledgeInvalidPathError(row.source_id);
    }
    const table = await this.table(projectId);
    await this.manager.exclusive(tableName(projectId), async () => {
      await table.delete(`source_id = '${sourceId}'`);
      if (rows.length > 0) await table.add(rows);
    });
  }

  async deleteFile(projectId: string, sourceId: string): Promise<void> {
    this.assertReady(sourceId);
    const table = await this.table(projectId);
    await this.manager.exclusive(tableName(projectId), () => table.delete(`source_id = '${sourceId}'`));
  }

  /** The file's rows (at most 2000) in `chunkIndex` order. */
  async readFile(projectId: string, sourceId: string): Promise<KnowledgeChunkRow[]> {
    this.assertReady(sourceId);
    const table = await this.table(projectId);
    const records: LanceRecord[] = await table.query().where(`source_id = '${sourceId}'`).limit(MAX_FILE_ROWS).toArray();
    return records.map(parseRow).sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  async lexical(projectId: string, query: string, predicate: string, limit: number): Promise<KnowledgeChunkRow[]> {
    this.assertAvailable();
    const table = await this.table(projectId);
    try {
      return await this.fullTextQuery(table, query, predicate, limit);
    } catch {
      // LanceDB drops a table's full-text index as soon as a row is deleted, and every `replaceFile` deletes the
      // file's rows first — so a project's index is gone after a pass, and `optimize` does not restore it. Rebuild
      // it once and retry (a second failure propagates), so the lexical leg still answers after the indexer wrote.
      await this.rebuildFullTextIndex(projectId, table);
      return this.fullTextQuery(table, query, predicate, limit);
    }
  }

  async vector(projectId: string, embedding: number[], predicate: string, limit: number): Promise<KnowledgeChunkRow[]> {
    this.assertAvailable();
    const table = await this.table(projectId);
    const records: LanceRecord[] = await table.vectorSearch(embedding).distanceType('cosine').where(predicate).limit(limit).toArray();
    return records.map(parseRow);
  }

  private assertAvailable(): void {
    if (!this.manager.available) throw new KnowledgeStoreUnavailableError();
  }

  private async fullTextQuery(table: LanceTable, query: string, predicate: string, limit: number): Promise<KnowledgeChunkRow[]> {
    const records: LanceRecord[] = await table.query().fullTextSearch(query, { columns: 'content' }).where(predicate).limit(limit).toArray();
    return records.map(parseRow);
  }

  /** Rebuilds the `content` FTS index under the table's write mutex, replacing the index LanceDB dropped. */
  private async rebuildFullTextIndex(projectId: string, table: LanceTable): Promise<void> {
    const { Index } = await import('@lancedb/lancedb');
    await this.manager.exclusive(tableName(projectId), () => table.createIndex('content', { config: Index.fts(), replace: true }));
  }

  private assertReady(sourceId: string): void {
    this.assertAvailable();
    if (!isSafeFilterValue(sourceId)) throw new KnowledgeInvalidPathError(sourceId);
  }

  private table(projectId: string): Promise<LanceTable> {
    return this.manager.getOrCreateTable(tableName(projectId));
  }
}
