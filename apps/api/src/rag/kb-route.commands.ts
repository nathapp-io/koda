import { RagService } from './rag.service';
import { AuditRecorder } from '../audit/audit-recorder.service';
import { ImportGraphifyDto } from './dto/import-graphify.dto';
import { KbDocumentAddition } from './kb-document-addition.service';
import { AddDocumentDto } from './dto/add-document.dto';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { parseBody } from '../approvals/route/parse-body';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { DeleteKbDocumentQuery, type KbDeleteSource } from './dto/delete-kb-document.query';
import { KbDocumentDeletion } from './kb-document-deletion.service';

export const KB_ROUTE_VARIANTS = {
  delete: 'rest:kb-documents.delete', add: 'rest:kb-documents.add',
  graphifyImport: 'rest:kb.graphify-import', optimize: 'rest:kb.optimize',
} as const;
interface KbDeleteInput { projectId: string; sourceId: string; source?: KbDeleteSource }

@Injectable()
export class KbRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly deletion: KbDocumentDeletion,
    private readonly loader: ActorPrincipalLoader,
    private readonly addition: KbDocumentAddition,
    private readonly ragService: RagService,
    private readonly audit: AuditRecorder,
  ) {}

  onModuleInit(): void {
    // Keep the stores' own recovery boundaries outside approval's execution transaction.
    // Only the audit and result settlement belong in the prepared callback.
    const prepareGraphify = async (input: { projectId: string; graph: ImportGraphifyDto }) => {
      const result = await this.ragService.importGraphify(input.projectId, input.graph.nodes, input.graph.links ?? []);
      return () => this.audit.audited(async () => result, () => ({
        key: 'kb.graphify.import', resourceType: 'project', resourceId: input.projectId,
        projectId: input.projectId, summary: `imported ${result.imported} nodes, cleared ${result.cleared}`,
      }));
    };
    this.commands.register(routeCommand({
      key: 'kb.graphify.import', variant: KB_ROUTE_VARIANTS.graphifyImport,
      parse: input => {
        const ids = parseRouteInput(input, ['slug', 'projectId']);
        const graph = parseBody(ImportGraphifyDto, (input as Record<string, unknown>).graph ?? {});
        return { ...ids, graph };
      },
      prepare: (_principal, input) => prepareGraphify(input),
      run: async (_principal, input) => (await prepareGraphify(input))(),
      toResult: result => result,
    }, this.loader));
    const prepareOptimize = async (input: { projectId: string }) => {
      await this.ragService.optimizeTable(input.projectId);
      return () => this.audit.audited(async () => ({ optimized: true }), () => ({
        key: 'kb.optimize', resourceType: 'project', resourceId: input.projectId,
        projectId: input.projectId, summary: 'kb table optimized',
      }));
    };
    this.commands.register(routeCommand({
      key: 'kb.optimize', variant: KB_ROUTE_VARIANTS.optimize,
      parse: input => parseRouteInput(input, ['slug', 'projectId']),
      prepare: (_principal, input) => prepareOptimize(input),
      run: async (_principal, input) => (await prepareOptimize(input))(),
      toResult: result => result,
    }, this.loader));
    this.commands.register(routeCommand({
      key: 'kb.document.add', variant: KB_ROUTE_VARIANTS.add,
      parse: input => {
        const ids = parseRouteInput(input, ['slug', 'projectId']);
        const document = parseBody(AddDocumentDto, (input as Record<string, unknown>).document ?? {});
        return { ...ids, document };
      },
      run: (principal, input) => this.addition.add(principal, input.projectId, input.document),
      prepare: (principal, input) => this.addition.prepare(principal, input.projectId, input.document),
      withExecution: (input, transaction) => this.addition.withExecution(input.projectId, transaction),
      toResult: result => result,
    }, this.loader));
    this.commands.register(routeCommand<KbDeleteInput, { deleted: boolean }>({
      key: 'kb.document.delete', variant: KB_ROUTE_VARIANTS.delete,
      withExecution: (input, transaction) => this.deletion.withExecution(input.projectId, transaction),
      parse: input => {
        const ids = parseRouteInput(input, ['projectId', 'sourceId']);
        const query = parseBody(DeleteKbDocumentQuery, input);
        return { ...ids, ...query };
      },
      run: async (principal, input) => {
        await this.deletion.delete(principal, input.projectId, input.sourceId, input.source);
        return { deleted: true };
      },
      toResult: result => result,
    }, this.loader));
  }
}
