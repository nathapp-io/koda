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

export const KB_ROUTE_VARIANTS = { delete: 'rest:kb-documents.delete', add: 'rest:kb-documents.add' } as const;
interface KbDeleteInput { projectId: string; sourceId: string; source?: KbDeleteSource }

@Injectable()
export class KbRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly deletion: KbDocumentDeletion,
    private readonly loader: ActorPrincipalLoader,
    private readonly addition: KbDocumentAddition,
  ) {}

  onModuleInit(): void {
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
