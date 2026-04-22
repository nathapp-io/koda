/**
 * WriteResult DTO
 *
 * Represents the result of a write operation through KodaDomainWriter.
 * Includes provenance information for audit trails and error handling for partial failures.
 */

/**
 * Provenance information for tracking the source and context of a write operation.
 */
export interface Provenance {
  /** ID of the actor performing the operation (user or agent) */
  actorId: string;
  /** ID of the project being written to */
  projectId: string;
  /** The action being performed (e.g., CREATED, INDEXED, IMPORTED) */
  action: string;
  /** Timestamp when the operation occurred */
  timestamp: Date;
  /** Source of the operation (e.g., 'api', 'internal', 'webhook') */
  source: 'api' | 'internal' | 'webhook';
}

/**
 * Result of a write operation.
 * Includes canonical ID for the primary record and optional derived IDs for related records.
 */
export interface WriteResult {
  /** ID of the canonical record created/updated */
  canonicalId?: string;

  /** IDs of derived records (e.g., from RAG indexing) */
  derivedIds?: string[];

  /** Error message if the operation partially failed */
  error?: string;

  /** Metadata about the operation (e.g., import counts) */
  metadata?: Record<string, unknown>;

  /** Provenance information for audit trails */
  provenance: Provenance;
}

/**
 * Input data for writing a ticket event.
 */
export interface WriteTicketEventInput {
  /** ID of the ticket */
  ticketId: string;
  /** ID of the project */
  projectId: string;
  /** Action performed on the ticket */
  action: string;
  /** ID of the actor (user or agent) performing the action */
  actorId: string;
  /** Type of actor: 'user' or 'agent' */
  actorType: 'user' | 'agent';
  /** Source of the write operation */
  source: 'api' | 'internal' | 'webhook';
  /** Additional event data */
  data: Record<string, unknown>;
}

/**
 * Input data for writing an agent action event.
 */
export interface WriteAgentActionInput {
  /** ID of the agent */
  agentId: string;
  /** ID of the project */
  projectId: string;
  /** Action performed by the agent */
  action: string;
  /** ID of the actor (usually the agent itself) */
  actorId: string;
  /** Source of the write operation */
  source: 'api' | 'internal' | 'webhook';
  /** Additional event data */
  data: Record<string, unknown>;
}

/**
 * Input data for indexing a document in the knowledge base.
 */
export interface IndexDocumentInput {
  /** ID of the project */
  projectId: string;
  /** Source type of the document */
  source: 'ticket' | 'doc' | 'manual' | 'code';
  /** ID of the source entity */
  sourceId: string;
  /** Content to index */
  content: string;
  /** Metadata about the document */
  metadata: Record<string, unknown>;
  /** ID of the actor performing the operation */
  actorId: string;
  /** Timestamp of the operation */
  timestamp: Date;
}

/**
 * Input data for importing Graphify knowledge base.
 */
export interface ImportGraphifyInput {
  /** ID of the project */
  projectId: string;
  /** Graph nodes to import */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodes: any[];
  /** Graph links to import */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  links: any[];
  /** ID of the actor performing the import */
  actorId: string;
  /** Timestamp of the import */
  timestamp: Date;
}
