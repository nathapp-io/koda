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
 * without escaping (no quotes, no control characters). Shared by
 * LanceTableManager.addRecord and VectorStore's source-qualified reads and
 * deletes.
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
 * The DataFusion predicate naming exactly one knowledge row: its source *and* its source_id (US-006).
 *
 * A KB row is identified by the pair, never by `source_id` alone, so a write to `('manual', 's1')` can no longer
 * replace the ticket row that happens to share the id. Callers must have checked both values with
 * `isSafeFilterValue` before embedding them here.
 */
export function sourceRowFilter(source: string, sourceId: string): string {
  return `source = '${source}' AND source_id = '${sourceId}'`;
}

/** One parsed `field = 'value'` / `field != 'value'` clause of a DataFusion predicate. */
interface FilterClause {
  field: string;
  negate: boolean;
  value: string;
}

/** One `field = 'value'` / `field != 'value'` clause at the start of a predicate. */
const FILTER_CLAUSE = /^([A-Za-z_][A-Za-z0-9_]*)\s*(!=|=)\s*'([^']*)'/;

/** The `AND` between two clauses; a value's own `AND` is inside its quotes and never read as one. */
const FILTER_CONJUNCTION = /^AND(?:\s+|$)/i;

/**
 * Parses an AND-joined list of `field = 'value'` / `field != 'value'` clauses, the only predicate shapes the RAG
 * services build. `null` means "not a predicate this fallback understands".
 *
 * The scan reads one clause at a time and then one conjunction, so a quoted value is opaque: `source = 'doc' AND
 * source_id = 'research AND development'` is two clauses, not three (branch fix B2). Splitting the whole predicate on
 * whitespace-delimited `AND` cut that value in half, and the unparseable tail silently left the row in place — a
 * re-index added a duplicate and a delete answered success while retaining the document.
 */
function parseFilterClauses(filter: string): FilterClause[] | null {
  const clauses: FilterClause[] = [];
  let rest = filter.trim();
  while (rest.length > 0) {
    const clause = FILTER_CLAUSE.exec(rest);
    if (!clause) return null;
    clauses.push({ field: clause[1], negate: clause[2] === '!=', value: clause[3] });
    rest = rest.slice(clause[0].length).trim();
    if (rest.length === 0) break;
    const conjunction = FILTER_CONJUNCTION.exec(rest);
    // A trailing `AND`, or any other operator, is not a predicate this fallback understands.
    if (!conjunction) return null;
    rest = rest.slice(conjunction[0].length).trim();
    if (rest.length === 0) return null;
  }
  return clauses.length > 0 ? clauses : null;
}

function matchesClauses(record: LanceRecord, clauses: FilterClause[]): boolean {
  return clauses.every((clause) => {
    const actual = (record as unknown as Record<string, unknown>)[clause.field];
    const equal = String(actual) === clause.value;
    return clause.negate ? !equal : equal;
  });
}

/**
 * 1c-c-D4: repository knowledge chunks carry `source = 'repo'` in the shared
 * `project_<projectId>` table. Only the knowledge search path may retrieve them
 * (1c-c-R6); every pre-existing retrieval leg excludes them before its
 * candidate limit, so a passing indexer cannot crowd ticket results out.
 */
export const REPO_SOURCE = 'repo';

/**
 * S5b 3c-2-D6: run-outcome knowledge chunks carry `source = 'outcome'` in the same shared table, with the
 * `source_id` namespace `outcome:<repoId>:<jobId>:<kind>`. `KnowledgeRepoIndexer` writes them and the knowledge
 * read path (`KnowledgeChunkStore.hasOutcomeRows`, the outcome leg of `KnowledgeSearchService`) selects them.
 */
export const OUTCOME_SOURCE = 'outcome';

/**
 * The sources that belong to the knowledge search path of the shared `project_<projectId>` table (1c-c-R6,
 * 3c-2-D6). Ticket, KB and graph retrieval must never return a row of one of these: an indexed corpus — or a
 * project's run outcomes — can otherwise fill a bounded candidate pool and crowd the tickets out of it.
 */
export const KNOWLEDGE_ROW_SOURCES: readonly string[] = [REPO_SOURCE, OUTCOME_SOURCE];

/**
 * DataFusion predicate matching every row that is not a knowledge chunk (1c-c-R6, 3c-2-D6). Both sources are
 * excluded in the query itself, *before* the leg's candidate limit, so the limit is spent on real hits.
 */
export const EXCLUDE_KNOWLEDGE_ROWS_PREDICATE = KNOWLEDGE_ROW_SOURCES
  .map((source) => `source != '${source}'`)
  .join(' AND ');

/**
 * True when a record belongs to the knowledge search path. The defensive filter every legacy retrieval leg
 * applies to the rows a leg returned anyway — the in-memory fallback table has no `where`, so the predicate
 * above is not the only guard.
 */
export function isKnowledgeRow(record: { source: string }): boolean {
  return KNOWLEDGE_ROW_SOURCES.includes(record.source);
}

/**
 * Applies `where(predicate)` to a LanceDB query builder (`table.query()`,
 * `table.search()`, `table.vectorSearch()`). The in-memory fallback table
 * (`InMemoryTable`) and test doubles expose no `where`, and can never hold
 * repository rows, so an unsupported filter is skipped rather than failing the
 * query.
 */
export function whereIfSupported<T>(query: T, predicate: string): T {
  const builder = query as { where?: (predicate: string) => unknown };
  return typeof builder?.where === 'function' ? (builder.where(predicate) as T) : query;
}

/**
 * In-memory fallback table used when the LanceDB native module is unavailable
 * (or RAG runs with inMemoryOnly=true). Implements the subset of the LanceDB
 * table API the RAG services rely on, including the exact source-and-id delete
 * and `where` filtering VectorStore needs so replacement, deletion and creator
 * reads mean the same thing here as in native LanceDB.
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
    // Covers both the single-field patterns (`source_id = '…'`, `source = '…'`) and the compound
    // `source = '…' AND source_id = '…'` predicate the KB write path uses. `source != '…'` is not a delete
    // shape today, but the parser is shared so it deletes nothing rather than widening.
    const clauses = parseFilterClauses(filter);
    if (clauses) {
      if (clauses.every((clause) => !clause.negate)) {
        this.records = this.records.filter((record) => !matchesClauses(record, clauses));
      }
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

  /**
   * Query builder with the `where(predicate)` + `limit(n)` + `toArray()` shape the services use. An
   * unsupported predicate is skipped (the record set is not narrowed), matching `whereIfSupported`; callers
   * that need exactness filter the returned rows themselves.
   */
  query() {
    const predicates: FilterClause[][] = [];
    let limit = Number.POSITIVE_INFINITY;

    const rows = (): LanceRecord[] => this.records
      .filter((record) => predicates.every((clauses) => matchesClauses(record, clauses)))
      .slice(0, limit);

    const builder = {
      where: (predicate: string) => {
        const clauses = parseFilterClauses(predicate);
        if (clauses) predicates.push(clauses);
        return builder;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      limit: (n: any) => {
        limit = typeof n === 'number' ? n : limit;
        return builder;
      },
      toArray: async () => rows(),
    };

    return builder;
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
  private readonly blockedWrites = new Set<string>();

  /** Unresolved durable undo receipts fence every writer until recovery succeeds. */
  blockWrites(tableName: string, blocked: boolean): void {
    if (blocked) this.blockedWrites.add(tableName);
    else this.blockedWrites.delete(tableName);
  }

  async exclusive<T>(tableName: string, fn: () => Promise<T>, options?: { recovery: true; additionRecovery?: true }): Promise<T> {
    const previous = this.writeLocks.get(tableName) ?? Promise.resolve();
    const guarded = () => {
      if (this.blockedWrites.has(tableName) && !options?.additionRecovery) throw new Error('KB table has an unresolved addition receipt');
      return fn();
    };
    const run = previous.then(guarded, guarded);
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
   * Idempotent record write under the per-table write mutex: replaces the row with the same `(source, source_id)`
   * before adding (US-006), so re-indexing a document — through either service, or the same service twice — yields
   * exactly one row for that pair instead of duplicating search results, while a row of a different source that
   * happens to share the id is left untouched.
   *
   * The caller resolves the table (via getOrCreateTable) so first-access hooks stay at the service boundary;
   * records with a filter-unsafe source or source_id are appended without the replace step.
   */
  async addRecord(tableName: string, table: LanceTable, record: LanceRecord): Promise<void> {
    await this.exclusive(tableName, async () => {
      if (isSafeFilterValue(record.source) && isSafeFilterValue(record.source_id)) {
        await table.delete(sourceRowFilter(record.source, record.source_id));
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
