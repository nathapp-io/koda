import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AUDIT_STORAGE, type IAuditStorage } from '@nathapp/nestjs-audit';
import { TRANSACTION_MANAGER, type ITransactionManager } from '@nathapp/nestjs-data';
import { currentContext, NO_APPROVAL } from '../action-context/action-context';
import { findCatalogEntry } from '../permissions/catalog';
import { AUDIT_SUMMARY_MAX, type KodaAuditMetadata } from './domain/audit-entry.domain';

export interface AuditRecordInput {
  key: string;
  resourceType: string;
  resourceId: string;
  projectId?: string | null;
  summary?: string;
}

export type AuditEntriesOf<T> = (result: T) => AuditRecordInput | readonly AuditRecordInput[];

@Injectable()
export class AuditRecorder {
  constructor(
    @Inject(AUDIT_STORAGE) private readonly storage: IAuditStorage,
    @Inject(TRANSACTION_MANAGER) private readonly txManager: ITransactionManager,
  ) {}

  /**
   * Runs `fn` in one transaction and records the entries its result describes, in that transaction.
   * For a write that owns no transaction of its own; a method that already runs `txManager.run`
   * calls `record` inside that callback instead.
   */
  async audited<T>(fn: () => Promise<T>, entriesOf: AuditEntriesOf<T>): Promise<T> {
    return this.txManager.run(async () => {
      const result = await fn();
      const entries = entriesOf(result);
      for (const entry of Array.isArray(entries) ? entries : [entries]) await this.record(entry);
      return result;
    });
  }

  /** Call inside the domain write's txManager.run, so the entry commits or rolls back with it. */
  async record(input: AuditRecordInput): Promise<void> {
    if (findCatalogEntry(input.key) === undefined) {
      throw new Error(`unknown audit key: ${input.key}`);
    }
    if (!this.txManager.isInTransaction()) {
      throw new Error('AuditRecorder.record must run inside a transaction');
    }

    const context = currentContext();
    const actor = context?.actor ?? { type: 'SYSTEM' as const, id: 'unknown' };
    const metadata: KodaAuditMetadata = {
      projectId: input.projectId ?? null,
      onBehalfOf: context?.onBehalfOf ?? null,
      origin: context?.origin ?? 'system',
      approval: context?.approval ?? NO_APPROVAL,
      summary: input.summary === undefined ? null : input.summary.slice(0, AUDIT_SUMMARY_MAX),
    };

    await this.storage.record({
      action: input.key,
      actor: { id: actor.id, type: actor.type },
      resource: input.resourceType,
      resourceId: input.resourceId,
      correlationId: context?.correlationId ?? randomUUID(),
      timestamp: new Date(),
      metadata: { ...metadata },
    });
  }
}
