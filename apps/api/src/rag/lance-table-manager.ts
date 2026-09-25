import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { mkdirSync } from 'node:fs';
import { RAG_CFG, IRagConfig } from '../config/rag.config';
import { EmbeddingService } from './embedding.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type LanceTable = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LanceConnection = any;

/**
 * Default hook identity used by getOrCreateTable when the caller does not pass
 * an explicit `firstAccessKey`. Callers with distinct hooks on the same table
 * should pass their own stable per-process key.
 */
const DEFAULT_FIRST_ACCESS_KEY = 'default';

export interface LanceRecord {
  id: string;
  source: string;
  source_id: string;
  content: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vector: any;
  metadata: string;
  created_at: string;
  provider: string;
  model: string;
  _distance?: number;
}

/**
 * True when `value` can be embedded in a LanceDB single-quoted SQL filter
 * without escaping (no quotes, no control characters). Mirrors the validation
 * used by VectorStore.deleteBySource.
 */
export function isSafeFilterValue(value: string): boolean {
  if (!value) return false;
  if (value.includes("'")) return false;
  return ![...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

/**
 * In-memory fallback table used when the LanceDB native module is unavailable
 * (or RAG runs with inMemoryOnly=true). Implements the subset of the LanceDB
 * table API the RAG services rely on, including the delete-filter patterns
 * used by VectorStore's deletes.
 */
export class InMemoryTable {
  private records: LanceRecord[] = [];

  async add(records: LanceRecord[]): Promise<void> {
    this.records = [...this.records, ...records];
  }

  async countRows(): Promise<number> {
    return this.records.length;
  }

  async delete(filter: string): Promise<void> {
    const sourceIdFilter = /^source_id\s*=\s*'([^']+)'$/.exec(filter);
    if (sourceIdFilter) {
      const sourceId = sourceIdFilter[1];
      this.records = this.records.filter((record) => record.source_id !== sourceId);
      return;
    }

    const sourceFilter = /^source\s*=\s*'([a-zA-Z0-9_-]+)'$/.exec(filter);
    if (sourceFilter) {
      const source = sourceFilter[1];
      this.records = this.records.filter((record) => record.source !== source);
      return;
    }

    const idInFilter = /^id\s+IN\s+\((.+)\)$/.exec(filter);
    if (idInFilter) {
      const ids = idInFilter[1]
        .split(',')
        .map((part) => part.trim().replace(/^'|'$/g, ''));
      const idSet = new Set(ids);
      this.records = this.records.filter((record) => !idSet.has(record.id));
    }
  }

  vectorSearch() {
    return {
      distanceType: () => ({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        limit: (n: any) => ({ toArray: async () => this.records.slice(0, n) }),
      }),
    };
  }

  query() {
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      limit: (n: any) => ({ toArray: async () => this.records.slice(0, n) }),
    };
  }
}

/**
 * Single owner of the LanceDB connection, table open/create lifecycle, and the
 * per-table write mutex for the whole RagModule.
 *
 * Why this exists (finding H7 residual): VectorStore and HybridRetrieverService
 * each used to open their own `lancedb.connect(lancedbPath)` and keep their own
 * table caches and write locks, so the same `project_<id>` table was written by
 * two independent clients — duplicate rows from double indexing, a cross-service
 * first-write race on LanceDB's check-then-create path, and deletes that never
 * reached the other service's in-memory store. The manager unifies all of that:
 *
 * - exactly one `lancedb.connect` per manager instance (RagModule provides ONE
 *   shared instance for both services — see the factory in rag.module.ts);
 * - one per-table mutex (`exclusive`) serializing ALL writes (add/delete/
 *   optimize) against the same table, across both services;
 * - sentinel-row `createTable` fallback to define the schema before the table
 *   can be opened empty;
 * - FTS index creation on the `content` column when a table is created;
 * - InMemoryTable fallback mirroring the previous behavior when the LanceDB
 *   native module is unavailable.
 *
 * Both services delegate table open/create and all writes here and keep their
 * own read/search/scoring logic.
 */
@Injectable()
export class LanceTableManager {
  private readonly logger = new Logger(LanceTableManager.name);
  private db: LanceConnection = null;
  private readonly tableCache = new Map<string, LanceTable>();
  private readonly tableCreationLocks = new Map<string, Promise<LanceTable>>();
  private readonly writeLocks = new Map<string, Promise<unknown>>();
  /**
   * First-access hooks that already fired, keyed by hook identity (caller-supplied
   * stable string) → set of table names. A hook fires at most once per
   * (identity, table) per process; `evictTable` resets the marker for a table.
   */
  private readonly firstAccessFired = new Map<string, Set<string>>();
  private readonly TABLE_CACHE_MAX_SIZE = 50;
  private lanceAvailable = true;
  private readonly lancedbPath: string;
  private readonly inMemoryOnly: boolean;

  constructor(
    @Inject(RAG_CFG) ragConfig: IRagConfig,
    @Optional() private readonly embeddingService?: EmbeddingService,
  ) {
    this.lancedbPath = ragConfig.lancedbPath;
    this.inMemoryOnly = ragConfig.inMemoryOnly;

    if (this.inMemoryOnly) {
      this.lanceAvailable = false;
      this.logger.log('LanceTableManager is running in in-memory mode; LanceDB native module will not be loaded');
    }
  }

  /** Whether the native LanceDB path is usable (false in in-memory mode or after a failed connect). */
  get available(): boolean {
    return this.lanceAvailable;
  }

  /** Creates the LanceDB storage directory if needed (called from service onModuleInit). */
  ensureStorage(): void {
    if (this.inMemoryOnly) {
      return;
    }

    try {
      mkdirSync(this.lancedbPath, { recursive: true });
      this.logger.log(`LanceDB storage directory ensured: ${this.lancedbPath}`);
    } catch (err) {
      this.logger.warn(`Could not create LanceDB directory ${this.lancedbPath}: ${(err as Error).message}`);
    }
  }

  /** Closes the connection and clears all cached state. Idempotent. */
  async close(): Promise<void> {
    this.tableCache.clear();
    this.tableCreationLocks.clear();
    this.writeLocks.clear();
    this.firstAccessFired.clear();

    if (this.db && typeof this.db.close === 'function') {
      try {
        const closeResult = this.db.close();
        if (closeResult && typeof closeResult.then === 'function') {
          await closeResult;
        }
      } catch (err) {
        this.logger.warn(`Failed to close LanceDB connection: ${(err as Error).message}`);
      }
    }

    this.db = null;
  }

  private async connect(): Promise<LanceConnection | null> {
    if (this.inMemoryOnly) {
      return null;
    }

    if (!this.db) {
      try {
        const lancedb = await import('@lancedb/lancedb');
        const connectFn = (lancedb as unknown as { connect: (path: string) => Promise<LanceConnection> }).connect
          ?? (lancedb.default as unknown as { connect: (path: string) => Promise<LanceConnection> })?.connect;
        this.db = await connectFn(this.lancedbPath);
      } catch (err) {
        this.lanceAvailable = false;
        this.logger.warn(`LanceDB unavailable - ${(err as Error).message} - using in-memory fallback`);
        return null;
      }
    }
    return this.db;
  }

  /**
   * Gets or creates a LanceDB table by name (create-or-open).
   *
   * `opts.onFirstAccess` fires at most once per (firstAccessKey, tableName) per
   * process, deterministically — including when THIS call finds the table
   * already cached or already on disk because another caller (e.g. a hook-less
   * read path) touched it first. `opts.firstAccessKey` identifies the hook
   * owner so independent hooks on the same table each fire once; when omitted,
   * a single shared identity is used. `evictTable` resets the marker for a
   * table so the hook can fire again after a cache eviction.
   */
  async getOrCreateTable(
    tableName: string,
    opts?: {
      onFirstAccess?: (table: LanceTable) => Promise<void> | void;
      firstAccessKey?: string;
    },
  ): Promise<LanceTable> {
    const cached = this.tableCache.get(tableName);
    if (cached) {
      if (opts?.onFirstAccess) {
        await this.runFirstAccessHook(
          opts.firstAccessKey ?? DEFAULT_FIRST_ACCESS_KEY,
          tableName,
          cached,
          opts.onFirstAccess,
        );
      }
      return cached;
    }

    // Serialize table open/create per table: concurrent callers for the same
    // tableName await the same in-flight creation instead of racing LanceDB's
    // check-then-create against each other (within this manager; sharing one
    // manager across services also serializes it cross-service).
    const inFlight = this.tableCreationLocks.get(tableName);
    let table: LanceTable;
    if (inFlight) {
      table = await inFlight;
    } else {
      const creation = this.createOrOpenTable(tableName).finally(() => {
        this.tableCreationLocks.delete(tableName);
      });
      this.tableCreationLocks.set(tableName, creation);
      table = await creation;
    }

    if (opts?.onFirstAccess) {
      await this.runFirstAccessHook(
        opts.firstAccessKey ?? DEFAULT_FIRST_ACCESS_KEY,
        tableName,
        table,
        opts.onFirstAccess,
      );
    }

    return table;
  }

  /**
   * Fires a first-access hook exactly once per (identity, tableName) per
   * process. The check-and-mark is synchronous, so concurrent callers of
   * getOrCreateTable cannot double-fire; the hook runs only while the native
   * LanceDB path is available (the in-memory fallback has nothing to optimize).
   */
  private async runFirstAccessHook(
    identity: string,
    tableName: string,
    table: LanceTable,
    hook: (table: LanceTable) => Promise<void> | void,
  ): Promise<void> {
    if (!this.lanceAvailable) {
      return;
    }

    let fired = this.firstAccessFired.get(identity);
    if (!fired) {
      fired = new Set();
      this.firstAccessFired.set(identity, fired);
    }
    if (fired.has(tableName)) {
      return;
    }
    fired.add(tableName);

    await hook(table);
  }

  private async createOrOpenTable(tableName: string): Promise<LanceTable> {
    const cached = this.tableCache.get(tableName);
    if (cached) return cached;

    const db = await this.connect();
    if (!this.lanceAvailable || !db) {
      const memTable = new InMemoryTable();
      this.tableCache.set(tableName, memTable);
      this.evictTableCacheIfNeeded();
      return memTable;
    }

    const tableNames: string[] = await db.tableNames();

    let table: LanceTable;
    if (tableNames.includes(tableName)) {
      table = await db.openTable(tableName);
    } else {
      const provider = this.embeddingService?.providerName ?? 'ollama';
      const model = this.embeddingService?.modelName ?? 'nomic-embed-text';
      const dims = this.embeddingService?.dimensions ?? 768;

      // Create table with a sentinel record to define schema, then delete it
      const sentinel: LanceRecord = {
        id: '__schema_sentinel__',
        source: 'manual',
        source_id: '__sentinel__',
        content: '',
        vector: Array(dims).fill(0) as number[],
        metadata: '{}',
        created_at: new Date().toISOString(),
        provider,
        model,
      };
      table = await db.createTable(tableName, [sentinel]);
      await table.delete("id = '__schema_sentinel__'");
    }

    // Create FTS index on content column when LanceDB is available
    try {
      const IndexModule = (await import('@lancedb/lancedb')).Index;
      await table.createIndex('content', {
        config: IndexModule.fts(),
        replace: false,
      });
    } catch (err) {
      this.logger.warn(`FTS index creation failed for table ${tableName}: ${(err as Error).message}`);
    }

    this.tableCache.set(tableName, table);
    this.evictTableCacheIfNeeded();

    return table;
  }

  /**
   * Serializes `fn` (a LanceDB write: add/delete/optimize) per table across ALL
   * services sharing this manager. LanceDB has no built-in mutex for concurrent
   * writers against the same table, so without this, interleaved writes can
   * race each other and corrupt table state.
   */
  async exclusive<T>(tableName: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.writeLocks.get(tableName) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tracked = run.catch(() => undefined);
    this.writeLocks.set(tableName, tracked);
    // Once this write settles, drop the entry if no later write has queued
    // behind it, so the map only holds currently in-flight/queued chains
    // instead of growing forever with one entry per project ever written to.
    tracked.finally(() => {
      if (this.writeLocks.get(tableName) === tracked) {
        this.writeLocks.delete(tableName);
      }
    });
    return run;
  }

  /**
   * Idempotent record write under the per-table write mutex: replaces any
   * existing rows with the same source_id before adding, so re-indexing a
   * document (through either service, or the same service twice) yields
   * exactly one row per sourceId instead of duplicating search results.
   *
   * The caller resolves the table (via getOrCreateTable) so first-access hooks
   * stay at the service boundary; records with filter-unsafe source_id values
   * are appended without the replace step.
   */
  async addRecord(tableName: string, table: LanceTable, record: LanceRecord): Promise<void> {
    await this.exclusive(tableName, async () => {
      if (isSafeFilterValue(record.source_id)) {
        await table.delete(`source_id = '${record.source_id}'`);
      }
      await table.add([record]);
    });
  }

  /**
   * Opens a table that already exists in the native LanceDB store, or returns
   * null when LanceDB is unavailable or the table does not exist. Read-only
   * helper for provider/model validation — does not populate the table cache.
   */
  async openTableIfLance(tableName: string): Promise<LanceTable | null> {
    const db = await this.connect();
    if (!this.lanceAvailable || !db) {
      return null;
    }

    const tableNames: string[] = await db.tableNames();
    if (!tableNames.includes(tableName)) {
      return null;
    }

    return db.openTable(tableName);
  }

  /** Drops the cached table handle and resets first-access hook markers for one table. */
  evictTable(tableName: string): void {
    this.tableCache.delete(tableName);
    for (const fired of this.firstAccessFired.values()) {
      fired.delete(tableName);
    }
  }

  private evictTableCacheIfNeeded(): void {
    if (this.tableCache.size > this.TABLE_CACHE_MAX_SIZE) {
      const firstKey = this.tableCache.keys().next().value;
      if (firstKey !== undefined) {
        this.tableCache.delete(firstKey);
      }
    }
  }
}
